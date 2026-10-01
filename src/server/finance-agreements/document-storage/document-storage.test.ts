import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NO network: googleapis is mocked for the whole file. The only tests that let the (mocked) Drive client run
// stub NODE_ENV / VITEST off first, precisely so the live-Drive guard - which is proven separately WITHOUT
// that stub - is what stands between a test and Google.

type MockFile = { id: string; parents: string[]; name: string; appProperties: Record<string, string>; bytes: Buffer; createdTime: string; trashed: boolean };

const drive = vi.hoisted(() => {
  const state = {
    files: [] as MockFile[],
    calls: { list: 0, create: 0, get: 0, update: 0, authConstructed: 0 },
    listError: null as unknown,
    createError: null as unknown,
    raceOnCreate: false,
    clock: 0,
    keyFiles: [] as string[],
  };
  return state;
});

vi.mock("googleapis", () => {
  const nextTime = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++drive.clock)).toISOString();
  const link = (id: string) => `https://drive.google.com/file/d/${id}/view`;
  return {
    google: {
      auth: {
        GoogleAuth: class {
          constructor(options: { keyFile?: string }) {
            drive.calls.authConstructed++;
            drive.keyFiles.push(String(options.keyFile));
          }
        },
      },
      drive: () => ({
        files: {
          async list(params: { q: string }) {
            drive.calls.list++;
            if (drive.listError) throw drive.listError;
            const parent = /'([^']+)' in parents/.exec(params.q)?.[1];
            const value = /value='([0-9a-f]+)'/.exec(params.q)?.[1];
            const matches = drive.files.filter((file) => !file.trashed && file.parents.includes(parent!) && Object.values(file.appProperties).includes(value!) && file.appProperties.CreatorOpsAgreementDocKey === value);
            return { data: { files: matches.map((file) => ({ id: file.id, webViewLink: link(file.id), createdTime: file.createdTime })) } };
          },
          async create(params: { requestBody: { name: string; parents: string[]; appProperties: Record<string, string> }; media: { body: AsyncIterable<Buffer> } }) {
            drive.calls.create++;
            if (drive.createError) throw drive.createError;
            const chunks: Buffer[] = [];
            for await (const chunk of params.media.body) chunks.push(Buffer.from(chunk));
            if (drive.raceOnCreate) {
              // A concurrent request created the same keyed file just BEFORE this one.
              drive.files.push({ id: "drive_racer", parents: params.requestBody.parents, name: params.requestBody.name, appProperties: params.requestBody.appProperties, bytes: Buffer.concat(chunks), createdTime: nextTime(), trashed: false });
              drive.raceOnCreate = false;
            }
            const id = `drive_file_${drive.files.length + 1}`;
            drive.files.push({ id, parents: params.requestBody.parents, name: params.requestBody.name, appProperties: params.requestBody.appProperties, bytes: Buffer.concat(chunks), createdTime: nextTime(), trashed: false });
            return { data: { id, webViewLink: link(id) } };
          },
          async get(params: { fileId: string }) {
            drive.calls.get++;
            return { data: { id: params.fileId, webViewLink: link(params.fileId) } };
          },
          async update(params: { fileId: string; requestBody: { trashed?: boolean } }) {
            drive.calls.update++;
            const file = drive.files.find((candidate) => candidate.id === params.fileId);
            if (file && params.requestBody.trashed) file.trashed = true;
            return {};
          },
        },
      }),
    },
  };
});

import { agreementDocumentIdempotencyKey, buildAgreementDocumentFileName } from "./file-name";
import { createInMemoryAgreementDocumentStorage, FAKE_DRIVE_LINK_HOST } from "./in-memory";
import { createGoogleDriveAgreementStorage, mapDriveError, AGREEMENT_DOCUMENT_KEY_PROPERTY } from "./google-drive";
import { getFinanceAgreementDriveEnv } from "@/lib/env/server";
import { getAgreementDocumentStorage, resolveAgreementDocumentStorageKind, setAgreementDocumentStorageForTests } from "./index";
import type { AgreementDocumentStoreInput } from "./types";

const PARTNERS_FOLDER = "partners_folder_id_0001";
const VENDORS_FOLDER = "vendors_folder_id_0002";
const CONFIG = { credentialsPath: "/secret/path/service-account.json", partnersFolderId: PARTNERS_FOLDER, vendorsFolderId: VENDORS_FOLDER };

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n original agreement bytes \u2713");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function input(overrides: Partial<AgreementDocumentStoreInput> = {}): AgreementDocumentStoreInput {
  const agreementRef = "agr_0123456789abcdef0123";
  return {
    idempotencyKey: agreementDocumentIdempotencyKey(agreementRef, 1, sha(PDF_BYTES)),
    bytes: PDF_BYTES,
    mimeType: "application/pdf",
    fileName: "Signed Agreement.pdf",
    target: "PARTNER",
    metadata: { agreementRef, version: 1, counterpartyType: "PARTNER", counterpartyRef: "p_1", artifactSha256: sha(PDF_BYTES) },
    ...overrides,
  };
}

function resetDrive() {
  drive.files.length = 0;
  drive.calls = { list: 0, create: 0, get: 0, update: 0, authConstructed: 0 };
  drive.listError = null;
  drive.createError = null;
  drive.raceOnCreate = false;
  drive.clock = 0;
  drive.keyFiles.length = 0;
}

afterEach(() => {
  vi.unstubAllEnvs();
  setAgreementDocumentStorageForTests(null);
});

describe("naming and keys", () => {
  it("the idempotency key is sha256(agreementRef|version|artifactSha256) and differs per version and per content", () => {
    const expected = createHash("sha256").update("agr_x|2|abc").digest("hex");
    expect(agreementDocumentIdempotencyKey("agr_x", 2, "abc")).toBe(expected);
    expect(agreementDocumentIdempotencyKey("agr_x", 1, "abc")).not.toBe(expected);
    expect(agreementDocumentIdempotencyKey("agr_x", 2, "abd")).not.toBe(expected);
  });

  it("the stored name is '<sanitized base> [<agreementRef> v<n>].pdf' with no path, control or reserved characters and a capped length", () => {
    expect(buildAgreementDocumentFileName("Acme Media Agreement.pdf", "agr_1", 2)).toBe("Acme Media Agreement [agr_1 v2].pdf");
    expect(buildAgreementDocumentFileName("../../etc/pass:wd\u0000<x>.PDF", "agr_1", 1)).toBe("pass wd x [agr_1 v1].pdf");
    expect(buildAgreementDocumentFileName("C:\\Users\\me\\deal.pdf", "agr_1", 1)).toBe("deal [agr_1 v1].pdf");
    expect(buildAgreementDocumentFileName("...", "agr_1", 1)).toBe("Agreement [agr_1 v1].pdf");
    expect(buildAgreementDocumentFileName("a".repeat(500) + ".pdf", "agr_1", 1).length).toBeLessThan(160);
  });
});

describe("the in-memory fake", () => {
  it("records the EXACT bytes and arguments it received, and links on the reserved .invalid host", async () => {
    const storage = createInMemoryAgreementDocumentStorage();
    const result = await storage.store(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.webViewLink).toBe(`${FAKE_DRIVE_LINK_HOST}${result.data.fileId}`);
    expect(result.data.webViewLink.startsWith("https://drive.invalid/fake/")).toBe(true);
    const [file] = storage.files;
    expect(file!.receivedSha256).toBe(sha(PDF_BYTES));
    expect(Buffer.from(file!.bytes).equals(Buffer.from(PDF_BYTES))).toBe(true);
    expect(file!.driveFileName).toBe("Signed Agreement [agr_0123456789abcdef0123 v1].pdf");
    expect(storage.calls).toHaveLength(1);
  });

  it("stores a private copy (mutating the caller's array afterwards cannot change what was 'stored')", async () => {
    const storage = createInMemoryAgreementDocumentStorage();
    const bytes = new Uint8Array(PDF_BYTES);
    await storage.store(input({ bytes }));
    bytes[10] = 0;
    expect(storage.files[0]!.receivedSha256).toBe(sha(PDF_BYTES));
    expect(sha(storage.files[0]!.bytes)).toBe(sha(PDF_BYTES));
  });

  it("is idempotent by key: a repeat returns the same file id and link and creates no second file; a new key is a new file", async () => {
    const storage = createInMemoryAgreementDocumentStorage();
    const first = await storage.store(input());
    const second = await storage.store(input());
    expect(second).toEqual(first);
    expect(storage.files).toHaveLength(1);
    expect(storage.calls.map((call) => call.outcome)).toEqual(["created", "existing"]);
    const v2 = await storage.store(input({ idempotencyKey: agreementDocumentIdempotencyKey("agr_0123456789abcdef0123", 2, sha(PDF_BYTES)) }));
    expect(v2.ok && first.ok && v2.data.fileId !== first.data.fileId).toBe(true);
    expect(storage.files).toHaveLength(2);
  });

  it("can be told to fail N times: nothing is stored while failing, then it succeeds", async () => {
    const storage = createInMemoryAgreementDocumentStorage();
    storage.failNext(2, "quota_exceeded");
    const a = await storage.store(input());
    const b = await storage.store(input());
    expect(a).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(b).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(storage.files).toHaveLength(0);
    expect((await storage.store(input())).ok).toBe(true);
    expect(storage.files).toHaveLength(1);
  });

  it("rejects a non-PDF, a bad key and non-PDF bytes", async () => {
    const storage = createInMemoryAgreementDocumentStorage();
    expect(await storage.store(input({ mimeType: "text/plain" as unknown as "application/pdf" }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await storage.store(input({ idempotencyKey: "nope" }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await storage.store(input({ bytes: new TextEncoder().encode("not a pdf at all") }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(storage.files).toHaveLength(0);
  });
});

describe("which storage a process uses (pure resolution + seam)", () => {
  // "configured" now means the FULL explicit opt-in: mode=real AND the shared external-services switch
  // AND credentials/folder - this is the remediation-plan Wave A shape (see finding #69). Nothing short
  // of all three ever selects real Drive.
  const configured = { credentialsPath: "/k.json", partnersFolderId: PARTNERS_FOLDER, vendorsFolderId: VENDORS_FOLDER, mode: "real", allowRealExternalServices: true } as const;

  it("credentials and folder ids being PRESENT is never enough on its own: without mode=real AND the external-services switch, the answer is FAKE (dev) or NOT_CONFIGURED (production) - never GOOGLE_DRIVE", () => {
    // this is the exact live gap the remediation plan's Wave A closes: a real .env.local carrying real
    // credentials/folder ids with no explicit opt-in must never resolve to real Drive.
    const presentButNotOptedIn = { credentialsPath: "/k.json", partnersFolderId: PARTNERS_FOLDER, vendorsFolderId: VENDORS_FOLDER, mode: undefined, allowRealExternalServices: false } as const;
    for (const nodeEnv of ["development", "test", undefined]) expect(resolveAgreementDocumentStorageKind({ env: presentButNotOptedIn, nodeEnv, testRun: false })).toBe("FAKE");
    expect(resolveAgreementDocumentStorageKind({ env: presentButNotOptedIn, nodeEnv: "production", testRun: false })).toEqual({ notConfigured: "drive_mode_not_enabled" });
  });

  it("mode=real WITHOUT the shared ALLOW_REAL_EXTERNAL_SERVICES switch never reaches Drive, even with full credentials/folder", () => {
    expect(resolveAgreementDocumentStorageKind({ env: { ...configured, allowRealExternalServices: false }, nodeEnv: "development", testRun: false })).toEqual({ notConfigured: "real_external_services_not_allowed" });
    expect(resolveAgreementDocumentStorageKind({ env: { ...configured, allowRealExternalServices: false }, nodeEnv: "production", testRun: false })).toEqual({ notConfigured: "real_external_services_not_allowed" });
  });

  it("the shared ALLOW_REAL_EXTERNAL_SERVICES switch WITHOUT mode=real never reaches Drive either - both gates are required", () => {
    expect(resolveAgreementDocumentStorageKind({ env: { ...configured, mode: undefined }, nodeEnv: "development", testRun: false })).toBe("FAKE");
    expect(resolveAgreementDocumentStorageKind({ env: { ...configured, mode: "fake" }, nodeEnv: "development", testRun: false })).toBe("FAKE");
  });

  it("FINANCE_AGREEMENT_DRIVE_MODE=fake selects the fake everywhere EXCEPT production (unchanged - it's just no longer needed to keep Drive off by default)", () => {
    for (const nodeEnv of ["development", "test", undefined]) expect(resolveAgreementDocumentStorageKind({ env: { ...configured, mode: "fake", allowRealExternalServices: false }, nodeEnv, testRun: false })).toBe("FAKE");
    // production with mode=fake still never gets the fake, but ALSO never silently gets real Drive - it's a truthful NOT_CONFIGURED
    expect(resolveAgreementDocumentStorageKind({ env: { ...configured, mode: "fake", allowRealExternalServices: false }, nodeEnv: "production", testRun: false })).toEqual({ notConfigured: "drive_mode_not_enabled" });
  });

  it("with BOTH explicit gates on: NOT_CONFIGURED without credentials or without any folder; real Drive only when both are present", () => {
    expect(resolveAgreementDocumentStorageKind({ env: { ...configured, credentialsPath: "  " }, nodeEnv: "development", testRun: false })).toEqual({ notConfigured: "missing_credentials" });
    expect(resolveAgreementDocumentStorageKind({ env: { ...configured, partnersFolderId: undefined, vendorsFolderId: undefined }, nodeEnv: "development", testRun: false })).toEqual({ notConfigured: "missing_folder" });
    expect(resolveAgreementDocumentStorageKind({ env: { ...configured, vendorsFolderId: undefined }, nodeEnv: "development", testRun: false })).toBe("GOOGLE_DRIVE");
    expect(resolveAgreementDocumentStorageKind({ env: configured, nodeEnv: "production", testRun: false })).toBe("GOOGLE_DRIVE");
  });

  it("an automated test run never resolves to real Drive, even with full configuration and both gates on", () => {
    expect(resolveAgreementDocumentStorageKind({ env: configured, nodeEnv: "test", testRun: true })).toEqual({ notConfigured: "live_drive_disabled_in_tests" });
  });

  it("setAgreementDocumentStorageForTests installs an adapter, forces NOT_CONFIGURED, and refuses to run outside a test run", () => {
    const fake = createInMemoryAgreementDocumentStorage();
    setAgreementDocumentStorageForTests(fake);
    expect(getAgreementDocumentStorage()).toMatchObject({ state: "CONFIGURED", mode: "TEST_OVERRIDE", storage: fake });
    setAgreementDocumentStorageForTests("NOT_CONFIGURED");
    expect(getAgreementDocumentStorage()).toEqual({ state: "NOT_CONFIGURED", reason: "test_override" });
    setAgreementDocumentStorageForTests(null);

    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    expect(() => setAgreementDocumentStorageForTests(fake)).toThrow(/test run/);
  });

  it("configuration comes only from the environment: blank counts as absent, and only the exact value 'real' opts into Drive (case-sensitive)", () => {
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "  ");
    vi.stubEnv("FINANCE_AGREEMENT_DRIVE_PARTNERS_FOLDER_ID", "");
    vi.stubEnv("FINANCE_AGREEMENT_DRIVE_VENDORS_FOLDER_ID", " vendors_folder_id_0002 ");
    vi.stubEnv("FINANCE_AGREEMENT_DRIVE_MODE", "REAL");
    vi.stubEnv("ALLOW_REAL_EXTERNAL_SERVICES", "TRUE");
    expect(getFinanceAgreementDriveEnv()).toEqual({ credentialsPath: undefined, partnersFolderId: undefined, vendorsFolderId: "vendors_folder_id_0002", mode: undefined, allowRealExternalServices: false });
    vi.stubEnv("FINANCE_AGREEMENT_DRIVE_MODE", "real");
    vi.stubEnv("ALLOW_REAL_EXTERNAL_SERVICES", "true");
    expect(getFinanceAgreementDriveEnv().mode).toBe("real");
    expect(getFinanceAgreementDriveEnv().allowRealExternalServices).toBe(true);
  });

  it("FINANCE_AGREEMENT_DRIVE_MODE=fake does NOT bypass the live-test-run guard: getAgreementDocumentStorage (this process's own isAutomatedTestRun() is true) still answers NOT_CONFIGURED without an explicit override - the PURE resolver (exercised above) is what proves the non-test-run default is FAKE", () => {
    vi.stubEnv("FINANCE_AGREEMENT_DRIVE_MODE", "fake");
    expect(getAgreementDocumentStorage()).toEqual({ state: "NOT_CONFIGURED", reason: "live_drive_disabled_in_tests" });
    // an explicit test override is the real way to get the fake inside a live test run (proven earlier in this file)
  });

  it("createInMemoryAgreementDocumentStorage() itself (the same adapter FAKE resolves to) records links on the .invalid host", async () => {
    const storage = createInMemoryAgreementDocumentStorage();
    const stored = await storage.store(input());
    expect(stored.ok && stored.data.webViewLink.startsWith("https://drive.invalid/fake/")).toBe(true);
  });

  it("production without an explicit real opt-in never silently uses the fake either - truthful NOT_CONFIGURED", () => {
    vi.stubEnv("FINANCE_AGREEMENT_DRIVE_MODE", "fake");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    expect(resolveAgreementDocumentStorageKind({ env: getFinanceAgreementDriveEnv(), nodeEnv: "production", testRun: false })).toEqual({ notConfigured: "drive_mode_not_enabled" });
  });

  it("with no override and no configuration in this test run, the answer is a truthful NOT_CONFIGURED (never a real adapter)", () => {
    const resolution = getAgreementDocumentStorage();
    expect(resolution.state === "NOT_CONFIGURED" || (resolution.state === "CONFIGURED" && resolution.mode === "FAKE")).toBe(true);
  });
});

describe("the real Google Drive adapter - LIVE-DRIVE GUARD (no env stubbing: this is a real test run)", () => {
  beforeEach(resetDrive);

  it("REFUSES to run under VITEST / NODE_ENV=test: nothing is authenticated, listed or created", async () => {
    expect(process.env.VITEST || process.env.NODE_ENV === "test").toBeTruthy();
    const storage = createGoogleDriveAgreementStorage(CONFIG);
    const result = await storage.store(input());
    expect(result).toMatchObject({ ok: false, code: "live_drive_disabled_in_tests" });
    expect(drive.calls).toEqual({ list: 0, create: 0, get: 0, update: 0, authConstructed: 0 });
    expect(drive.files).toHaveLength(0);
  });

  it("refuses when only NODE_ENV=test (VITEST unset) and when only VITEST is set", async () => {
    const storage = createGoogleDriveAgreementStorage(CONFIG);
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "test");
    expect(await storage.store(input())).toMatchObject({ ok: false, code: "live_drive_disabled_in_tests" });
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "true");
    expect(await storage.store(input())).toMatchObject({ ok: false, code: "live_drive_disabled_in_tests" });
    expect(drive.calls.list + drive.calls.create + drive.calls.authConstructed).toBe(0);
  });
});

describe("the real Google Drive adapter (mocked googleapis, guard stubbed off)", () => {
  beforeEach(() => {
    resetDrive();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
  });

  it("creates ONE file in the PARTNER folder with the exact bytes, the normalized name and the idempotency appProperty", async () => {
    const storage = createGoogleDriveAgreementStorage(CONFIG);
    const result = await storage.store(input());
    expect(result).toEqual({ ok: true, data: { fileId: "drive_file_1", webViewLink: "https://drive.google.com/file/d/drive_file_1/view" } });
    expect(drive.files).toHaveLength(1);
    const [file] = drive.files;
    expect(file!.parents).toEqual([PARTNERS_FOLDER]);
    expect(sha(file!.bytes)).toBe(sha(PDF_BYTES));
    expect(file!.bytes.equals(Buffer.from(PDF_BYTES))).toBe(true);
    expect(file!.name).toBe("Signed Agreement [agr_0123456789abcdef0123 v1].pdf");
    expect(file!.appProperties[AGREEMENT_DOCUMENT_KEY_PROPERTY]).toBe(input().idempotencyKey);
    expect(drive.keyFiles).toEqual([CONFIG.credentialsPath]);
  });

  it("selects the folder by counterparty type: VENDOR -> the Vendors folder", async () => {
    const storage = createGoogleDriveAgreementStorage(CONFIG);
    await storage.store(input({ target: "VENDOR", metadata: { ...input().metadata, counterpartyType: "VENDOR" } }));
    expect(drive.files[0]!.parents).toEqual([VENDORS_FOLDER]);
  });

  it("is IDEMPOTENT: re-storing the same key lists first and returns the SAME id and link with no second create", async () => {
    const storage = createGoogleDriveAgreementStorage(CONFIG);
    const first = await storage.store(input());
    const again = await createGoogleDriveAgreementStorage(CONFIG).store(input()); // a fresh adapter (a new process) too
    expect(again).toEqual(first);
    expect(drive.calls.create).toBe(1);
    expect(drive.files).toHaveLength(1);
  });

  it("a different Agreement version is a different key and a different file (v1 is never overwritten)", async () => {
    const storage = createGoogleDriveAgreementStorage(CONFIG);
    const v1 = await storage.store(input());
    const v2 = await storage.store(input({ idempotencyKey: agreementDocumentIdempotencyKey("agr_0123456789abcdef0123", 2, sha(PDF_BYTES)), metadata: { ...input().metadata, version: 2 } }));
    expect(v1.ok && v2.ok && v1.data.fileId !== v2.data.fileId).toBe(true);
    expect(drive.files.map((file) => file.name)).toEqual(["Signed Agreement [agr_0123456789abcdef0123 v1].pdf", "Signed Agreement [agr_0123456789abcdef0123 v2].pdf"]);
  });

  it("a concurrent create that raced this one leaves everyone agreeing on the EARLIEST file; the duplicate is trashed, not deleted", async () => {
    drive.raceOnCreate = true;
    const storage = createGoogleDriveAgreementStorage(CONFIG);
    const result = await storage.store(input());
    expect(result).toMatchObject({ ok: true, data: { fileId: "drive_racer" } });
    expect(drive.files.filter((file) => !file.trashed).map((file) => file.id)).toEqual(["drive_racer"]);
    expect(drive.calls.update).toBe(1);
  });

  it("NOT_CONFIGURED: no credentials path, or no folder for this counterparty type - and no Drive call is made", async () => {
    expect(await createGoogleDriveAgreementStorage({ ...CONFIG, credentialsPath: " " }).store(input())).toMatchObject({ ok: false, code: "not_configured", message: "Drive storage not configured" });
    expect(await createGoogleDriveAgreementStorage({ ...CONFIG, vendorsFolderId: undefined }).store(input({ target: "VENDOR" }))).toMatchObject({ ok: false, code: "not_configured" });
    // an unsafe folder id (would break out of the query) is treated as not configured
    expect(await createGoogleDriveAgreementStorage({ ...CONFIG, partnersFolderId: "x' or name contains 'a" }).store(input())).toMatchObject({ ok: false, code: "not_configured" });
    expect(drive.calls.list + drive.calls.create).toBe(0);
  });

  it("validates before calling Drive: MIME, key shape and PDF bytes", async () => {
    const storage = createGoogleDriveAgreementStorage(CONFIG);
    expect(await storage.store(input({ mimeType: "image/png" as unknown as "application/pdf" }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await storage.store(input({ idempotencyKey: "z".repeat(64) }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await storage.store(input({ bytes: new TextEncoder().encode("plain text") }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(drive.calls.list + drive.calls.create).toBe(0);
  });

  it("maps errors to a code and a FIXED message - no key path, folder id or upstream text ever leaks", async () => {
    const storage = createGoogleDriveAgreementStorage(CONFIG);
    const upstream = Object.assign(new Error("Error reading /secret/path/service-account.json for folder partners_folder_id_0001"), { code: 403 });
    drive.listError = upstream;
    const denied = await storage.store(input());
    expect(denied).toMatchObject({ ok: false, code: "access_denied" });
    expect(JSON.stringify(denied)).not.toMatch(/secret|service-account|partners_folder_id/);

    drive.listError = Object.assign(new Error("boom"), { response: { status: 404 } });
    expect(await storage.store(input())).toMatchObject({ ok: false, code: "folder_not_found" });
    drive.listError = null;
    drive.createError = Object.assign(new Error("quota"), { errors: [{ reason: "storageQuotaExceeded" }] });
    expect(await storage.store(input())).toMatchObject({ ok: false, code: "quota_exceeded" });
    drive.createError = Object.assign(new Error("down"), { code: 503 });
    expect(await storage.store(input())).toMatchObject({ ok: false, code: "drive_unavailable" });
    drive.createError = new Error("who knows");
    expect(await storage.store(input())).toMatchObject({ ok: false, code: "unknown" });
    // a failed attempt leaves nothing behind, and the next attempt succeeds cleanly
    expect(drive.files).toHaveLength(0);
    drive.createError = null;
    expect((await storage.store(input())).ok).toBe(true);
    expect(drive.files).toHaveLength(1);
  });

  it("mapDriveError covers network codes", () => {
    expect(mapDriveError({ code: "ETIMEDOUT" })).toBe("drive_unavailable");
    expect(mapDriveError({ response: { status: 429 } })).toBe("quota_exceeded");
    expect(mapDriveError(null)).toBe("unknown");
  });
});

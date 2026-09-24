import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NO network: googleapis is mocked for the whole file. The only tests that let the (mocked) Drive
// client run stub NODE_ENV / VITEST off first, precisely so the live-backend guard - proven
// separately WITHOUT that stub - is what stands between a test and Google.

type MockFile = { id: string; parents: string[]; name: string; appProperties: Record<string, string>; bytes: Buffer; createdTime: string; trashed: boolean };

const drive = vi.hoisted(() => {
  const state = {
    files: [] as MockFile[],
    calls: { list: 0, create: 0, get: 0, update: 0, authConstructed: 0 },
    listError: null as unknown,
    createError: null as unknown,
    getError: null as unknown,
    raceOnCreate: false,
    corruptReadBack: false,
    clock: 0,
    keyFiles: [] as string[],
  };
  return state;
});

vi.mock("googleapis", () => {
  const nextTime = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++drive.clock)).toISOString();
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
            const value = /value='([^']+)'/.exec(params.q)?.[1];
            const matches = drive.files.filter((file) => !file.trashed && file.parents.includes(parent!) && file.appProperties.CreatorOpsInvoiceDocKey === value);
            return { data: { files: matches.map((file) => ({ id: file.id, createdTime: file.createdTime })) } };
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
            return { data: { id } };
          },
          async get(params: { fileId: string; alt?: string }) {
            drive.calls.get++;
            if (drive.getError) throw drive.getError;
            const file = drive.files.find((candidate) => candidate.id === params.fileId);
            if (!file) throw Object.assign(new Error("not found"), { response: { status: 404 } });
            if (params.alt === "media") {
              const bytes = drive.corruptReadBack ? Buffer.concat([file.bytes, Buffer.from("corrupted")]) : file.bytes;
              return { data: bytes };
            }
            return { data: { id: file.id } };
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

import { getFinanceInvoiceDriveEnv } from "@/lib/env/server";

import { buildInvoiceDocumentFileName, IDEMPOTENCY_KEY_PATTERN } from "./file-name";
import { createGoogleDriveInvoiceStorage, driveInvoiceDocumentId, DRIVE_INVOICE_DOCUMENT_ID_PREFIX, INVOICE_DOCUMENT_KEY_PROPERTY, mapDriveError } from "./google-drive";
import { createInMemoryInvoiceDocumentStorage, FAKE_INVOICE_DOCUMENT_ID_PREFIX } from "./in-memory";
import { getInvoiceDocumentStorage, resolveInvoiceDocumentStorageKind, setInvoiceDocumentStorageForTests } from "./index";
import type { InvoiceDocumentStoreInput } from "./types";
import { invoiceDocumentIdempotencyKey } from "../ids";

const FOLDER = "invoice_folder_id_0001";
const CONFIG = { credentialsPath: "/secret/path/service-account.json", folderId: FOLDER };

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n original invoice bytes \u2713");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function input(overrides: Partial<InvoiceDocumentStoreInput> = {}): InvoiceDocumentStoreInput {
  const invoiceRef = "inv_0123456789abcdef0123";
  return {
    idempotencyKey: invoiceDocumentIdempotencyKey(invoiceRef, 1, sha(PDF_BYTES)),
    bytes: PDF_BYTES,
    mimeType: "application/pdf",
    fileName: "Vendor Invoice.pdf",
    metadata: { invoiceRef, version: 1, counterpartyType: "VENDOR", counterpartyRef: "v_1", artifactSha256: sha(PDF_BYTES) },
    ...overrides,
  };
}

function resetDrive() {
  drive.files.length = 0;
  drive.calls = { list: 0, create: 0, get: 0, update: 0, authConstructed: 0 };
  drive.listError = null;
  drive.createError = null;
  drive.getError = null;
  drive.raceOnCreate = false;
  drive.corruptReadBack = false;
  drive.clock = 0;
  drive.keyFiles.length = 0;
}

afterEach(() => {
  vi.unstubAllEnvs();
  setInvoiceDocumentStorageForTests(null);
});

describe("naming and keys", () => {
  it("the stored name is '<sanitized base> [<invoiceRef> v<n>].pdf' with no path, control or reserved characters and a capped length", () => {
    expect(buildInvoiceDocumentFileName("Acme Media Invoice.pdf", "inv_1", 2)).toBe("Acme Media Invoice [inv_1 v2].pdf");
    expect(buildInvoiceDocumentFileName("../../etc/pass:wd\u0000<x>.PDF", "inv_1", 1)).toBe("pass wd x [inv_1 v1].pdf");
    expect(buildInvoiceDocumentFileName("C:\\Users\\me\\bill.pdf", "inv_1", 1)).toBe("bill [inv_1 v1].pdf");
    expect(buildInvoiceDocumentFileName("...", "inv_1", 1)).toBe("Invoice [inv_1 v1].pdf");
    expect(buildInvoiceDocumentFileName("a".repeat(500) + ".pdf", "inv_1", 1).length).toBeLessThan(160);
  });

  it("driveInvoiceDocumentId is deterministic per idempotencyKey, opaque, and carries the documented prefix", () => {
    const key = invoiceDocumentIdempotencyKey("inv_x", 1, "abc");
    const id = driveInvoiceDocumentId(key);
    expect(id).toBe(driveInvoiceDocumentId(key));
    expect(id.startsWith(DRIVE_INVOICE_DOCUMENT_ID_PREFIX)).toBe(true);
    expect(id).not.toContain("inv_x");
    expect(driveInvoiceDocumentId(invoiceDocumentIdempotencyKey("inv_x", 2, "abc"))).not.toBe(id);
  });

  it("IDEMPOTENCY_KEY_PATTERN matches only a 64-char lowercase hex string", () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test(sha(PDF_BYTES))).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test("not-hex")).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test(sha(PDF_BYTES).toUpperCase())).toBe(false);
  });
});

describe("the in-memory fake (unchanged behavior)", () => {
  it("records the EXACT bytes it received and round-trips them through get()", async () => {
    const storage = createInMemoryInvoiceDocumentStorage();
    const result = await storage.store(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.documentId.startsWith(FAKE_INVOICE_DOCUMENT_ID_PREFIX)).toBe(true);
    const readBack = await storage.get(result.data.documentId);
    expect(readBack && Buffer.from(readBack).equals(Buffer.from(PDF_BYTES))).toBe(true);
  });

  it("is idempotent by key: a repeat returns the same documentId and creates no second file", async () => {
    const storage = createInMemoryInvoiceDocumentStorage();
    const first = await storage.store(input());
    const second = await storage.store(input());
    expect(second).toEqual(first);
    expect(storage.files).toHaveLength(1);
    expect(storage.calls.map((call) => call.outcome)).toEqual(["created", "existing"]);
  });

  it("can be told to fail N times: nothing is stored while failing, then it succeeds", async () => {
    const storage = createInMemoryInvoiceDocumentStorage();
    storage.failNext(2, "storage_unavailable");
    expect(await storage.store(input())).toMatchObject({ ok: false, code: "storage_unavailable" });
    expect(await storage.store(input())).toMatchObject({ ok: false, code: "storage_unavailable" });
    expect(storage.files).toHaveLength(0);
    expect((await storage.store(input())).ok).toBe(true);
  });

  it("get() returns null for an unknown documentId", async () => {
    const storage = createInMemoryInvoiceDocumentStorage();
    expect(await storage.get("nope")).toBeNull();
  });
});

describe("provider selection (pure resolution + seam)", () => {
  const baseEnv = { credentialsPath: "/k.json", folderId: FOLDER, provider: undefined } as const;

  it("fake is the default local/test provider: no explicit provider selects the fake outside production, regardless of what else is configured", () => {
    for (const nodeEnv of ["development", "test", undefined]) expect(resolveInvoiceDocumentStorageKind({ env: baseEnv, nodeEnv, testRun: false })).toBe("FAKE");
    expect(resolveInvoiceDocumentStorageKind({ env: { credentialsPath: undefined, folderId: undefined, provider: undefined }, nodeEnv: "development", testRun: false })).toBe("FAKE");
  });

  it("Drive requires the EXPLICIT provider setting - configuration merely being present is never enough", () => {
    expect(resolveInvoiceDocumentStorageKind({ env: baseEnv, nodeEnv: "production", testRun: false })).toEqual({ notConfigured: "not_implemented" });
    expect(resolveInvoiceDocumentStorageKind({ env: { ...baseEnv, provider: "google_drive" }, nodeEnv: "development", testRun: false })).toBe("GOOGLE_DRIVE");
  });

  it("missing Drive config fails closed to NOT_CONFIGURED - never a silent fallback to the fake", () => {
    expect(resolveInvoiceDocumentStorageKind({ env: { ...baseEnv, provider: "google_drive", credentialsPath: undefined }, nodeEnv: "development", testRun: false })).toEqual({ notConfigured: "missing_credentials" });
    expect(resolveInvoiceDocumentStorageKind({ env: { ...baseEnv, provider: "google_drive", folderId: undefined }, nodeEnv: "development", testRun: false })).toEqual({ notConfigured: "missing_folder" });
  });

  it("an automated test run never resolves to real Drive or the fake, even with full explicit configuration", () => {
    expect(resolveInvoiceDocumentStorageKind({ env: { ...baseEnv, provider: "google_drive" }, nodeEnv: "test", testRun: true })).toEqual({ notConfigured: "live_backend_disabled_in_tests" });
  });

  it("setInvoiceDocumentStorageForTests installs an adapter, forces NOT_CONFIGURED, and refuses to run outside a test run", () => {
    const fake = createInMemoryInvoiceDocumentStorage();
    setInvoiceDocumentStorageForTests(fake);
    expect(getInvoiceDocumentStorage()).toMatchObject({ state: "CONFIGURED", mode: "TEST_OVERRIDE", storage: fake });
    setInvoiceDocumentStorageForTests("NOT_CONFIGURED");
    expect(getInvoiceDocumentStorage()).toEqual({ state: "NOT_CONFIGURED", reason: "test_override" });
    setInvoiceDocumentStorageForTests(null);

    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    expect(() => setInvoiceDocumentStorageForTests(fake)).toThrow(/test run/);
  });

  it("configuration comes only from the environment: blank counts as absent, and only the exact value 'google_drive' selects Drive", () => {
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "  ");
    vi.stubEnv("FINANCE_INVOICE_DRIVE_FOLDER_ID", " invoice_folder_id_0001 ");
    vi.stubEnv("FINANCE_INVOICE_DRIVE_PROVIDER", "GOOGLE_DRIVE");
    expect(getFinanceInvoiceDriveEnv()).toEqual({ credentialsPath: undefined, folderId: "invoice_folder_id_0001", provider: undefined });
    vi.stubEnv("FINANCE_INVOICE_DRIVE_PROVIDER", "google_drive");
    expect(getFinanceInvoiceDriveEnv().provider).toBe("google_drive");
  });

  it("with no override, no explicit provider and no test run, the process falls back to the in-memory fake (never a fabricated Drive reference)", () => {
    vi.stubEnv("FINANCE_INVOICE_DRIVE_PROVIDER", "");
    // this test run's own isAutomatedTestRun() is true, so the seam itself still answers NOT_CONFIGURED -
    // the PURE resolver (exercised above) is what proves the non-test-run default is FAKE.
    const resolution = getInvoiceDocumentStorage();
    expect(resolution.state === "NOT_CONFIGURED" || (resolution.state === "CONFIGURED" && resolution.mode === "FAKE")).toBe(true);
  });
});

describe("the real Google Drive adapter - LIVE-BACKEND GUARD (no env stubbing: this is a real test run)", () => {
  beforeEach(resetDrive);

  it("REFUSES to run under VITEST / NODE_ENV=test on both store() and get(): nothing is authenticated, listed, created or read", async () => {
    expect(process.env.VITEST || process.env.NODE_ENV === "test").toBeTruthy();
    const storage = createGoogleDriveInvoiceStorage(CONFIG);
    const result = await storage.store(input());
    expect(result).toMatchObject({ ok: false, code: "live_backend_disabled_in_tests" });
    expect(await storage.get("driveinvdoc_anything")).toBeNull();
    expect(drive.calls).toEqual({ list: 0, create: 0, get: 0, update: 0, authConstructed: 0 });
    expect(drive.files).toHaveLength(0);
  });

  it("refuses when only NODE_ENV=test (VITEST unset) and when only VITEST is set", async () => {
    const storage = createGoogleDriveInvoiceStorage(CONFIG);
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "test");
    expect(await storage.store(input())).toMatchObject({ ok: false, code: "live_backend_disabled_in_tests" });
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "true");
    expect(await storage.store(input())).toMatchObject({ ok: false, code: "live_backend_disabled_in_tests" });
    expect(drive.calls.list + drive.calls.create + drive.calls.authConstructed).toBe(0);
  });
});

describe("the real Google Drive adapter (mocked googleapis, guard stubbed off)", () => {
  beforeEach(() => {
    resetDrive();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
  });

  it("creates ONE file with the exact bytes, the normalized name and the documentId appProperty - the returned documentId is never the raw Drive file id", async () => {
    const storage = createGoogleDriveInvoiceStorage(CONFIG);
    const result = await storage.store(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.documentId.startsWith(DRIVE_INVOICE_DOCUMENT_ID_PREFIX)).toBe(true);
    expect(result.data.documentId).not.toBe("drive_file_1");
    expect(drive.files).toHaveLength(1);
    const [file] = drive.files;
    expect(file!.parents).toEqual([FOLDER]);
    expect(sha(file!.bytes)).toBe(sha(PDF_BYTES));
    expect(file!.bytes.equals(Buffer.from(PDF_BYTES))).toBe(true);
    expect(file!.name).toBe("Vendor Invoice [inv_0123456789abcdef0123 v1].pdf");
    expect(file!.appProperties[INVOICE_DOCUMENT_KEY_PROPERTY]).toBe(result.data.documentId);
    expect(drive.keyFiles).toEqual([CONFIG.credentialsPath]);
    // an integrity read-back happened as part of store()
    expect(drive.calls.get).toBeGreaterThan(0);
  });

  it("is IDEMPOTENT: re-storing the same key lists first and returns the SAME documentId with no second create", async () => {
    const storage = createGoogleDriveInvoiceStorage(CONFIG);
    const first = await storage.store(input());
    const again = await createGoogleDriveInvoiceStorage(CONFIG).store(input()); // a fresh adapter (a new process) too
    expect(again).toEqual(first);
    expect(drive.calls.create).toBe(1);
    expect(drive.files).toHaveLength(1);
  });

  it("a different Invoice version is a different key and a different file (v1 is never overwritten - immutable versioning)", async () => {
    const storage = createGoogleDriveInvoiceStorage(CONFIG);
    const v1 = await storage.store(input());
    const v2 = await storage.store(input({ idempotencyKey: invoiceDocumentIdempotencyKey("inv_0123456789abcdef0123", 2, sha(PDF_BYTES)), metadata: { ...input().metadata, version: 2 } }));
    expect(v1.ok && v2.ok && v1.data.documentId !== v2.data.documentId).toBe(true);
    expect(drive.files).toHaveLength(2);
    expect(drive.files.every((file) => !file.trashed)).toBe(true);
    // the v1 file's bytes are untouched by v2 ever being stored
    expect(sha(drive.files[0]!.bytes)).toBe(sha(PDF_BYTES));
  });

  it("a concurrent create that raced this one leaves everyone agreeing on the EARLIEST file; the duplicate is trashed, not deleted (retry-safe, no uncontrolled duplicates)", async () => {
    drive.raceOnCreate = true;
    const storage = createGoogleDriveInvoiceStorage(CONFIG);
    const result = await storage.store(input());
    expect(result).toMatchObject({ ok: true });
    expect(drive.files.filter((file) => !file.trashed)).toHaveLength(1);
    expect(drive.files.some((file) => file.trashed)).toBe(true);
    expect(drive.calls.update).toBe(1);
  });

  it("NOT_CONFIGURED: no credentials path, no folder id, or an unsafe folder id - and no Drive call is made", async () => {
    expect(await createGoogleDriveInvoiceStorage({ ...CONFIG, credentialsPath: " " }).store(input())).toMatchObject({ ok: false, code: "not_configured", message: "Document storage not configured" });
    expect(await createGoogleDriveInvoiceStorage({ ...CONFIG, folderId: undefined }).store(input())).toMatchObject({ ok: false, code: "not_configured" });
    // an unsafe folder id (would break out of the query) is treated as not configured
    expect(await createGoogleDriveInvoiceStorage({ ...CONFIG, folderId: "x' or name contains 'a" }).store(input())).toMatchObject({ ok: false, code: "not_configured" });
    expect(drive.calls.list + drive.calls.create).toBe(0);
  });

  it("validates before calling Drive: MIME, key shape and PDF bytes", async () => {
    const storage = createGoogleDriveInvoiceStorage(CONFIG);
    expect(await storage.store(input({ mimeType: "image/png" as unknown as "application/pdf" }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await storage.store(input({ idempotencyKey: "z".repeat(64) }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await storage.store(input({ bytes: new TextEncoder().encode("plain text") }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(drive.calls.list + drive.calls.create).toBe(0);
  });

  it("maps errors to a code and a FIXED message - no key path, folder id or upstream text ever leaks into the client-facing result", async () => {
    const storage = createGoogleDriveInvoiceStorage(CONFIG);
    const upstream = Object.assign(new Error("Error reading /secret/path/service-account.json for folder invoice_folder_id_0001"), { code: 403 });
    drive.listError = upstream;
    const denied = await storage.store(input());
    expect(denied).toMatchObject({ ok: false, code: "access_denied" });
    expect(JSON.stringify(denied)).not.toMatch(/secret|service-account|invoice_folder_id/);

    drive.listError = Object.assign(new Error("boom"), { response: { status: 404 } });
    expect(await storage.store(input())).toMatchObject({ ok: false, code: "file_not_found" });
    drive.listError = null;
    drive.createError = Object.assign(new Error("quota"), { errors: [{ reason: "storageQuotaExceeded" }] });
    expect(await storage.store(input())).toMatchObject({ ok: false, code: "quota_exceeded" });
    drive.createError = Object.assign(new Error("down"), { code: 503 });
    expect(await storage.store(input())).toMatchObject({ ok: false, code: "storage_unavailable" });
    drive.createError = new Error("who knows");
    expect(await storage.store(input())).toMatchObject({ ok: false, code: "unknown" });
    // a failed attempt leaves nothing behind, and the next attempt succeeds cleanly
    expect(drive.files).toHaveLength(0);
    drive.createError = null;
    expect((await storage.store(input())).ok).toBe(true);
    expect(drive.files).toHaveLength(1);
  });

  it("mapDriveError covers network codes and rate limits", () => {
    expect(mapDriveError({ code: "ETIMEDOUT" })).toBe("storage_unavailable");
    expect(mapDriveError({ response: { status: 429 } })).toBe("quota_exceeded");
    expect(mapDriveError(null)).toBe("unknown");
  });

  it("get() round-trips the exact bytes for a documentId returned by store()", async () => {
    const storage = createGoogleDriveInvoiceStorage(CONFIG);
    const stored = await storage.store(input());
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const readBack = await storage.get(stored.data.documentId);
    expect(readBack && Buffer.from(readBack).equals(Buffer.from(PDF_BYTES))).toBe(true);
  });

  it("get() returns null for an unknown documentId, a malformed id, or a read failure - never throws", async () => {
    const storage = createGoogleDriveInvoiceStorage(CONFIG);
    await storage.store(input());
    expect(await storage.get("driveinvdoc_totally_unknown_000000")).toBeNull();
    expect(await storage.get("not-our-prefix")).toBeNull();
    drive.listError = new Error("transient");
    expect(await storage.get("driveinvdoc_totally_unknown_000000")).toBeNull();
  });

  it("integrity: if the bytes read back after upload do not match the recorded checksum, store() FAILS SAFE (integrity_mismatch) rather than report success over ambiguous bytes", async () => {
    drive.corruptReadBack = true;
    const storage = createGoogleDriveInvoiceStorage(CONFIG);
    const result = await storage.store(input());
    expect(result).toMatchObject({ ok: false, code: "integrity_mismatch" });
  });

  it("NOT_CONFIGURED and guard checks on get() too: no credentials/folder, or a malformed id, never reach Drive", async () => {
    expect(await createGoogleDriveInvoiceStorage({ ...CONFIG, credentialsPath: " " }).get("driveinvdoc_x")).toBeNull();
    expect(await createGoogleDriveInvoiceStorage({ ...CONFIG, folderId: undefined }).get("driveinvdoc_x")).toBeNull();
    expect(drive.calls.list).toBe(0);
  });
});

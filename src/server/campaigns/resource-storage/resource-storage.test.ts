import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NO network: googleapis is mocked for the whole file. The only tests that let the (mocked) Drive client run
// stub NODE_ENV / VITEST off first, precisely so the live-Drive guard - which is proven separately WITHOUT
// that stub - is what stands between a test and Google. Mirrors
// finance-agreements/document-storage/document-storage.test.ts's own shape exactly.

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
            const matches = drive.files.filter((file) => !file.trashed && file.parents.includes(parent!) && Object.values(file.appProperties).includes(value!) && file.appProperties.CreatorOpsCampaignResourceKey === value);
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

import { buildCampaignResourceFileName, sanitizeCampaignResourceFileName } from "./file-name";
import { createInMemoryCampaignResourceStorage, FAKE_CAMPAIGN_RESOURCE_LINK_HOST } from "./in-memory";
import { createGoogleDriveCampaignResourceStorage, mapDriveError, CAMPAIGN_RESOURCE_KEY_PROPERTY } from "./google-drive";
import { getCampaignResourceDriveEnv } from "@/lib/env/server";
import { getCampaignResourceStorage, resolveCampaignResourceStorageKind, setCampaignResourceStorageForTests } from "./index";
import type { CampaignResourceUploadInput } from "./types";

const FOLDER = "campaign_resources_folder_0001";
const CONFIG = { credentialsPath: "/secret/path/service-account.json", folderId: FOLDER };

const PNG_BYTES = new TextEncoder().encode("\x89PNG fake bytes for a resource upload ✓");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function idempotencyKey(campaignRef: string, resourceRef: string, bytes: Uint8Array): string {
  return createHash("sha256").update(`${campaignRef}|${resourceRef}|${sha(bytes)}`).digest("hex");
}

function input(overrides: Partial<CampaignResourceUploadInput> = {}): CampaignResourceUploadInput {
  const campaignRef = "camp_0123456789abcdef0123";
  const resourceRef = "res_0123456789abcdef0123";
  return {
    idempotencyKey: idempotencyKey(campaignRef, resourceRef, PNG_BYTES),
    bytes: PNG_BYTES,
    mimeType: "image/png",
    fileName: "Launch Deck.png",
    metadata: { campaignRef, resourceRef },
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
  setCampaignResourceStorageForTests(null);
});

describe("naming", () => {
  it("sanitizes unsafe characters, defaults an empty name, and caps length", () => {
    expect(sanitizeCampaignResourceFileName("Launch Deck.png")).toBe("Launch Deck.png");
    expect(sanitizeCampaignResourceFileName("../../etc/pass:wd?<x>.png")).toBe(".._.._etc_pass_wd__x_.png");
    expect(sanitizeCampaignResourceFileName("   ")).toBe("resource");
    expect(sanitizeCampaignResourceFileName("a".repeat(500)).length).toBe(200);
  });

  it("the stored name is '<campaignRef>__<sanitized base>'", () => {
    expect(buildCampaignResourceFileName("Launch Deck.png", "camp_1")).toBe("camp_1__Launch Deck.png");
  });
});

describe("the in-memory fake", () => {
  it("records the EXACT bytes and arguments it received, and links on the reserved .invalid host", async () => {
    const storage = createInMemoryCampaignResourceStorage();
    const result = await storage.store(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.webViewLink).toBe(`${FAKE_CAMPAIGN_RESOURCE_LINK_HOST}${result.data.fileId}`);
    expect(result.data.webViewLink.startsWith("https://drive.invalid/fake-campaign-resource/")).toBe(true);
    const [file] = storage.files;
    expect(file!.receivedSha256).toBe(sha(PNG_BYTES));
    expect(Buffer.from(file!.bytes).equals(Buffer.from(PNG_BYTES))).toBe(true);
    expect(file!.driveFileName).toBe("camp_0123456789abcdef0123__Launch Deck.png");
    expect(storage.calls).toHaveLength(1);
  });

  it("stores a private copy (mutating the caller's array afterwards cannot change what was 'stored')", async () => {
    const storage = createInMemoryCampaignResourceStorage();
    const bytes = new Uint8Array(PNG_BYTES);
    await storage.store(input({ bytes }));
    bytes[5] = 0;
    expect(storage.files[0]!.receivedSha256).toBe(sha(PNG_BYTES));
    expect(sha(storage.files[0]!.bytes)).toBe(sha(PNG_BYTES));
  });

  it("is idempotent by key: a repeat returns the same file id and link and creates no second file; a new key is a new file", async () => {
    const storage = createInMemoryCampaignResourceStorage();
    const first = await storage.store(input());
    const second = await storage.store(input());
    expect(second).toEqual(first);
    expect(storage.files).toHaveLength(1);
    expect(storage.calls.map((call) => call.outcome)).toEqual(["created", "existing"]);
    const other = await storage.store(input({ idempotencyKey: idempotencyKey("camp_0123456789abcdef0123", "res_other", PNG_BYTES) }));
    expect(other.ok && first.ok && other.data.fileId !== first.data.fileId).toBe(true);
    expect(storage.files).toHaveLength(2);
  });

  it("can be told to fail N times: nothing is stored while failing, then it succeeds", async () => {
    const storage = createInMemoryCampaignResourceStorage();
    storage.failNext(2, "quota_exceeded");
    const a = await storage.store(input());
    const b = await storage.store(input());
    expect(a).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(b).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(storage.files).toHaveLength(0);
    expect((await storage.store(input())).ok).toBe(true);
    expect(storage.files).toHaveLength(1);
  });

  it("rejects an unsupported MIME type, a bad key, and empty bytes", async () => {
    const storage = createInMemoryCampaignResourceStorage();
    expect(await storage.store(input({ mimeType: "text/plain" as unknown as "image/png" }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await storage.store(input({ idempotencyKey: "nope" }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await storage.store(input({ bytes: new Uint8Array(0) }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(storage.files).toHaveLength(0);
  });
});

describe("which storage a process uses (pure resolution + seam)", () => {
  const configured = { credentialsPath: "/k.json", folderId: FOLDER, mode: "real", allowRealExternalServices: true } as const;

  it("credentials and folder id being PRESENT is never enough on its own: without mode=real AND the external-services switch, the answer is FAKE (dev) or NOT_CONFIGURED (production)", () => {
    const presentButNotOptedIn = { credentialsPath: "/k.json", folderId: FOLDER, mode: undefined, allowRealExternalServices: false } as const;
    for (const nodeEnv of ["development", "test", undefined]) expect(resolveCampaignResourceStorageKind({ env: presentButNotOptedIn, nodeEnv, testRun: false })).toBe("FAKE");
    expect(resolveCampaignResourceStorageKind({ env: presentButNotOptedIn, nodeEnv: "production", testRun: false })).toEqual({ notConfigured: "drive_mode_not_enabled" });
  });

  it("mode=real WITHOUT the shared ALLOW_REAL_EXTERNAL_SERVICES switch never reaches Drive, even with full credentials/folder", () => {
    expect(resolveCampaignResourceStorageKind({ env: { ...configured, allowRealExternalServices: false }, nodeEnv: "development", testRun: false })).toEqual({ notConfigured: "real_external_services_not_allowed" });
    expect(resolveCampaignResourceStorageKind({ env: { ...configured, allowRealExternalServices: false }, nodeEnv: "production", testRun: false })).toEqual({ notConfigured: "real_external_services_not_allowed" });
  });

  it("the shared ALLOW_REAL_EXTERNAL_SERVICES switch WITHOUT mode=real never reaches Drive either - both gates are required", () => {
    expect(resolveCampaignResourceStorageKind({ env: { ...configured, mode: undefined }, nodeEnv: "development", testRun: false })).toBe("FAKE");
    expect(resolveCampaignResourceStorageKind({ env: { ...configured, mode: "fake" }, nodeEnv: "development", testRun: false })).toBe("FAKE");
  });

  it("with BOTH explicit gates on: NOT_CONFIGURED without credentials or without a folder; real Drive only when both are present", () => {
    expect(resolveCampaignResourceStorageKind({ env: { ...configured, credentialsPath: "  " }, nodeEnv: "development", testRun: false })).toEqual({ notConfigured: "missing_credentials" });
    expect(resolveCampaignResourceStorageKind({ env: { ...configured, folderId: undefined }, nodeEnv: "development", testRun: false })).toEqual({ notConfigured: "missing_folder" });
    expect(resolveCampaignResourceStorageKind({ env: configured, nodeEnv: "production", testRun: false })).toBe("GOOGLE_DRIVE");
  });

  it("an automated test run never resolves to real Drive, even with full configuration and both gates on", () => {
    expect(resolveCampaignResourceStorageKind({ env: configured, nodeEnv: "test", testRun: true })).toEqual({ notConfigured: "live_drive_disabled_in_tests" });
  });

  it("setCampaignResourceStorageForTests installs an adapter, forces NOT_CONFIGURED, and refuses to run outside a test run", () => {
    const fake = createInMemoryCampaignResourceStorage();
    setCampaignResourceStorageForTests(fake);
    expect(getCampaignResourceStorage()).toMatchObject({ state: "CONFIGURED", mode: "TEST_OVERRIDE", storage: fake });
    setCampaignResourceStorageForTests("NOT_CONFIGURED");
    expect(getCampaignResourceStorage()).toEqual({ state: "NOT_CONFIGURED", reason: "test_override" });
    setCampaignResourceStorageForTests(null);

    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    expect(() => setCampaignResourceStorageForTests(fake)).toThrow(/test run/);
  });

  it("configuration comes only from the environment: blank counts as absent, and only the exact value 'real' opts into Drive (case-sensitive)", () => {
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "  ");
    vi.stubEnv("CAMPAIGN_RESOURCE_DRIVE_FOLDER_ID", " campaign_resources_folder_0001 ");
    vi.stubEnv("CAMPAIGN_RESOURCE_DRIVE_MODE", "REAL");
    vi.stubEnv("ALLOW_REAL_EXTERNAL_SERVICES", "TRUE");
    expect(getCampaignResourceDriveEnv()).toEqual({ credentialsPath: undefined, folderId: "campaign_resources_folder_0001", mode: undefined, allowRealExternalServices: false });
    vi.stubEnv("CAMPAIGN_RESOURCE_DRIVE_MODE", "real");
    vi.stubEnv("ALLOW_REAL_EXTERNAL_SERVICES", "true");
    expect(getCampaignResourceDriveEnv().mode).toBe("real");
    expect(getCampaignResourceDriveEnv().allowRealExternalServices).toBe(true);
  });

  it("CAMPAIGN_RESOURCE_DRIVE_MODE=fake does NOT bypass the live-test-run guard: getCampaignResourceStorage (this process's own isAutomatedTestRun() is true) still answers NOT_CONFIGURED without an explicit override", () => {
    vi.stubEnv("CAMPAIGN_RESOURCE_DRIVE_MODE", "fake");
    expect(getCampaignResourceStorage()).toEqual({ state: "NOT_CONFIGURED", reason: "live_drive_disabled_in_tests" });
  });

  it("production without an explicit real opt-in never silently uses the fake either - truthful NOT_CONFIGURED", () => {
    vi.stubEnv("CAMPAIGN_RESOURCE_DRIVE_MODE", "fake");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    expect(resolveCampaignResourceStorageKind({ env: getCampaignResourceDriveEnv(), nodeEnv: "production", testRun: false })).toEqual({ notConfigured: "drive_mode_not_enabled" });
  });

  it("with no override and no configuration in this test run, the answer is a truthful NOT_CONFIGURED (never a real adapter)", () => {
    const resolution = getCampaignResourceStorage();
    expect(resolution.state === "NOT_CONFIGURED" || (resolution.state === "CONFIGURED" && resolution.mode === "FAKE")).toBe(true);
  });
});

describe("the real Google Drive adapter - LIVE-DRIVE GUARD (no env stubbing: this is a real test run)", () => {
  beforeEach(resetDrive);

  it("REFUSES to run under VITEST / NODE_ENV=test: nothing is authenticated, listed or created", async () => {
    expect(process.env.VITEST || process.env.NODE_ENV === "test").toBeTruthy();
    const storage = createGoogleDriveCampaignResourceStorage(CONFIG);
    const result = await storage.store(input());
    expect(result).toMatchObject({ ok: false, code: "live_drive_disabled_in_tests" });
    expect(drive.calls).toEqual({ list: 0, create: 0, get: 0, update: 0, authConstructed: 0 });
    expect(drive.files).toHaveLength(0);
  });
});

describe("the real Google Drive adapter (mocked googleapis, guard stubbed off)", () => {
  beforeEach(() => {
    resetDrive();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
  });

  it("creates ONE file in the resources folder with the exact bytes, the normalized name and the idempotency appProperty", async () => {
    const storage = createGoogleDriveCampaignResourceStorage(CONFIG);
    const result = await storage.store(input());
    expect(result).toEqual({ ok: true, data: { fileId: "drive_file_1", webViewLink: "https://drive.google.com/file/d/drive_file_1/view" } });
    expect(drive.files).toHaveLength(1);
    const [file] = drive.files;
    expect(file!.parents).toEqual([FOLDER]);
    expect(sha(file!.bytes)).toBe(sha(PNG_BYTES));
    expect(file!.bytes.equals(Buffer.from(PNG_BYTES))).toBe(true);
    expect(file!.name).toBe("camp_0123456789abcdef0123__Launch Deck.png");
    expect(file!.appProperties[CAMPAIGN_RESOURCE_KEY_PROPERTY]).toBe(input().idempotencyKey);
    expect(drive.keyFiles).toEqual([CONFIG.credentialsPath]);
  });

  it("is IDEMPOTENT: re-storing the same key lists first and returns the SAME id and link with no second create", async () => {
    const storage = createGoogleDriveCampaignResourceStorage(CONFIG);
    const first = await storage.store(input());
    const again = await createGoogleDriveCampaignResourceStorage(CONFIG).store(input()); // a fresh adapter (a new process) too
    expect(again).toEqual(first);
    expect(drive.calls.create).toBe(1);
    expect(drive.files).toHaveLength(1);
  });

  it("a different resource is a different key and a different file (the first is never overwritten)", async () => {
    const storage = createGoogleDriveCampaignResourceStorage(CONFIG);
    const first = await storage.store(input());
    const second = await storage.store(input({ idempotencyKey: idempotencyKey("camp_0123456789abcdef0123", "res_other", PNG_BYTES), metadata: { campaignRef: "camp_0123456789abcdef0123", resourceRef: "res_other" } }));
    expect(first.ok && second.ok && first.data.fileId !== second.data.fileId).toBe(true);
    expect(drive.files).toHaveLength(2);
  });

  it("a concurrent create that raced this one leaves everyone agreeing on the EARLIEST file; the duplicate is trashed, not deleted", async () => {
    drive.raceOnCreate = true;
    const storage = createGoogleDriveCampaignResourceStorage(CONFIG);
    const result = await storage.store(input());
    expect(result).toMatchObject({ ok: true, data: { fileId: "drive_racer" } });
    expect(drive.files.filter((file) => !file.trashed).map((file) => file.id)).toEqual(["drive_racer"]);
    expect(drive.calls.update).toBe(1);
  });

  it("NOT_CONFIGURED: no credentials path, or no folder id - and no Drive call is made", async () => {
    expect(await createGoogleDriveCampaignResourceStorage({ ...CONFIG, credentialsPath: " " }).store(input())).toMatchObject({ ok: false, code: "not_configured" });
    expect(await createGoogleDriveCampaignResourceStorage({ ...CONFIG, folderId: undefined }).store(input())).toMatchObject({ ok: false, code: "not_configured" });
    // an unsafe folder id (would break out of the query) is treated as not configured
    expect(await createGoogleDriveCampaignResourceStorage({ ...CONFIG, folderId: "x' or name contains 'a" }).store(input())).toMatchObject({ ok: false, code: "not_configured" });
    expect(drive.calls.list + drive.calls.create).toBe(0);
  });

  it("validates before calling Drive: MIME, key shape and non-empty bytes", async () => {
    const storage = createGoogleDriveCampaignResourceStorage(CONFIG);
    expect(await storage.store(input({ mimeType: "application/zip" as unknown as "image/png" }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await storage.store(input({ idempotencyKey: "z".repeat(64) }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await storage.store(input({ bytes: new Uint8Array(0) }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(drive.calls.list + drive.calls.create).toBe(0);
  });

  it("maps errors to a code and a FIXED message - no key path or folder id ever leaks", async () => {
    const storage = createGoogleDriveCampaignResourceStorage(CONFIG);
    const upstream = Object.assign(new Error("Error reading /secret/path/service-account.json for folder campaign_resources_folder_0001"), { code: 403 });
    drive.listError = upstream;
    const denied = await storage.store(input());
    expect(denied).toMatchObject({ ok: false, code: "access_denied" });
    expect(JSON.stringify(denied)).not.toMatch(/secret|service-account|campaign_resources_folder/);

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

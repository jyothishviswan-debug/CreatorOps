import { describe, expect, it } from "vitest";

import type { FinanceApiResult } from "../../api-client";
import type { OnboardingOutcomeDto } from "@/server/finance-agreements/onboarding-dto";
import type { OnboardingRequest } from "@/server/finance-agreements/onboarding-input";

import { outcomeDto } from "./onboarding-fixtures";
import { clearPersisted, decideResume, ONBOARDING_STORAGE_KEY, parsePersisted, readPersisted, serializePersisted, writePersisted, type PersistedOnboarding, type StorageLike } from "./resume";

const REQUEST: OnboardingRequest = {
  clientRequestId: "onboard-11111111",
  type: "PARTNER",
  reviewedProfile: { displayName: "Asha Rao", regionIds: ["Karnataka"] },
  accounts: [{ platform: "Instagram", profileUrl: "https://www.instagram.com/asha" }],
  duplicateDecision: { kind: "CREATE_NEW", acknowledgedDuplicates: false },
};
const RECORD: PersistedOnboarding = { v: 1, clientRequestId: "onboard-11111111", type: "PARTNER", choice: "INSTAGRAM_PARTNER", request: REQUEST, savedAt: "2026-09-21T10:00:00.000Z" };

function memoryStorage(seed: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...seed };
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value), removeItem: (key) => void delete data[key] };
}

describe("persisted onboarding", () => {
  it("round-trips a record", () => {
    expect(parsePersisted(serializePersisted(RECORD))).toEqual(RECORD);
  });

  it("drops anything malformed: bad JSON, wrong version, bad id, mismatched request, unknown card", () => {
    expect(parsePersisted(null)).toBeNull();
    expect(parsePersisted("not json")).toBeNull();
    expect(parsePersisted("42")).toBeNull();
    expect(parsePersisted(JSON.stringify({ ...RECORD, v: 2 }))).toBeNull();
    expect(parsePersisted(JSON.stringify({ ...RECORD, clientRequestId: "x" }))).toBeNull();
    expect(parsePersisted(JSON.stringify({ ...RECORD, request: { ...REQUEST, clientRequestId: "onboard-22222222" } }))).toBeNull();
    expect(parsePersisted(JSON.stringify({ ...RECORD, type: "VENDOR" }))).toBeNull();
    expect(parsePersisted(JSON.stringify({ ...RECORD, choice: "ADMIN" }))).toBeNull();
    expect(parsePersisted(JSON.stringify({ ...RECORD, request: { clientRequestId: RECORD.clientRequestId, type: "PARTNER" } }))).toBeNull();
  });

  it("writes, reads and clears through the storage, and never throws when storage is missing or broken", () => {
    const storage = memoryStorage();
    expect(writePersisted(storage, RECORD)).toBe(true);
    expect(Object.keys(storage.data)).toEqual([ONBOARDING_STORAGE_KEY]);
    expect(readPersisted(storage)).toEqual(RECORD);
    clearPersisted(storage);
    expect(readPersisted(storage)).toBeNull();

    expect(writePersisted(null, RECORD)).toBe(false);
    expect(readPersisted(null)).toBeNull();
    clearPersisted(null);
    const broken: StorageLike = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(writePersisted(broken, RECORD)).toBe(false);
    expect(readPersisted(broken)).toBeNull();
    expect(() => clearPersisted(broken)).not.toThrow();
  });

  it("holds no identity value: only what the reviewer typed", () => {
    expect(serializePersisted(RECORD)).not.toMatch(/pan|aadhaar|gstin|ifsc|bank/i);
  });
});

describe("what a status answer means after a reload", () => {
  const ok = (data: OnboardingOutcomeDto): FinanceApiResult<OnboardingOutcomeDto> => ({ ok: true, status: 200, data });

  it("COMPLETED goes straight to the Agreement", () => {
    expect(decideResume(ok(outcomeDto()))).toMatchObject({ kind: "redirect", agreementRef: "agr_0123456789abcdef0123" });
  });

  it("FAILED and IN_PROGRESS restore the create step so Retry / Check again can resume with the same request", () => {
    expect(decideResume(ok(outcomeDto({ outcome: "FAILED", failedStep: "ACCOUNTS_CREATED", retryable: true, agreementRef: null })))).toMatchObject({ kind: "restore" });
    expect(decideResume(ok(outcomeDto({ outcome: "IN_PROGRESS", agreementRef: null })))).toMatchObject({ kind: "restore" });
  });

  it("not found means the request never reached the server: forget it", () => {
    expect(decideResume({ ok: false, status: 404, kind: "not_found", message: "Not found." })).toEqual({ kind: "discard" });
  });

  it("a transient failure keeps the remembered request (never discards on a network error)", () => {
    expect(decideResume({ ok: false, status: 0, kind: "network", message: "Could not reach the server." })).toEqual({ kind: "unavailable", message: "Could not reach the server." });
    expect(decideResume({ ok: false, status: 500, kind: "error", message: "Something went wrong." })).toMatchObject({ kind: "unavailable" });
  });
});

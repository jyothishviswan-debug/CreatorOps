import { describe, expect, it } from "vitest";

import { accountCreateInput, accountKey, canonicalPlatform, normalizeProfile, onboardingInputFingerprint, onboardingInputSchema } from "./onboarding-input";
import { onboardingAgreementClientRequestId, onboardingFingerprint, onboardingLedgerId, onboardingLedgerDocSchema, onboardingStepRequestId } from "./onboarding-ledger";
import { clientRequestIdSchema } from "./types";

const base = {
  clientRequestId: "onb-req-12345678",
  type: "PARTNER" as const,
  reviewedProfile: { displayName: "  Asha Studio ", email: " Asha@Example.COM ", phone: "+91 98765 43210", regionIds: ["Kerala", "Kerala", "Karnataka"] },
  accounts: [{ platform: "instagram", handle: "@Asha.Studio" }],
  duplicateDecision: { kind: "CREATE_NEW" as const, acknowledgedDuplicates: false },
};

const issues = (input: unknown) => {
  const result = onboardingInputSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};

describe("onboarding input schema", () => {
  it("accepts a reviewed new Partner with Instagram + YouTube accounts (one Partner, two accounts)", () => {
    const parsed = onboardingInputSchema.parse({ ...base, accounts: [{ platform: "Instagram", handle: "asha" }, { platform: "YouTube", profileUrl: "https://youtube.com/@asha", displayName: "Asha TV" }] });
    expect(parsed.accounts).toHaveLength(2);
    expect(parsed.reviewedProfile.displayName).toBe("Asha Studio");
  });

  it("is strict: a client-supplied uid, scope, owner, status or provenance marker is rejected", () => {
    for (const extra of [{ uid: "x" }, { scope: "GLOBAL" }, { ownerUserRef: "u" }, { createdVia: "FINANCE_AGREEMENT_ONBOARDING" }, { status: "ACTIVE" }]) expect(issues({ ...base, ...extra }).length, JSON.stringify(extra)).toBeGreaterThan(0);
    expect(issues({ ...base, reviewedProfile: { ...base.reviewedProfile, ownerUserRef: "u" } }).length).toBeGreaterThan(0);
    expect(issues({ ...base, accounts: [{ platform: "Instagram", handle: "a", status: "ACTIVE" }] }).length).toBeGreaterThan(0);
  });

  it("a new record needs at least one region", () => {
    expect(issues({ ...base, reviewedProfile: { displayName: "Asha" } })).toContain("reviewedProfile.regionIds: Choose at least one region for the new record.");
    expect(issues({ ...base, reviewedProfile: { displayName: "Asha", regionIds: [] } })).toContain("reviewedProfile.regionIds: Choose at least one region for the new record.");
  });

  it("a Vendor needs its type and takes no accounts; a Partner takes no vendor type", () => {
    const vendor = { ...base, type: "VENDOR" as const, accounts: undefined };
    expect(issues(vendor)).toContain("reviewedProfile.vendorType: Choose the Vendor type.");
    expect(issues({ ...vendor, reviewedProfile: { ...base.reviewedProfile, vendorType: "AGENCY" } })).toEqual([]);
    expect(issues({ ...vendor, reviewedProfile: { ...base.reviewedProfile, vendorType: "AGENCY" }, accounts: [{ platform: "Instagram", handle: "a" }] })).toContain("accounts: A Vendor has no Partner Accounts.");
    expect(issues({ ...base, reviewedProfile: { ...base.reviewedProfile, vendorType: "AGENCY" } })).toContain("reviewedProfile.vendorType: A vendor type applies to Vendors only.");
    expect(issues({ ...vendor, reviewedProfile: { ...base.reviewedProfile, vendorType: "NOT_A_TYPE" } }).length).toBeGreaterThan(0);
  });

  it("every account needs a locator, and no account may be listed twice (after owning normalization)", () => {
    expect(issues({ ...base, accounts: [{ platform: "Instagram" }] })).toContain("accounts.0: Each account needs a page link, a handle or a platform account id.");
    expect(issues({ ...base, accounts: [{ platform: "Instagram", displayName: "Only a name" }] }).length).toBeGreaterThan(0);
    expect(issues({ ...base, accounts: [{ platform: "Instagram", handle: "Asha" }, { platform: " instagram ", handle: "@asha" }] })).toContain("accounts.1: The same account is listed twice.");
    // the same handle on two DIFFERENT platforms is two accounts
    expect(issues({ ...base, accounts: [{ platform: "Instagram", handle: "asha" }, { platform: "YouTube", handle: "asha" }] })).toEqual([]);
  });

  it("at most 6 accounts", () => {
    const seven = Array.from({ length: 7 }, (_, index) => ({ platform: "Instagram", handle: `h${index}` }));
    expect(issues({ ...base, accounts: seven }).length).toBeGreaterThan(0);
  });

  it("USE_EXISTING names a ref (and optionally that Partner's own account refs); listed accounts are duplicate-check evidence and are validated the same way", () => {
    const existing = { ...base, accounts: undefined, reviewedProfile: { displayName: "Asha Studio" }, duplicateDecision: { kind: "USE_EXISTING" as const, ref: "partner-ref-1", partnerAccountRefs: ["acc-1"] } };
    expect(issues(existing)).toEqual([]);
    expect(issues({ ...existing, accounts: [{ platform: "Instagram", handle: "a" }] })).toEqual([]);
    expect(issues({ ...existing, accounts: [{ platform: "Instagram" }] }).length).toBeGreaterThan(0);
    expect(issues({ ...existing, type: "VENDOR" })).toContain("duplicateDecision.partnerAccountRefs: Partner Accounts apply to a Partner only.");
    expect(issues({ ...existing, duplicateDecision: { kind: "USE_EXISTING" } }).length).toBeGreaterThan(0);
  });

  it("CREATE_NEW needs an explicit acknowledgedDuplicates boolean; a reason is at least 3 characters", () => {
    expect(issues({ ...base, duplicateDecision: { kind: "CREATE_NEW" } }).length).toBeGreaterThan(0);
    expect(issues({ ...base, duplicateDecision: { kind: "CREATE_NEW", acknowledgedDuplicates: true, reason: "x" } }).length).toBeGreaterThan(0);
    expect(issues({ ...base, duplicateDecision: { kind: "CREATE_NEW", acknowledgedDuplicates: true, reason: "Different person" } })).toEqual([]);
  });

  it("clientRequestId follows the Agreement idempotency shape", () => {
    expect(issues({ ...base, clientRequestId: "short" }).length).toBeGreaterThan(0);
    expect(issues({ ...base, clientRequestId: "has spaces here" }).length).toBeGreaterThan(0);
  });
});

describe("canonical account identity", () => {
  it("uses the OWNING normalizer: platform lower-cased, one identity by id > url > handle", () => {
    expect(accountKey({ platform: "Instagram", handle: "@Asha" })).toBe(accountKey({ platform: " instagram ", handle: "asha" }));
    expect(accountKey({ platform: "Instagram", handle: "asha" })).not.toBe(accountKey({ platform: "YouTube", handle: "asha" }));
    // a platform id outranks a link, which outranks a handle
    expect(accountKey({ platform: "YouTube", platformAccountId: "UC1", profileUrl: "https://y/x", handle: "h" })).toBe(accountKey({ platform: "YouTube", platformAccountId: "uc1" }));
    expect(accountKey({ platform: "YouTube", profileUrl: "https://y/x/", handle: "h" })).toBe(accountKey({ platform: "YouTube", profileUrl: "HTTPS://y/x" }));
    expect(accountKey({ platform: "Instagram" })).toBeNull();
    expect(accountKey({ platform: "Instagram", handle: "asha" })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the owning create input carries the canonical platform spelling and only the given locators, and never a display name as identity", () => {
    expect(canonicalPlatform(" instagram ")).toBe("Instagram");
    expect(canonicalPlatform("YOUTUBE")).toBe("YouTube");
    expect(canonicalPlatform("  Threads ")).toBe("Threads");
    expect(accountCreateInput({ platform: "youtube", profileUrl: "https://youtube.com/@a", displayName: "Asha TV" }, true)).toEqual({ platform: "YouTube", profileUrl: "https://youtube.com/@a", displayName: "Asha TV", primary: true });
    expect(accountCreateInput({ platform: "instagram", handle: "a" }, false)).toEqual({ platform: "Instagram", handle: "a", primary: false });
  });
});

describe("normalized profile", () => {
  it("normalizes email / phone / name with the owning rules, dedupes and sorts regions, and keeps absent values null", () => {
    const parsed = onboardingInputSchema.parse(base);
    expect(normalizeProfile("PARTNER", parsed.reviewedProfile)).toEqual({ displayName: "Asha Studio", displayNameLower: "asha studio", legalName: null, email: "asha@example.com", phone: "+919876543210", regionIds: ["Karnataka", "Kerala"], vendorType: null });
    const bare = onboardingInputSchema.parse({ ...base, reviewedProfile: { displayName: "X", regionIds: ["Kerala"] } });
    expect(normalizeProfile("PARTNER", bare.reviewedProfile)).toMatchObject({ email: null, phone: null });
  });
});

describe("fingerprint", () => {
  it("is stable for the same request (ignoring email case, phone formatting, region order) and changes with any real change", () => {
    const one = onboardingInputSchema.parse(base);
    const same = onboardingInputSchema.parse({ ...base, reviewedProfile: { ...base.reviewedProfile, email: "asha@example.com", phone: "+919876543210", regionIds: ["Karnataka", "Kerala"] } });
    expect(onboardingInputFingerprint(same)).toBe(onboardingInputFingerprint(one));
    expect(onboardingInputFingerprint(one)).toMatch(/^[0-9a-f]{64}$/);
    for (const changed of [
      { ...base, reviewedProfile: { ...base.reviewedProfile, displayName: "Asha Studios" } },
      { ...base, accounts: [{ platform: "instagram", handle: "someone.else" }] },
      { ...base, accounts: [] },
      { ...base, duplicateDecision: { kind: "CREATE_NEW" as const, acknowledgedDuplicates: true, reason: "Different person" } },
      { ...base, type: "VENDOR" as const, accounts: undefined, reviewedProfile: { ...base.reviewedProfile, vendorType: "AGENCY" as const } },
    ]) expect(onboardingInputFingerprint(onboardingInputSchema.parse(changed))).not.toBe(onboardingInputFingerprint(one));
  });
});

describe("ledger ids", () => {
  it("onb_ + sha256(actorUid|clientRequestId): per actor, opaque, deterministic", () => {
    const id = onboardingLedgerId("actor-1", "onb-req-12345678");
    expect(id).toMatch(/^onb_[0-9a-f]{64}$/);
    expect(onboardingLedgerId("actor-1", "onb-req-12345678")).toBe(id);
    expect(onboardingLedgerId("actor-2", "onb-req-12345678")).not.toBe(id);
    expect(id).not.toContain("actor-1");
    expect(onboardingLedgerId("actor-1", "onb-req-12345678").startsWith("onb_")).toBe(true);
    // an Agreement idempotency claim id is a bare 64-hex digest: the two id spaces can never collide
    expect(id).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it("the derived Agreement clientRequestId is deterministic and valid; step request ids correlate with the ledger", () => {
    const id = onboardingLedgerId("actor-1", "onb-req-12345678");
    const clientRequestId = onboardingAgreementClientRequestId(id);
    expect(clientRequestIdSchema.safeParse(clientRequestId).success).toBe(true);
    expect(onboardingAgreementClientRequestId(id)).toBe(clientRequestId);
    expect(clientRequestId).not.toBe(onboardingAgreementClientRequestId(onboardingLedgerId("actor-1", "onb-req-87654321")));
    expect(onboardingStepRequestId(id, "counterparty")).toMatch(/^onb:[0-9a-f]{24}:counterparty$/);
  });

  it("the fingerprint helper is a plain sha256 of the canonical JSON", () => {
    expect(onboardingFingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(onboardingFingerprint({ a: 1 })).not.toBe(onboardingFingerprint({ a: 2 }));
  });
});

describe("ledger document schema", () => {
  const doc = {
    kind: "ONBOARDING",
    onboardingRef: onboardingLedgerId("actor-1", "onb-req-12345678"),
    clientRequestId: "onb-req-12345678",
    actorUserRef: "usr-1",
    counterpartyType: "PARTNER",
    mode: "CREATE_NEW",
    createdVia: "FINANCE_AGREEMENT_ONBOARDING",
    inputFingerprint: "a".repeat(64),
    status: "IN_PROGRESS",
    attempts: 1,
    lease: { token: "t", expiresAt: "2026-09-01T00:01:00.000Z" },
    duplicateDecision: { kind: "CREATE_NEW", acknowledgedDuplicates: false, reasonRecorded: false },
    steps: { validatedAt: "2026-09-01T00:00:00.000Z", counterparty: null, plannedAccountKeys: [], accounts: [], agreement: null },
    failure: null,
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };

  it("parses a fresh ledger and rejects unknown keys and a wrong provenance marker", () => {
    expect(onboardingLedgerDocSchema.safeParse(doc).success).toBe(true);
    expect(onboardingLedgerDocSchema.safeParse({ ...doc, email: "a@b.co" }).success).toBe(false);
    expect(onboardingLedgerDocSchema.safeParse({ ...doc, createdVia: "OTHER" }).success).toBe(false);
    expect(onboardingLedgerDocSchema.safeParse({ ...doc, onboardingRef: "x".repeat(64) }).success).toBe(false);
  });
});

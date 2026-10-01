import { afterEach, describe, expect, it, vi } from "vitest";

const { getUserDocMock, getPartnerAccountDocByRefMock } = vi.hoisted(() => ({ getUserDocMock: vi.fn(), getPartnerAccountDocByRefMock: vi.fn() }));
vi.mock("@/server/authz/firestore", () => ({ getUserDoc: getUserDocMock }));
vi.mock("@/server/partners/firestore", () => ({ getPartnerAccountDocByRef: getPartnerAccountDocByRefMock }));

import { evaluateLeadReadiness } from "./readiness";
import type { LeadDoc } from "./types";

function fullyReadyLead(overrides: Partial<LeadDoc> = {}): LeadDoc {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    uid: "lead-1",
    leadRef: "ref-lead-1",
    version: 1,
    lifecycle: "CONVERSION_READY",
    previousLifecycle: null,
    lifecycleReason: null,
    displayName: "Test Creator",
    displayNameLower: "test creator",
    email: "creator@example.com",
    phone: "+91 90000 00000",
    profileUrl: "https://instagram.com/testcreator",
    platform: "Instagram",
    handle: "testcreator",
    source: { type: "research" },
    regionIds: ["Kerala"],
    teamId: null,
    ownerUid: "owner-uid",
    research: { targetAudience: ["India 1"], updatedAt: now, updatedByUserRef: "ref-1" },
    latestReview: { outcome: "SHORTLIST", dimensions: {}, actorUserRef: "ref-1", createdAt: now },
    outreachSummary: { totalCount: 2, lastDirection: "INBOUND", lastChannel: "email", lastOutcome: "Interested", lastAt: now, nextFollowUpAt: null },
    respondedAt: now,
    commercial: { alignmentConfirmed: true, updatedAt: now, updatedByUserRef: "ref-1" },
    discoveryAgreement: { confirmedAt: now, updatedAt: now, updatedByUserRef: "ref-1" },
    assetDecision: { decision: "NEW_ACCOUNT", decidedAt: now, decidedByUserRef: "ref-1" },
    managerUid: "manager-uid",
    kycPackageComplete: true,
    duplicateCheck: { status: "none", matches: [], checkedAt: now },
    conversion: null,
    proposalNumber: null,
    proposalPlatformCode: null,
    createdAt: now,
    createdByUserRef: "ref-1",
    updatedAt: now,
    updatedByUserRef: "ref-1",
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("evaluateLeadReadiness", () => {
  it("is ready with zero blockers when every requirement is satisfied and the manager is active", async () => {
    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: true });
    const result = await evaluateLeadReadiness(fullyReadyLead());
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("blocks when identity/contact is missing (no email and no phone)", async () => {
    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: true });
    const result = await evaluateLeadReadiness(fullyReadyLead({ email: null, phone: null }));
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain("IDENTITY_CONTACT_MISSING");
  });

  it("warns (does not block IDENTITY_CONTACT_MISSING) when only one contact method is on file - but finding #26 separately requires phone specifically for progression", async () => {
    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: true });
    const result = await evaluateLeadReadiness(fullyReadyLead({ phone: null }));
    expect(result.blockers.map((b) => b.code)).not.toContain("IDENTITY_CONTACT_MISSING");
    expect(result.warnings.map((w) => w.code)).toContain("SINGLE_CONTACT_METHOD");
    // Finding #26 (user-decided): a Lead missing phone specifically is
    // blocked from progression regardless of having email - old Leads stay
    // readable, but cannot read as conversion-ready until remediated.
    expect(result.blockers.map((b) => b.code)).toContain("PHONE_MISSING");
    expect(result.ready).toBe(false);
  });

  it("blocks when research is not complete", async () => {
    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: true });
    const result = await evaluateLeadReadiness(fullyReadyLead({ research: { targetAudience: [], updatedAt: "now", updatedByUserRef: "ref-1" } }));
    expect(result.blockers.map((b) => b.code)).toContain("RESEARCH_INCOMPLETE");
  });

  it("blocks when the Lead has not been shortlisted (no review, or a non-SHORTLIST outcome)", async () => {
    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: true });
    expect((await evaluateLeadReadiness(fullyReadyLead({ latestReview: null }))).blockers.map((b) => b.code)).toContain("REVIEW_MISSING");
    const needMoreInfo = fullyReadyLead({ latestReview: { outcome: "NEED_MORE_INFO", dimensions: {}, actorUserRef: "ref-1", createdAt: "now" } });
    expect((await evaluateLeadReadiness(needMoreInfo)).blockers.map((b) => b.code)).toContain("REVIEW_MISSING");
  });

  it("blocks when no meaningful response or commercial alignment is recorded", async () => {
    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: true });
    expect((await evaluateLeadReadiness(fullyReadyLead({ respondedAt: null }))).blockers.map((b) => b.code)).toContain("RESPONSE_MISSING");
    expect((await evaluateLeadReadiness(fullyReadyLead({ commercial: null }))).blockers.map((b) => b.code)).toContain("COMMERCIAL_ALIGNMENT_MISSING");
  });

  it("blocks when operational agreement evidence isn't confirmed", async () => {
    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: true });
    const result = await evaluateLeadReadiness(fullyReadyLead({ discoveryAgreement: { confirmedAt: null, updatedAt: "now", updatedByUserRef: "ref-1" } }));
    expect(result.blockers.map((b) => b.code)).toContain("OPERATIONAL_AGREEMENT_MISSING");
  });

  it("blocks when no asset decision is recorded", async () => {
    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: true });
    const result = await evaluateLeadReadiness(fullyReadyLead({ assetDecision: null }));
    expect(result.blockers.map((b) => b.code)).toContain("ASSET_DECISION_MISSING");
  });

  // Finding #15, evolved by finding #16 (user-decided): the old invariant
  // ("non-NEW_ACCOUNT always requires existingPartnerAccountRef") is
  // replaced by "requires EITHER a valid ref OR the Lead's own confirmed
  // platform identity" - a decision with neither is still invalid, but
  // one with real platform identity (even without a ref) is now fine.
  it("blocks (ASSET_DECISION_INVALID) when a non-NEW_ACCOUNT decision has NEITHER an existingPartnerAccountRef NOR a platform on the Lead", async () => {
    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: true });
    const result = await evaluateLeadReadiness(fullyReadyLead({ platform: null, assetDecision: { decision: "MAINTAIN_EXISTING", decidedAt: "2026-01-01T00:00:00.000Z", decidedByUserRef: "ref-1" } }));
    expect(result.blockers.map((b) => b.code)).toContain("ASSET_DECISION_INVALID");
    expect(getPartnerAccountDocByRefMock).not.toHaveBeenCalled();
  });

  it("is ready (finding #16) when a non-NEW_ACCOUNT decision has no ref but the Lead has a confirmed platform - never fabricated, uses real captured identity", async () => {
    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: true });
    const result = await evaluateLeadReadiness(fullyReadyLead({ platform: "Instagram", assetDecision: { decision: "MAINTAIN_EXISTING", decidedAt: "2026-01-01T00:00:00.000Z", decidedByUserRef: "ref-1" } }));
    expect(result.blockers.map((b) => b.code)).not.toContain("ASSET_DECISION_INVALID");
    expect(getPartnerAccountDocByRefMock).not.toHaveBeenCalled();
  });

  it("blocks (ASSET_DECISION_INVALID) when the referenced Partner Account no longer exists - both MAINTAIN_EXISTING and TRANSFER_AND_MAINTAIN", async () => {
    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: true });
    getPartnerAccountDocByRefMock.mockResolvedValue(null);

    const maintain = await evaluateLeadReadiness(
      fullyReadyLead({ assetDecision: { decision: "MAINTAIN_EXISTING", existingPartnerAccountRef: "gone-account", decidedAt: "2026-01-01T00:00:00.000Z", decidedByUserRef: "ref-1" } }),
    );
    expect(maintain.blockers.map((b) => b.code)).toContain("ASSET_DECISION_INVALID");

    const transfer = await evaluateLeadReadiness(
      fullyReadyLead({ assetDecision: { decision: "TRANSFER_AND_MAINTAIN", existingPartnerAccountRef: "gone-account", decidedAt: "2026-01-01T00:00:00.000Z", decidedByUserRef: "ref-1" } }),
    );
    expect(transfer.blockers.map((b) => b.code)).toContain("ASSET_DECISION_INVALID");
  });

  it("is ready when the asset decision references a Partner Account that genuinely exists", async () => {
    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: true });
    getPartnerAccountDocByRefMock.mockResolvedValue({ uid: "acct-1" });
    const result = await evaluateLeadReadiness(
      fullyReadyLead({ assetDecision: { decision: "MAINTAIN_EXISTING", existingPartnerAccountRef: "real-account", decidedAt: "2026-01-01T00:00:00.000Z", decidedByUserRef: "ref-1" } }),
    );
    expect(result.blockers.map((b) => b.code)).not.toContain("ASSET_DECISION_INVALID");
    expect(result.ready).toBe(true);
  });

  it("blocks when no manager is assigned, and separately when the assigned manager is no longer active", async () => {
    const noManager = await evaluateLeadReadiness(fullyReadyLead({ managerUid: null }));
    expect(noManager.blockers.map((b) => b.code)).toContain("MANAGER_MISSING");

    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: false });
    const inactiveManager = await evaluateLeadReadiness(fullyReadyLead());
    expect(inactiveManager.blockers.map((b) => b.code)).toContain("MANAGER_INACTIVE");

    getUserDocMock.mockResolvedValue(null);
    const missingManagerDoc = await evaluateLeadReadiness(fullyReadyLead());
    expect(missingManagerDoc.blockers.map((b) => b.code)).toContain("MANAGER_INACTIVE");
  });

  it("blocks when the conversion-critical KYC package is incomplete", async () => {
    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: true });
    const result = await evaluateLeadReadiness(fullyReadyLead({ kycPackageComplete: false }));
    expect(result.blockers.map((b) => b.code)).toContain("KYC_INCOMPLETE");
  });

  it("blocks on an unresolved or confirmed duplicate, but only warns on a possible one", async () => {
    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: true });
    const now = "2026-01-01T00:00:00.000Z";

    expect((await evaluateLeadReadiness(fullyReadyLead({ duplicateCheck: null }))).blockers.map((b) => b.code)).toContain("DUPLICATE_UNRESOLVED");
    expect((await evaluateLeadReadiness(fullyReadyLead({ duplicateCheck: { status: "unknown", matches: [], checkedAt: now } }))).blockers.map((b) => b.code)).toContain("DUPLICATE_UNRESOLVED");
    expect((await evaluateLeadReadiness(fullyReadyLead({ duplicateCheck: { status: "confirmed", matches: [], checkedAt: now } }))).blockers.map((b) => b.code)).toContain("DUPLICATE_CONFIRMED");

    const possible = await evaluateLeadReadiness(fullyReadyLead({ duplicateCheck: { status: "possible", matches: [], checkedAt: now } }));
    expect(possible.blockers.map((b) => b.code)).not.toContain("DUPLICATE_CONFIRMED");
    expect(possible.blockers.map((b) => b.code)).not.toContain("DUPLICATE_UNRESOLVED");
    expect(possible.warnings.map((w) => w.code)).toContain("DUPLICATE_POSSIBLE");
  });

  it("returns blockers and warnings as separate lists, never merged", async () => {
    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: true });
    const result = await evaluateLeadReadiness(fullyReadyLead({ duplicateCheck: { status: "possible", matches: [], checkedAt: "2026-01-01T00:00:00.000Z" } }));
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("blocks progression (PHONE_MISSING) when phone is absent, even with a valid email on file - finding #26", async () => {
    getUserDocMock.mockResolvedValue({ uid: "manager-uid", active: true });
    const result = await evaluateLeadReadiness(fullyReadyLead({ phone: null }));
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain("PHONE_MISSING");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgreementWorkspaceRowDto } from "@/server/finance-agreements/workspace-dto";

import { agreementDetailHref, agreementDraftHref, initialsOfName, NO_EXTRACTION_TEXT, NOT_SET_TEXT, primaryActionHref, toWorkspaceRowView, unresolvedFieldsText } from "./workspace-view-model";

const REF = "agr_0123456789abcdef0123";

function row(overrides: Partial<AgreementWorkspaceRowDto> = {}): AgreementWorkspaceRowDto {
  return {
    agreementRef: REF,
    counterparty: { type: "PARTNER", ref: "partner-1", displayName: "Aarav Sharma", platformScope: ["instagram", "youtube"] },
    currentVersion: 2,
    openVersion: null,
    lifecycle: "ACTIVE",
    awaitingActivation: false,
    agreementNumber: "AGR-2026-014",
    agreementType: "FIXED_PLUS_INCENTIVE",
    effectiveFrom: "2026-09-01",
    effectiveTo: "2027-08-31",
    sourceMode: "MIXED",
    kyc: { state: "AVAILABLE", components: { pan: "PRESENT", aadhaar: "PRESENT", gst: "NOT_APPLICABLE", bank: "PRESENT" } },
    extractionStatus: "EXTRACTED",
    unresolvedFieldCount: 0,
    hasDiscrepancy: false,
    lastUpdatedAt: "2026-09-21T10:00:00.000Z",
    primaryAction: { kind: "OPEN", version: 2 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T13:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

describe("hrefs", () => {
  it("encodes the ref in detail links", () => {
    expect(agreementDetailHref(REF)).toBe(`/finance/agreements/${REF}`);
    expect(agreementDetailHref("a/b c")).toBe("/finance/agreements/a%2Fb%20c");
    expect(agreementDetailHref(REF, { tab: "versions" })).toBe(`/finance/agreements/${REF}?tab=versions`);
  });

  it("resumes a draft with agreementRef and version", () => {
    expect(agreementDraftHref(REF, 3)).toBe(`/finance/agreements/new?agreementRef=${REF}&version=3`);
    expect(agreementDraftHref(REF, null)).toBe(`/finance/agreements/new?agreementRef=${REF}`);
    expect(agreementDraftHref(REF, 0)).toBe(`/finance/agreements/new?agreementRef=${REF}`);
  });

  it("maps every primary action kind to its destination", () => {
    const base = { agreementRef: REF, openVersion: 4 };
    expect(primaryActionHref({ ...base, kind: "CONTINUE_DRAFT", version: 4 })).toBe(`/finance/agreements/new?agreementRef=${REF}&version=4`);
    expect(primaryActionHref({ ...base, kind: "CONTINUE_DRAFT", version: null })).toBe(`/finance/agreements/new?agreementRef=${REF}&version=4`);
    expect(primaryActionHref({ ...base, kind: "REVIEW", version: 4 })).toBe(`/finance/agreements/${REF}`);
    expect(primaryActionHref({ ...base, kind: "OPEN", version: 2 })).toBe(`/finance/agreements/${REF}`);
    expect(primaryActionHref({ ...base, kind: "CREATE_REVISION", version: null })).toBe(`/finance/agreements/${REF}?tab=versions`);
  });
});

describe("toWorkspaceRowView", () => {
  it("maps a Partner row", () => {
    const view = toWorkspaceRowView(row());
    expect(view).toMatchObject({
      key: REF,
      counterpartyName: "Aarav Sharma",
      counterpartyType: "PARTNER",
      counterpartyTypeLabel: "Partner",
      platforms: ["Instagram", "YouTube"],
      reference: REF,
      agreementNumber: "AGR-2026-014",
      versionLabel: "Version 2",
      revisionNote: null,
      lifecycle: { label: "Active" },
      effective: "1 Sep 2026 – 31 Aug 2027",
      commercialType: "Fixed + incentive",
      kyc: { label: "Available" },
      extraction: { label: "Extracted" },
      unresolvedText: "No unresolved fields",
      detailHref: `/finance/agreements/${REF}`,
    });
    expect(view.primary).toMatchObject({ kind: "OPEN", label: "Open", href: `/finance/agreements/${REF}`, emphasis: false });
    expect(view.primary.ariaLabel).toBe("Open - Aarav Sharma, Agreement AGR-2026-014");
    expect(view.lastUpdated).toBe("3h ago");
  });

  it("shows no platform chips for a Vendor, whatever the scope holds", () => {
    const view = toWorkspaceRowView(row({ counterparty: { type: "VENDOR", ref: "vendor-1", displayName: "Acme Media", platformScope: ["instagram"] } }));
    expect(view.platforms).toEqual([]);
    expect(view.counterpartyTypeLabel).toBe("Vendor");
  });

  it("uses explicit fallbacks instead of guessing for missing facts", () => {
    const view = toWorkspaceRowView(row({ agreementNumber: null, agreementType: null, effectiveFrom: null, effectiveTo: null, extractionStatus: null, sourceMode: null }));
    expect(view.agreementNumber).toBeNull();
    expect(view.commercialType).toBe(NOT_SET_TEXT);
    expect(view.commercialTypeSet).toBe(false);
    expect(view.effective).toBe(NOT_SET_TEXT);
    expect(view.extraction).toBeNull();
    expect(view.extractionText).toBe(NO_EXTRACTION_TEXT);
    expect(view.primary.ariaLabel).toContain(REF);
  });

  it("Step 14C: a DRAFT Agreement whose open version is confirmed reads 'Confirmed · awaiting activation' (never 'Draft'); the lifecycle filter vocabulary is untouched", () => {
    const view = toWorkspaceRowView(row({ lifecycle: "DRAFT", awaitingActivation: true, openVersion: 1, currentVersion: 1, primaryAction: { kind: "REVIEW", version: 1 } }));
    expect(view.lifecycle).toEqual({ label: "Confirmed · awaiting activation", tone: "blue" });
    expect(view.primary.label).toBe("Review");
    // an ACTIVE Agreement is never re-worded, even if a revision is awaiting activation (awaitingActivation is false there by definition)
    expect(toWorkspaceRowView(row({ lifecycle: "ACTIVE", awaitingActivation: false, openVersion: 2, currentVersion: 1 })).lifecycle.label).toBe("Active");
  });

  it("a Draft with unresolved fields continues the draft, emphasized", () => {
    const view = toWorkspaceRowView(row({ lifecycle: "DRAFT", openVersion: 1, currentVersion: 1, unresolvedFieldCount: 4, hasDiscrepancy: true, extractionStatus: "PARTIAL", primaryAction: { kind: "CONTINUE_DRAFT", version: 1 } }));
    expect(view.lifecycle.label).toBe("Draft");
    expect(view.unresolvedText).toBe("4 unresolved fields");
    expect(view.unresolvedCount).toBe(4);
    expect(view.extraction).toMatchObject({ label: "Partial", tone: "orange" });
    expect(view.primary).toMatchObject({ label: "Continue draft", emphasis: true, href: `/finance/agreements/new?agreementRef=${REF}&version=1` });
    expect(view.revisionNote).toBeNull();
  });

  it("notes an open revision while another version governs", () => {
    const view = toWorkspaceRowView(row({ openVersion: 3, currentVersion: 2, primaryAction: { kind: "REVIEW", version: 3 } }));
    expect(view.revisionNote).toBe("Revision open: version 3");
    expect(view.primary.label).toBe("Review");
    expect(view.primary.href).toBe(`/finance/agreements/${REF}`);
  });

  it("Create revision opens the Versions tab", () => {
    const view = toWorkspaceRowView(row({ primaryAction: { kind: "CREATE_REVISION", version: null } }));
    expect(view.primary).toMatchObject({ label: "Create revision", href: `/finance/agreements/${REF}?tab=versions`, emphasis: false });
  });

  it("KYC is status only: a restricted state renders the Restricted chip and no component data", () => {
    const view = toWorkspaceRowView(row({ kyc: { state: "RESTRICTED", components: { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" } } }));
    expect(view.kyc.label).toBe("Restricted");
    expect(JSON.stringify(view)).not.toMatch(/components|"pan"|"aadhaar"|"bank"/);
  });

  it("never carries scope internals or identity values through the view", () => {
    const json = JSON.stringify(toWorkspaceRowView(row()));
    expect(json).not.toMatch(/ownerUid|regionIds|teamIds|partnerUid|vendorUid|storage|gstin|panNumber|ifsc|accountNumber/i);
  });

  it("falls back to a neutral name when the live name is blank", () => {
    expect(toWorkspaceRowView(row({ counterparty: { type: "PARTNER", ref: "p", displayName: "   ", platformScope: [] } })).counterpartyName).toBe("Unnamed counterparty");
  });
});

describe("small helpers", () => {
  it("pluralizes unresolved fields", () => {
    expect(unresolvedFieldsText(0)).toBe("No unresolved fields");
    expect(unresolvedFieldsText(1)).toBe("1 unresolved field");
    expect(unresolvedFieldsText(12)).toBe("12 unresolved fields");
  });

  it("derives avatar initials safely", () => {
    expect(initialsOfName("Aarav Sharma")).toBe("AS");
    expect(initialsOfName("acme")).toBe("A");
    expect(initialsOfName("   ")).toBe("?");
    expect(initialsOfName("Ünal  Çelik Ay")).toBe("ÜÇ");
  });
});

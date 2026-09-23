import { describe, expect, it } from "vitest";

import type { PayableDetailDto, PayableEventDto, PayablePermissionsDto } from "@/server/finance-payables/client-dto";

import { amountPreviewText, detailActionVisibility, detailHeaderView, historyRows, nextVersionWording, parseDetailTab, readinessView, summaryRows } from "./detail-view";

function permissions(overrides: Partial<PayablePermissionsDto> = {}): PayablePermissionsDto {
  return { canView: true, canManage: true, canApprove: true, canAdjust: true, canVoid: true, canViewAmounts: true, ...overrides };
}

function detail(overrides: Partial<PayableDetailDto["head"]> = {}, versionOverrides: Partial<NonNullable<PayableDetailDto["selectedVersion"]>> = {}): PayableDetailDto {
  const head: PayableDetailDto["head"] = {
    payableRef: "pay_00000000000000000001",
    counterparty: { type: "PARTNER", ref: "partner-1", displayName: "Nila Talks" },
    commercialPeriod: { periodKey: "2026-03", periodStart: "2026-03-01", periodEnd: "2026-03-31" },
    currency: "INR",
    status: "DRAFT",
    sourceType: "PARTNER_REVIEW",
    agreementRef: "agr_abc",
    agreementVersion: 2,
    reviewRef: "pr_xyz",
    reviewVersion: 3,
    latestVersion: 1,
    readyVersion: null,
    readyAt: null,
    readyByUserRef: null,
    voidedAt: null,
    voidedByUserRef: null,
    voidReason: null,
    docVersion: 1,
    totalAmountMinorSigned: 5000000,
    determinationState: "DETERMINISTIC",
    openReviewCount: 0,
    createdAt: "2026-03-01T00:00:00.000Z",
    createdByUserRef: "user-1",
    updatedAt: "2026-03-02T00:00:00.000Z",
    updatedByUserRef: "user-1",
    ...overrides,
  };
  return {
    head,
    versions: [],
    hasMoreVersions: false,
    selectedVersion: {
      version: 1,
      changeKind: "created",
      reason: null,
      currency: "INR",
      totalAmountMinorSigned: 5000000,
      determinationState: "DETERMINISTIC",
      unresolved: [],
      openReviewCodes: [],
      warnings: [],
      lines: [{ lineRef: "pl_1", label: "Fixed component", category: "BASE_FIXED", amountMinorSigned: 5000000, source: "AGREEMENT", sourceRef: "agr_abc@2", reason: "Fixed component", actorUserRef: null, actorAt: null, resolvesCode: null }],
      snapshot: {} as never,
      createdAt: "2026-03-01T00:00:00.000Z",
      createdByUserRef: "user-1",
      ...versionOverrides,
    },
    amountsVisible: true,
  };
}

describe("detailHeaderView", () => {
  it("titles the page with the counterparty display name and names the payable ref + period below", () => {
    const view = detailHeaderView(detail().head);
    expect(view.title).toBe("Nila Talks");
    expect(view.secondary).toBe("pay_00000000000000000001 · March 2026");
  });

  it("falls back to the ref when no display name is known", () => {
    const view = detailHeaderView(detail({ counterparty: { type: "PARTNER", ref: "partner-1", displayName: null } }).head);
    expect(view.title).toBe("partner-1");
  });
});

describe("detailActionVisibility", () => {
  it("DRAFT: Edit / Ready for invoice / Void follow the exact server permissions", () => {
    expect(detailActionVisibility(detail({ status: "DRAFT" }).head, permissions())).toEqual({ canEdit: true, canMarkReady: true, canVoid: true, readOnly: false });
    expect(detailActionVisibility(detail({ status: "DRAFT" }).head, permissions({ canManage: false, canApprove: false, canVoid: false }))).toEqual({ canEdit: false, canMarkReady: false, canVoid: false, readOnly: false });
  });

  it("READY_FOR_INVOICE: never editable (no silent reopen), Void still follows permission", () => {
    const view = detailActionVisibility(detail({ status: "READY_FOR_INVOICE" }).head, permissions());
    expect(view.canEdit).toBe(false);
    expect(view.canMarkReady).toBe(false);
    expect(view.canVoid).toBe(true);
    expect(view.readOnly).toBe(false);
  });

  it("VOID: fully read-only regardless of permissions", () => {
    const view = detailActionVisibility(detail({ status: "VOID" }).head, permissions());
    expect(view).toEqual({ canEdit: false, canMarkReady: false, canVoid: false, readOnly: true });
  });
});

describe("summaryRows", () => {
  it("includes every required field with human labels, never raw camelCase", () => {
    const rows = summaryRows(detail());
    const labels = rows.map((row) => row.label);
    expect(labels).toEqual(["Counterparty", "Counterparty type", "Commercial period", "Agreement", "Review / source", "Currency", "Determination", "Created", "Updated"]);
    expect(rows.find((row) => row.label === "Agreement")?.value).toBe("agr_abc · v2");
  });
});

describe("readinessView", () => {
  it("is eligible for invoice when DRAFT, no open review items, and a non-empty non-negative breakdown", () => {
    const view = readinessView(detail(), null);
    expect(view.eligibleForInvoice).toBe(true);
    expect(view.sourceRevisionState).toBeNull();
  });

  it("is not eligible when open review items remain", () => {
    const view = readinessView(detail({ openReviewCount: 1 }), null);
    expect(view.eligibleForInvoice).toBe(false);
  });

  it("surfaces the source revision state only when it is not CURRENT", () => {
    const current = readinessView(detail(), { payableRef: "pay_1", state: "CURRENT", message: "x", pinned: { agreementRef: "a", agreementVersion: 1, reviewRef: null, reviewVersion: null }, current: null });
    expect(current.sourceRevisionState).toBeNull();
    const revised = readinessView(detail(), { payableRef: "pay_1", state: "AGREEMENT_REVISION_AVAILABLE", message: "x", pinned: { agreementRef: "a", agreementVersion: 1, reviewRef: null, reviewVersion: null }, current: { agreementRef: "a", agreementVersion: 2, reviewRef: null, reviewVersion: null } });
    expect(revised.sourceRevisionState).toBe("AGREEMENT_REVISION_AVAILABLE");
  });
});

describe("amountPreviewText", () => {
  it("shows 'Hidden' when amounts are not visible", () => {
    expect(amountPreviewText({ ...detail(), amountsVisible: false })).toBe("Hidden");
  });

  it("formats the head total when amounts are visible", () => {
    expect(amountPreviewText(detail())).toBe("₹50,000");
  });
});

describe("historyRows", () => {
  it("maps events to human event labels and pulls the reason (or label) from metadata", () => {
    const events: PayableEventDto[] = [
      { kind: "PAYABLE_CREATED", version: 1, actorUserRef: "user-1", metadata: null, createdAt: "2026-03-01T00:00:00.000Z" },
      { kind: "MANUAL_ADJUSTMENT_ADDED", version: 2, actorUserRef: "user-2", metadata: { reason: "Advance recovery" }, createdAt: "2026-03-02T00:00:00.000Z" },
    ];
    const rows = historyRows(events);
    expect(rows[0]).toMatchObject({ event: "Created", version: 1, actor: "user-1", reasonOrMetadata: "—" });
    expect(rows[1]).toMatchObject({ event: "Manual adjustment added", version: 2, actor: "user-2", reasonOrMetadata: "Advance recovery" });
  });
});

describe("nextVersionWording", () => {
  it("names the exact next version number", () => {
    expect(nextVersionWording(1)).toBe("Saving creates Payable version v2.");
  });
});

describe("parseDetailTab", () => {
  it("defaults to summary for anything unrecognized", () => {
    expect(parseDetailTab(undefined)).toBe("summary");
    expect(parseDetailTab("bogus")).toBe("summary");
  });

  it("accepts each known tab key", () => {
    expect(parseDetailTab("breakdown")).toBe("breakdown");
    expect(parseDetailTab("source")).toBe("source");
    expect(parseDetailTab("history")).toBe("history");
  });
});

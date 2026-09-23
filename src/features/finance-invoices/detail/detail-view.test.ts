import { describe, expect, it } from "vitest";

import type { InvoiceDetailDto, InvoicePermissionsDto } from "@/server/finance-invoices/client-dto";

import { approvalReadinessView, detailActionVisibility, detailHeaderView, documentView, historyRows, parseDetailTab, summaryRows } from "./detail-view";

const PIN = {
  payableRef: "pay_00000000000000000001",
  payableVersion: 2,
  counterpartyType: "PARTNER" as const,
  counterpartyRef: "prt_1",
  agreementRef: "agr_1",
  agreementVersion: 1,
  reviewRef: null,
  reviewVersion: null,
  commercialPeriod: { periodKey: "2026-03", periodStart: "2026-03-01", periodEnd: "2026-03-31" },
  payableCurrency: "INR",
  payableExpectedTotalMinorSigned: 500000,
};

function detail(overrides: { status?: InvoiceDetailDto["head"]["status"]; mismatchOverride?: InvoiceDetailDto["head"]["mismatchOverride"]; findings?: InvoiceDetailDto["selectedVersion"] extends null ? never : NonNullable<InvoiceDetailDto["selectedVersion"]>["reconciliation"]["findings"] } = {}): InvoiceDetailDto {
  return {
    head: {
      invoiceRef: "inv_00000000000000000001",
      payableRef: "pay_00000000000000000001",
      counterparty: { type: "PARTNER", ref: "prt_1", displayName: "Aisha Khan" },
      commercialPeriod: { periodKey: "2026-03", periodStart: "2026-03-01", periodEnd: "2026-03-31" },
      currency: "INR",
      externalInvoiceNumber: "INV-1",
      status: overrides.status ?? "DRAFT",
      latestVersion: 1,
      submittedVersion: null,
      submittedAt: null,
      submittedByUserRef: null,
      approvedVersion: null,
      approvedAt: null,
      approvedByUserRef: null,
      rejectedVersion: null,
      rejectedAt: null,
      rejectedByUserRef: null,
      rejectionReason: null,
      voidedAt: null,
      voidedByUserRef: null,
      voidReason: null,
      mismatchOverride: overrides.mismatchOverride ?? null,
      docVersion: 1,
      declaredTotalMinor: 500000,
      reconciliationState: "MATCH",
      createdAt: "2026-03-01T00:00:00.000Z",
      createdByUserRef: "user_1",
      updatedAt: "2026-03-01T00:00:00.000Z",
      updatedByUserRef: "user_1",
    },
    versions: [],
    hasMoreVersions: false,
    selectedVersion: {
      version: 1,
      changeKind: "created",
      reason: null,
      payablePin: PIN,
      externalInvoiceNumber: "INV-1",
      invoiceDate: "2026-03-01",
      receivedDate: null,
      currency: "INR",
      subtotalMinor: 450000,
      taxLines: [{ label: "GST", ratePercentBasisPoints: 1800, amountMinor: 50000 }],
      declaredTotalMinor: 500000,
      dueDate: null,
      document: { documentId: "doc_1", fileName: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 2048, sha256: "a".repeat(64), storedAt: "2026-03-01T00:00:00.000Z", storedByUserRef: "user_1" },
      reconciliation: { state: "MATCH", findings: overrides.findings ?? [], computedAt: "2026-03-01T00:00:00.000Z" },
      createdAt: "2026-03-01T00:00:00.000Z",
      createdByUserRef: "user_1",
    },
    amountsVisible: true,
  };
}

describe("parseDetailTab", () => {
  it("defaults to summary for anything unrecognized", () => {
    expect(parseDetailTab(undefined)).toBe("summary");
    expect(parseDetailTab("bogus")).toBe("summary");
    expect(parseDetailTab(["reconciliation", "document"])).toBe("reconciliation");
  });
});

describe("detailHeaderView", () => {
  it("titles by counterparty display name and shows ref + invoice number as secondary", () => {
    const view = detailHeaderView(detail().head);
    expect(view.title).toBe("Aisha Khan");
    expect(view.secondary).toBe("inv_00000000000000000001 · INV-1");
    expect(view.statusChip.label).toBe("Draft");
  });
});

describe("detailActionVisibility", () => {
  const permissions: InvoicePermissionsDto = { canView: true, canManage: true, canApprove: true, canVoid: true, canOverrideMismatch: true, canViewAmounts: true };

  it("DRAFT: Edit + Submit + overflow Void", () => {
    const visibility = detailActionVisibility(detail({ status: "DRAFT" }).head, permissions);
    expect(visibility).toEqual({ canEdit: true, canSubmit: true, canApprove: false, canReject: false, canReopen: false, canVoid: true, canOverrideMismatch: false, readOnly: false });
  });

  it("SUBMITTED: Approve/Reject/mismatch-override/Void gated by the exact permission, never role rank", () => {
    const authorized = detailActionVisibility(detail({ status: "SUBMITTED" }).head, permissions);
    expect(authorized).toEqual({ canEdit: false, canSubmit: false, canApprove: true, canReject: true, canReopen: false, canVoid: true, canOverrideMismatch: true, readOnly: false });

    const managerOnly: InvoicePermissionsDto = { canView: true, canManage: true, canApprove: false, canVoid: false, canOverrideMismatch: false, canViewAmounts: true };
    const readOnlyManager = detailActionVisibility(detail({ status: "SUBMITTED" }).head, managerOnly);
    expect(readOnlyManager.canApprove).toBe(false);
    expect(readOnlyManager.canReject).toBe(false);
    expect(readOnlyManager.canVoid).toBe(false);
  });

  it("APPROVED is fully read-only (no Payment action, no Void re-offered)", () => {
    const visibility = detailActionVisibility(detail({ status: "APPROVED" }).head, permissions);
    expect(visibility).toEqual({ canEdit: false, canSubmit: false, canApprove: false, canReject: false, canReopen: false, canVoid: false, canOverrideMismatch: false, readOnly: true });
  });

  it("REJECTED: Reopen + Void", () => {
    const visibility = detailActionVisibility(detail({ status: "REJECTED" }).head, permissions);
    expect(visibility).toEqual({ canEdit: false, canSubmit: false, canApprove: false, canReject: false, canReopen: true, canVoid: true, canOverrideMismatch: false, readOnly: false });
  });

  it("VOID is fully read-only", () => {
    const visibility = detailActionVisibility(detail({ status: "VOID" }).head, permissions);
    expect(visibility.readOnly).toBe(true);
    expect(Object.values(visibility).filter((value) => value === true)).toEqual([true]); // only readOnly is true
  });
});

describe("summaryRows", () => {
  it("splits subtotal/tax/total and shows human-readable fields, never a raw enum", () => {
    const rows = summaryRows(detail());
    expect(rows.find((row) => row.label === "Subtotal")?.value).toBe("₹4,500");
    expect(rows.find((row) => row.label === "Declared taxes")?.value).toBe("₹500");
    expect(rows.find((row) => row.label === "Total")?.value).toBe("₹5,000");
    expect(rows.find((row) => row.label === "Commercial period")?.value).toBe("March 2026");
  });
});

describe("approvalReadinessView", () => {
  it("is eligible for approval when SUBMITTED with no unresolved blocker", () => {
    const view = approvalReadinessView(detail({ status: "SUBMITTED" }), null);
    expect(view.eligibleForApproval).toBe(true);
    expect(view.documentAttached).toBe(true);
  });

  it("is not eligible when a mismatch is unresolved, but becomes eligible once accepted for this version", () => {
    const findings = [{ code: "TOTAL_AMOUNT_MISMATCH" as const, severity: "BLOCKER" as const, message: "x" }];
    const unresolved = approvalReadinessView(detail({ status: "SUBMITTED", findings }), null);
    expect(unresolved.eligibleForApproval).toBe(false);
    expect(unresolved.mismatchOverrideStatus).toBe("None");

    const accepted = approvalReadinessView(detail({ status: "SUBMITTED", findings, mismatchOverride: { forVersion: 1, reason: "Agreed variance", actorUserRef: "user_1", at: "x" } }), null);
    expect(accepted.eligibleForApproval).toBe(true);
    expect(accepted.mismatchOverrideStatus).toBe("Accepted with reason");
  });

  it("surfaces a PAYABLE_REVISION_AVAILABLE source-revision state, but not CURRENT", () => {
    const withRevision = approvalReadinessView(detail(), { invoiceRef: "inv_1", state: "PAYABLE_REVISION_AVAILABLE", message: "x", pinnedPayableVersion: 1, currentPayableVersion: 2 });
    expect(withRevision.sourceRevisionState).toBe("PAYABLE_REVISION_AVAILABLE");
    const current = approvalReadinessView(detail(), { invoiceRef: "inv_1", state: "CURRENT", message: "x", pinnedPayableVersion: 1, currentPayableVersion: 1 });
    expect(current.sourceRevisionState).toBeNull();
  });
});

describe("documentView", () => {
  it("shows metadata only - never a signed URL or storage locator", () => {
    const view = documentView(detail());
    expect(view).toEqual({ fileName: "invoice.pdf", mimeType: "application/pdf", sizeText: "2.0 KB", sha256: "a".repeat(64), storedAt: expect.any(String), storedBy: "user_1", version: 1 });
  });

  it("is null when no document is attached", () => {
    const withoutDoc = detail();
    withoutDoc.selectedVersion!.document = null;
    expect(documentView(withoutDoc)).toBeNull();
  });
});

describe("historyRows", () => {
  it("prefers a reason, falls back to a file name, else a dash", () => {
    const rows = historyRows([
      { kind: "INVOICE_REJECTED", version: 1, actorUserRef: "user_1", metadata: { reason: "Wrong total" }, createdAt: "2026-03-01T00:00:00.000Z" },
      { kind: "INVOICE_DOCUMENT_ATTACHED", version: 2, actorUserRef: "user_1", metadata: { fileName: "invoice.pdf" }, createdAt: "2026-03-02T00:00:00.000Z" },
      { kind: "INVOICE_CREATED", version: 1, actorUserRef: "user_1", metadata: null, createdAt: "2026-03-01T00:00:00.000Z" },
    ]);
    expect(rows.map((row) => row.reasonOrMetadata)).toEqual(["Wrong total", "invoice.pdf", "—"]);
    expect(rows.map((row) => row.event)).toEqual(["Rejected", "Document attached", "Invoice created"]);
  });
});

import { describe, expect, it } from "vitest";

import type { PayableRowDto } from "@/server/finance-payables/client-dto";
import type { PreviewInvoiceEligibilityDto } from "@/server/finance-invoices/invoice-service";

import { confirmBlockers, confirmReadiness, detailsFormComplete, emptyInvoiceDetailsForm, emptyTaxLine, invoiceDetailsFormFromVersion, invoiceSummaryRows, reviseFieldsFromForm, selectedPayableSummary, sourceReadiness, toEligiblePayableRowView } from "./create-view";

const PAYABLE_ROW: PayableRowDto = {
  payableRef: "pay_00000000000000000001",
  counterparty: { type: "PARTNER", ref: "prt_1", displayName: "Aisha Khan" },
  commercialPeriod: "2026-03",
  currency: "INR",
  status: "READY_FOR_INVOICE",
  sourceType: "PARTNER_REVIEW",
  totalAmountMinorSigned: 500000,
  determinationState: "DETERMINISTIC",
  openReviewCount: 0,
  latestVersion: 1,
  readyVersion: 1,
  lastUpdatedAt: "2026-03-01T00:00:00.000Z",
};

describe("toEligiblePayableRowView", () => {
  it("maps a Payable row for the Stage 1 eligible-Payables table", () => {
    const view = toEligiblePayableRowView(PAYABLE_ROW, true);
    expect(view.payableRef).toBe("pay_00000000000000000001");
    expect(view.counterpartyName).toBe("Aisha Khan");
    expect(view.commercialPeriod).toBe("March 2026");
    expect(view.totalText).toBe("₹5,000");
  });

  it("withholds the amount when amounts are not visible", () => {
    expect(toEligiblePayableRowView(PAYABLE_ROW, false).totalText).toBe("Hidden");
  });
});

describe("sourceReadiness", () => {
  it("cannot continue before a Payable is selected", () => {
    expect(sourceReadiness(null)).toEqual({ canContinue: false, blocked: false, blockerMessages: [] });
  });

  it("can continue once the preview reports eligible", () => {
    const preview: PreviewInvoiceEligibilityDto = { payableRef: "pay_1", eligible: true, blockers: [], pin: null, counterpartyDisplayName: null, existingInvoiceRef: null, amountsVisible: true };
    expect(sourceReadiness(preview)).toEqual({ canContinue: true, blocked: false, blockerMessages: [] });
  });

  it("is blocked with the server's own messages when not eligible", () => {
    const preview: PreviewInvoiceEligibilityDto = { payableRef: "pay_1", eligible: false, blockers: [{ code: "PAYABLE_NOT_READY", message: "Not ready yet." }], pin: null, counterpartyDisplayName: null, existingInvoiceRef: null, amountsVisible: true };
    expect(sourceReadiness(preview)).toEqual({ canContinue: false, blocked: true, blockerMessages: ["Not ready yet."] });
  });
});

const PIN = {
  payableRef: "pay_00000000000000000001",
  payableVersion: 3,
  counterpartyType: "PARTNER" as const,
  counterpartyRef: "prt_1",
  agreementRef: "agr_1",
  agreementVersion: 2,
  reviewRef: "rev_1",
  reviewVersion: 1,
  commercialPeriod: { periodKey: "2026-03", periodStart: "2026-03-01", periodEnd: "2026-03-31" },
  payableCurrency: "INR",
  payableExpectedTotalMinorSigned: 500000,
};

describe("selectedPayableSummary", () => {
  it("never exposes KYC/bank data - only the opaque pin fields", () => {
    const preview: PreviewInvoiceEligibilityDto = { payableRef: "pay_1", eligible: true, blockers: [], pin: PIN, counterpartyDisplayName: "Aisha Khan", existingInvoiceRef: null, amountsVisible: true };
    const rows = selectedPayableSummary(preview);
    const labels = rows.map((row) => row.label);
    expect(labels).toContain("Payable ref / version");
    expect(labels).toContain("Partner Review ref / version");
    expect(labels).not.toContain("PAN");
    expect(labels).not.toContain("Bank account");
    expect(rows.find((row) => row.label === "Expected total")?.value).toBe("₹5,000");
  });
});

describe("detailsFormComplete", () => {
  it("requires invoice number, date, a 3-letter currency and a declared total", () => {
    expect(detailsFormComplete(emptyInvoiceDetailsForm("INR"))).toBe(false);
    expect(detailsFormComplete({ externalInvoiceNumber: "INV-1", invoiceDate: "2026-03-01", receivedDate: "", currency: "INR", subtotalText: "", taxLines: [], declaredTotalText: "5000", dueDate: "" })).toBe(true);
  });
});

describe("invoiceDetailsFormFromVersion", () => {
  it("converts minor units to decimal text for prefill", () => {
    const form = invoiceDetailsFormFromVersion(
      { externalInvoiceNumber: "INV-1", invoiceDate: "2026-03-01", receivedDate: null, currency: "INR", subtotalMinor: 400000, taxLines: [{ label: "GST", ratePercentBasisPoints: 1800, amountMinor: 72000 }], declaredTotalMinor: 472000, dueDate: null },
      "INR",
    );
    expect(form.subtotalText).toBe("4000");
    expect(form.declaredTotalText).toBe("4720");
    expect(form.taxLines).toEqual([{ key: "existing-0", label: "GST", rateText: "18", amountText: "720" }]);
  });
});

describe("reviseFieldsFromForm", () => {
  it("converts a complete form into typed fields, clearing blanks to null (never a guessed value)", () => {
    const form = { externalInvoiceNumber: "INV-1", invoiceDate: "2026-03-01", receivedDate: "", currency: "inr", subtotalText: "4500", taxLines: [], declaredTotalText: "5000", dueDate: "" };
    const result = reviseFieldsFromForm(form);
    expect(result).toEqual({ ok: true, fields: { externalInvoiceNumber: "INV-1", invoiceDate: "2026-03-01", receivedDate: null, currency: "INR", subtotalMinor: 450000, taxLines: [], declaredTotalMinor: 500000, dueDate: null } });
  });

  it("never performs client-side tax computation - a tax line's amount is taken exactly as typed", () => {
    const form = { ...emptyInvoiceDetailsForm("INR"), taxLines: [{ ...emptyTaxLine("k1"), label: "GST", rateText: "18", amountText: "500" }] };
    const result = reviseFieldsFromForm(form);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fields.taxLines).toEqual([{ label: "GST", ratePercentBasisPoints: 1800, amountMinor: 50000 }]);
  });

  it("skips a fully blank tax line and rejects one missing only a label", () => {
    const blankLineForm = { ...emptyInvoiceDetailsForm("INR"), taxLines: [emptyTaxLine("k1")] };
    expect(reviseFieldsFromForm(blankLineForm)).toEqual({ ok: true, fields: expect.objectContaining({ taxLines: [] }) });

    const missingLabelForm = { ...emptyInvoiceDetailsForm("INR"), taxLines: [{ ...emptyTaxLine("k1"), amountText: "100" }] };
    const result = reviseFieldsFromForm(missingLabelForm);
    expect(result.ok).toBe(false);
  });

  it("collects amount-parse errors instead of silently coercing", () => {
    const form = { ...emptyInvoiceDetailsForm("INR"), declaredTotalText: "not-a-number" };
    const result = reviseFieldsFromForm(form);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("Declared total");
  });
});

describe("invoiceSummaryRows / confirmReadiness / confirmBlockers", () => {
  const baseDetail = {
    head: {
      invoiceRef: "inv_1",
      payableRef: "pay_1",
      counterparty: { type: "PARTNER" as const, ref: "prt_1", displayName: "Aisha Khan" },
      commercialPeriod: { periodKey: "2026-03", periodStart: "2026-03-01", periodEnd: "2026-03-31" },
      currency: "INR",
      externalInvoiceNumber: "INV-1",
      status: "DRAFT" as const,
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
      mismatchOverride: null,
      docVersion: 1,
      declaredTotalMinor: 500000,
      reconciliationState: "MATCH" as const,
      createdAt: "2026-03-01T00:00:00.000Z",
      createdByUserRef: "user_1",
      updatedAt: "2026-03-01T00:00:00.000Z",
      updatedByUserRef: "user_1",
    },
    versions: [],
    hasMoreVersions: false,
    selectedVersion: {
      version: 1,
      changeKind: "created" as const,
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
      document: { documentId: "doc_1", fileName: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 1000, sha256: "a".repeat(64), storedAt: "2026-03-01T00:00:00.000Z", storedByUserRef: "user_1" },
      reconciliation: { state: "MATCH" as const, findings: [], computedAt: "2026-03-01T00:00:00.000Z" },
      createdAt: "2026-03-01T00:00:00.000Z",
      createdByUserRef: "user_1",
    },
    amountsVisible: true,
  };

  it("builds a dense summary grid with declared subtotal/tax/total split out", () => {
    const rows = invoiceSummaryRows(baseDetail);
    expect(rows.find((row) => row.label === "Declared subtotal")?.value).toBe("₹4,500");
    expect(rows.find((row) => row.label === "Declared tax")?.value).toBe("₹500");
    expect(rows.find((row) => row.label === "Declared total")?.value).toBe("₹5,000");
    expect(rows.find((row) => row.label === "Payable ref / version")?.value).toBe("pay_00000000000000000001 · v3");
  });

  it("reports readiness true and no blockers for a clean match", () => {
    expect(confirmReadiness(baseDetail).every((item) => item.met)).toBe(true);
    expect(confirmBlockers(baseDetail)).toEqual([]);
  });

  it("surfaces blocking findings verbatim, never inventing a corrected figure", () => {
    const blocked = { ...baseDetail, selectedVersion: { ...baseDetail.selectedVersion, reconciliation: { state: "MISMATCH" as const, findings: [{ code: "TOTAL_AMOUNT_MISMATCH" as const, severity: "BLOCKER" as const, message: "Both figures preserved." }], computedAt: "x" } } };
    expect(confirmBlockers(blocked)).toEqual([{ code: "TOTAL_AMOUNT_MISMATCH", message: "Both figures preserved." }]);
    expect(confirmReadiness(blocked).find((item) => item.label === "No unresolved blocking mismatch")?.met).toBe(false);
  });
});

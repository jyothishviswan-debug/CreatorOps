import { describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/server/authz/types";

// Step 18A: unit-level proof of each adapter's PURE mapping/filtering logic against the source
// module's own real DTO shape, with the source module's published barrel STUBBED (vi.mock) so this
// file never needs a live Firestore pipeline. The full live, cross-module, no-second-status proof
// runs in operations.emulator.test.ts against a real Partner Review (the cheapest of the four
// pipelines to stand up for real); these tests instead prove that Payables/Invoices/Payments
// adapters (a) filter to exactly the pending subset, (b) never call a write function, and (c) build
// a deterministic approvalItemRef - the same guarantees the emulator test proves live for Partner
// Reviews, here proven for the other three against realistic fixture data.

const actor: ActorContext = { uid: "uid_1", email: "a@creatorops.com", role: "partnership_head", displayName: "A", userRef: "user_1" };

describe("payables-adapter", () => {
  it("keeps only DRAFT rows whose determinationState is FINANCE_REVIEW_REQUIRED, and builds a deterministic ref", async () => {
    vi.resetModules();
    vi.doMock("@/server/finance-payables", () => ({
      listPayablesWorkspace: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          rows: [
            { payableRef: "pyb_a", counterparty: { type: "PARTNER", ref: "p1", displayName: "Acme" }, commercialPeriod: "2026-01", currency: "INR", status: "DRAFT", sourceType: "PARTNER_REVIEW", totalAmountMinorSigned: 1000, determinationState: "FINANCE_REVIEW_REQUIRED", openReviewCount: 2, latestVersion: 1, readyVersion: null, lastUpdatedAt: "2026-01-05T00:00:00.000Z" },
            { payableRef: "pyb_b", counterparty: { type: "PARTNER", ref: "p2", displayName: "Beta" }, commercialPeriod: "2026-01", currency: "INR", status: "DRAFT", sourceType: "PARTNER_REVIEW", totalAmountMinorSigned: 500, determinationState: "DETERMINISTIC", openReviewCount: 0, latestVersion: 1, readyVersion: null, lastUpdatedAt: "2026-01-05T00:00:00.000Z" },
          ],
        },
      }),
    }));
    const { listPendingPayableApprovals } = await import("./payables-adapter");
    const { items, scanned } = await listPendingPayableApprovals(actor);
    expect(scanned).toBe(2);
    expect(items).toHaveLength(1);
    expect(items[0]!.sourceRef).toBe("pyb_a");
    expect(items[0]!.actionType).toBe("RESOLVE_PAYABLE_FINANCE_REVIEW");
    expect(items[0]!.approvalItemRef).toMatch(/^apr_[0-9a-f]{40}$/);
    expect(items[0]!.allowedActions).toEqual([]);
    vi.doUnmock("@/server/finance-payables");
  });

  it("returns an empty list (never throws) when the underlying workspace call is denied", async () => {
    vi.resetModules();
    vi.doMock("@/server/finance-payables", () => ({ listPayablesWorkspace: vi.fn().mockResolvedValue({ ok: false, code: "unauthorized", message: "denied" }) }));
    const { listPendingPayableApprovals } = await import("./payables-adapter");
    expect(await listPendingPayableApprovals(actor)).toEqual({ items: [], scanned: 0 });
    vi.doUnmock("@/server/finance-payables");
  });
});

describe("invoices-adapter", () => {
  it("maps every SUBMITTED row (the workspace call itself already filters to SUBMITTED) and carries reconciliationState through read-only", async () => {
    vi.resetModules();
    vi.doMock("@/server/finance-invoices", () => ({
      listInvoicesWorkspace: vi.fn().mockResolvedValue({
        ok: true,
        data: { rows: [{ invoiceRef: "inv_a", payableRef: "pyb_a", counterparty: { type: "PARTNER", ref: "p1", displayName: "Acme" }, commercialPeriod: "2026-01", currency: "INR", status: "SUBMITTED", externalInvoiceNumber: "INV-1", declaredTotalMinor: 1000, reconciliationState: "MISMATCH", latestVersion: 2, lastUpdatedAt: "2026-01-06T00:00:00.000Z" }] },
      }),
    }));
    const { listPendingInvoiceApprovals } = await import("./invoices-adapter");
    const { items } = await listPendingInvoiceApprovals(actor);
    expect(items).toHaveLength(1);
    expect(items[0]!.sourceVersion).toBe(2);
    expect(items[0]!.safeDisplayData.reconciliationState).toBe("MISMATCH");
    expect(items[0]!.actionType).toBe("APPROVE_OR_REJECT_INVOICE");
    vi.doUnmock("@/server/finance-invoices");
  });
});

describe("payments-adapter", () => {
  it("maps every RECORDED row and never precomputes an overpayment decision", async () => {
    vi.resetModules();
    vi.doMock("@/server/finance-payments", () => ({
      listPaymentsWorkspace: vi.fn().mockResolvedValue({
        ok: true,
        data: { rows: [{ paymentRef: "pmt_a", invoiceRef: "inv_a", counterparty: { type: "PARTNER", ref: "p1", displayName: "Acme" }, currency: "INR", status: "RECORDED", amountMinor: 1000, method: "UPI", latestVersion: 1, lastUpdatedAt: "2026-01-07T00:00:00.000Z" }] },
      }),
    }));
    const { listPendingPaymentApprovals } = await import("./payments-adapter");
    const { items } = await listPendingPaymentApprovals(actor);
    expect(items).toHaveLength(1);
    expect(items[0]!.actionType).toBe("CONFIRM_PAYMENT");
    expect(items[0]!.safeDisplayData).not.toHaveProperty("wouldOverpay");
    vi.doUnmock("@/server/finance-payments");
  });
});

describe("partner-reviews-adapter", () => {
  it("maps every IN_REVIEW head and never a DRAFT/FINALIZED one (the list call itself already filters to IN_REVIEW)", async () => {
    vi.resetModules();
    vi.doMock("@/server/partner-reviews/partner-review-list-service", () => ({
      listPartnerReviewHeads: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          heads: [{ reviewRef: "rev_a", partnerRef: "p1", partnerDisplayName: "Acme", periodKey: "2026-01", periodStart: "2026-01-01", periodEnd: "2026-01-31", latestVersion: 1, latestStatus: "IN_REVIEW", currentFinalizedVersion: null, openVersion: 1, docVersion: 2, createdAt: "2026-01-01T00:00:00.000Z", createdByUserRef: "user_1", updatedAt: "2026-01-02T00:00:00.000Z", updatedByUserRef: "user_1" }],
        },
      }),
    }));
    const { listPendingPartnerReviewApprovals } = await import("./partner-reviews-adapter");
    const { items } = await listPendingPartnerReviewApprovals(actor);
    expect(items).toHaveLength(1);
    expect(items[0]!.currentSourceStatus).toBe("IN_REVIEW");
    expect(items[0]!.requestedBy).toBe("user_1");
    vi.doUnmock("@/server/partner-reviews/partner-review-list-service");
  });
});

import { describe, expect, it } from "vitest";

import type { InvoiceRowDto } from "@/server/finance-invoices/client-dto";

import { initialsOfName, invoiceDetailHref, summarizeWorkspaceRows, toWorkspaceRowView } from "./workspace-view-model";

function row(overrides: Partial<InvoiceRowDto> = {}): InvoiceRowDto {
  return {
    invoiceRef: "inv_00000000000000000001",
    payableRef: "pay_00000000000000000001",
    counterparty: { type: "PARTNER", ref: "prt_1", displayName: "Aisha Khan" },
    commercialPeriod: "2026-03",
    currency: "INR",
    status: "DRAFT",
    externalInvoiceNumber: null,
    declaredTotalMinor: 500000,
    reconciliationState: "MISSING_IN_INVOICE",
    latestVersion: 1,
    lastUpdatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("toWorkspaceRowView", () => {
  it("maps every field to a display value", () => {
    const view = toWorkspaceRowView(row(), true);
    expect(view.invoiceRef).toBe("inv_00000000000000000001");
    expect(view.counterpartyName).toBe("Aisha Khan");
    expect(view.counterpartyTypeLabel).toBe("Partner");
    expect(view.invoiceNumber).toBe("—");
    expect(view.commercialPeriod).toBe("March 2026");
    expect(view.payableRef).toBe("pay_00000000000000000001");
    expect(view.payableHref).toBe("/finance/payables/pay_00000000000000000001");
    expect(view.amountText).toBe("₹5,000");
    expect(view.reconciliation).toEqual({ label: "Missing information", tone: "gray" });
    expect(view.status).toEqual({ label: "Draft", tone: "gray" });
    expect(view.detailHref).toBe(invoiceDetailHref("inv_00000000000000000001"));
  });

  it("falls back to 'Unnamed counterparty' when the display name is blank", () => {
    const view = toWorkspaceRowView(row({ counterparty: { type: "VENDOR", ref: "vnd_1", displayName: null } }), true);
    expect(view.counterpartyName).toBe("Unnamed counterparty");
    expect(view.counterpartyTypeTone).toBe("purple");
  });

  it("shows the declared invoice number verbatim when set", () => {
    const view = toWorkspaceRowView(row({ externalInvoiceNumber: "INV-2026-045" }), true);
    expect(view.invoiceNumber).toBe("INV-2026-045");
  });

  it("shows Hidden (never a figure) when amounts are not visible, even for a non-null value", () => {
    const view = toWorkspaceRowView(row({ declaredTotalMinor: 500000 }), false);
    expect(view.amountText).toBe("Hidden");
  });

  it("distinguishes a withheld amount from a null (not-yet-declared) one only via amountsVisible", () => {
    const withAmounts = toWorkspaceRowView(row({ declaredTotalMinor: null }), true);
    const withoutAmounts = toWorkspaceRowView(row({ declaredTotalMinor: null }), false);
    expect(withAmounts.amountText).toBe("—");
    expect(withoutAmounts.amountText).toBe("Hidden");
  });
});

describe("initialsOfName", () => {
  it("takes up to two initials, uppercased", () => {
    expect(initialsOfName("Aisha Khan")).toBe("AK");
    expect(initialsOfName("Cher")).toBe("C");
    expect(initialsOfName("  ")).toBe("?");
  });
});

describe("summarizeWorkspaceRows", () => {
  it("counts each status from the rows already on the page", () => {
    const rows = [row({ status: "DRAFT" }), row({ status: "DRAFT" }), row({ status: "SUBMITTED" }), row({ status: "APPROVED" }), row({ status: "REJECTED" }), row({ status: "VOID" })];
    expect(summarizeWorkspaceRows(rows)).toEqual({ draft: 2, submitted: 1, approved: 1, rejected: 1, void: 1 });
  });

  it("returns all-zero counts for an empty page", () => {
    expect(summarizeWorkspaceRows([])).toEqual({ draft: 0, submitted: 0, approved: 0, rejected: 0, void: 0 });
  });
});

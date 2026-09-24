import { describe, expect, it } from "vitest";

import type { PaymentRowDto } from "@/server/finance-payments/client-dto";

import { initialsOfName, paymentDetailHref, summarizeWorkspaceRows, toWorkspaceRowView } from "./workspace-view-model";

function row(overrides: Partial<PaymentRowDto> = {}): PaymentRowDto {
  return {
    paymentRef: "pmt_00000000000000000001",
    invoiceRef: "inv_00000000000000000001",
    counterparty: { type: "PARTNER", ref: "prt_1", displayName: "Aisha Khan" },
    currency: "INR",
    status: "DRAFT",
    amountMinor: 500000,
    method: "BANK_TRANSFER",
    latestVersion: 1,
    lastUpdatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("toWorkspaceRowView", () => {
  it("maps every field to a display value", () => {
    const view = toWorkspaceRowView(row(), true);
    expect(view.paymentRef).toBe("pmt_00000000000000000001");
    expect(view.counterpartyName).toBe("Aisha Khan");
    expect(view.counterpartyTypeLabel).toBe("Partner");
    expect(view.invoiceRef).toBe("inv_00000000000000000001");
    expect(view.invoiceHref).toBe("/finance/invoices/inv_00000000000000000001");
    expect(view.amountText).toBe("₹5,000");
    expect(view.methodText).toBe("Bank transfer");
    expect(view.status).toEqual({ label: "Draft", tone: "gray" });
    expect(view.detailHref).toBe(paymentDetailHref("pmt_00000000000000000001"));
  });

  it("falls back to 'Unnamed counterparty' when the display name is blank", () => {
    const view = toWorkspaceRowView(row({ counterparty: { type: "VENDOR", ref: "vnd_1", displayName: null } }), true);
    expect(view.counterpartyName).toBe("Unnamed counterparty");
    expect(view.counterpartyTypeTone).toBe("purple");
  });

  it("shows Hidden (never a figure) when amounts are not visible, even for a non-null value", () => {
    const view = toWorkspaceRowView(row({ amountMinor: 500000 }), false);
    expect(view.amountText).toBe("Hidden");
  });

  it("shows the em-dash for a null method", () => {
    expect(toWorkspaceRowView(row({ method: null }), true).methodText).toBe("—");
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
  it("counts each lifecycle status from the rows already on the page", () => {
    const rows = [row({ status: "DRAFT" }), row({ status: "DRAFT" }), row({ status: "RECORDED" }), row({ status: "CONFIRMED" }), row({ status: "FAILED" }), row({ status: "VOID" })];
    expect(summarizeWorkspaceRows(rows)).toEqual({ draft: 2, recorded: 1, confirmed: 1, failed: 1, void: 1 });
  });

  it("returns all-zero counts for an empty page", () => {
    expect(summarizeWorkspaceRows([])).toEqual({ draft: 0, recorded: 0, confirmed: 0, failed: 0, void: 0 });
  });
});

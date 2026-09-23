import { describe, expect, it } from "vitest";

import type { PayableRowDto } from "@/server/finance-payables/client-dto";

import { initialsOfName, payableDetailHref, summarizeWorkspaceRows, toWorkspaceRowView } from "./workspace-view-model";

function row(overrides: Partial<PayableRowDto> = {}): PayableRowDto {
  return {
    payableRef: "pay_00000000000000000001",
    counterparty: { type: "PARTNER", ref: "partner-1", displayName: "Nila Talks" },
    commercialPeriod: "2026-03",
    currency: "INR",
    status: "DRAFT",
    sourceType: "PARTNER_REVIEW",
    totalAmountMinorSigned: 500000,
    determinationState: "DETERMINISTIC",
    openReviewCount: 0,
    latestVersion: 1,
    readyVersion: null,
    lastUpdatedAt: "2026-03-05T10:00:00.000Z",
    ...overrides,
  };
}

describe("toWorkspaceRowView", () => {
  it("maps every allowlisted field to a display view", () => {
    const view = toWorkspaceRowView(row(), true);
    expect(view.payableRef).toBe("pay_00000000000000000001");
    expect(view.detailHref).toBe(payableDetailHref("pay_00000000000000000001"));
    expect(view.counterpartyName).toBe("Nila Talks");
    expect(view.counterpartyTypeLabel).toBe("Partner");
    expect(view.commercialPeriod).toBe("March 2026");
    expect(view.sourceTypeLabel).toBe("Partner Review");
    expect(view.amountText).toBe("₹5,000");
    expect(view.determination.label).toBe("Deterministic");
    expect(view.status.label).toBe("Draft");
  });

  it("falls back to 'Unnamed counterparty' when the live name is blank", () => {
    const view = toWorkspaceRowView(row({ counterparty: { type: "VENDOR", ref: "vendor-1", displayName: null } }), true);
    expect(view.counterpartyName).toBe("Unnamed counterparty");
    expect(view.counterpartyTypeTone).toBe("purple");
  });

  it("shows 'Hidden' for the amount when amountsVisible is false, never a guessed figure", () => {
    const view = toWorkspaceRowView(row({ totalAmountMinorSigned: null }), false);
    expect(view.amountText).toBe("Hidden");
  });

  it("shows the neutral dash when amounts are visible but the figure is genuinely null", () => {
    const view = toWorkspaceRowView(row({ totalAmountMinorSigned: null }), true);
    expect(view.amountText).toBe("—");
  });
});

describe("initialsOfName", () => {
  it("takes the first letter of up to two words", () => {
    expect(initialsOfName("Nila Talks")).toBe("NT");
    expect(initialsOfName("Solo")).toBe("S");
    expect(initialsOfName("  ")).toBe("?");
  });
});

describe("summarizeWorkspaceRows", () => {
  it("counts Draft, Finance review required, Ready for invoice and Void from the rows given", () => {
    const rows: PayableRowDto[] = [
      row({ payableRef: "pay_1", status: "DRAFT", determinationState: "DETERMINISTIC" }),
      row({ payableRef: "pay_2", status: "DRAFT", determinationState: "FINANCE_REVIEW_REQUIRED" }),
      row({ payableRef: "pay_3", status: "READY_FOR_INVOICE", determinationState: "DETERMINISTIC" }),
      row({ payableRef: "pay_4", status: "VOID", determinationState: "DETERMINISTIC" }),
    ];
    expect(summarizeWorkspaceRows(rows)).toEqual({ draft: 2, financeReviewRequired: 1, readyForInvoice: 1, void: 1 });
  });

  it("returns all zeros for an empty set", () => {
    expect(summarizeWorkspaceRows([])).toEqual({ draft: 0, financeReviewRequired: 0, readyForInvoice: 0, void: 0 });
  });
});

import { describe, expect, it } from "vitest";

import { emptyPaymentDetailsForm, overpaymentWarning, paymentDetailsFormComplete, remainingAfterThisPayment, reviseFieldsFromForm, toEligibleInvoiceRowView, type EligibleInvoiceSource, type PaymentDetailsForm } from "./create-view";

const SOURCE: EligibleInvoiceSource = {
  invoiceRef: "inv_00000000000000000001",
  invoiceNumber: "INV-2026-045",
  counterpartyType: "PARTNER",
  counterpartyName: "Aisha Khan",
  commercialPeriodKey: "2026-03",
  currency: "INR",
  grossInvoiceMinor: 900000,
  tdsMinor: 90000,
  expectedNetPaymentMinor: 810000,
  confirmedPaidMinor: 500000,
  remainingMinor: 310000,
  settlementState: "PARTIALLY_PAID",
  amountsVisible: true,
};

describe("toEligibleInvoiceRowView", () => {
  it("maps every field to a display value", () => {
    const view = toEligibleInvoiceRowView(SOURCE);
    expect(view.invoiceRef).toBe("inv_00000000000000000001");
    expect(view.invoiceNumber).toBe("INV-2026-045");
    expect(view.counterpartyName).toBe("Aisha Khan");
    expect(view.commercialPeriod).toBe("March 2026");
    expect(view.grossInvoiceText).toBe("₹9,000");
    expect(view.tdsText).toBe("₹900");
    expect(view.expectedNetPaymentText).toBe("₹8,100");
    expect(view.confirmedPaidText).toBe("₹5,000");
    expect(view.remainingText).toBe("₹3,100");
    expect(view.settlement).toEqual({ label: "Partially paid", tone: "orange" });
  });

  it("withholds every amount when amounts are not visible", () => {
    const view = toEligibleInvoiceRowView({ ...SOURCE, amountsVisible: false });
    expect(view.grossInvoiceText).toBe("Hidden");
    expect(view.expectedNetPaymentText).toBe("Hidden");
  });

  it("falls back to the em-dash for a missing invoice number", () => {
    expect(toEligibleInvoiceRowView({ ...SOURCE, invoiceNumber: null }).invoiceNumber).toBe("—");
  });
});

describe("emptyPaymentDetailsForm / paymentDetailsFormComplete", () => {
  it("defaults the amount to the current remaining amount", () => {
    const form = emptyPaymentDetailsForm(310000, "2026-03-15");
    expect(form.amountText).toBe("3100");
    expect(form.paymentDate).toBe("2026-03-15");
    expect(form.method).toBe("");
  });

  it("leaves the amount blank when remaining is null or zero", () => {
    expect(emptyPaymentDetailsForm(null, "2026-03-15").amountText).toBe("");
    expect(emptyPaymentDetailsForm(0, "2026-03-15").amountText).toBe("");
  });

  it("is complete only once amount, date and method are all set", () => {
    const base: PaymentDetailsForm = { amountText: "", paymentDate: "", method: "", externalReference: "", memo: "" };
    expect(paymentDetailsFormComplete(base)).toBe(false);
    expect(paymentDetailsFormComplete({ ...base, amountText: "100", paymentDate: "2026-03-15", method: "UPI" })).toBe(true);
    expect(paymentDetailsFormComplete({ ...base, amountText: "100", paymentDate: "2026-03-15" })).toBe(false);
  });
});

describe("reviseFieldsFromForm", () => {
  const base: PaymentDetailsForm = { amountText: "3,100", paymentDate: "2026-03-15", method: "UPI", externalReference: " utr-123 ", memo: "  " };

  it("parses a complete form into the revise payload", () => {
    const result = reviseFieldsFromForm(base);
    expect(result).toEqual({ ok: true, fields: { amountMinor: 310000, paymentDate: "2026-03-15", method: "UPI", externalReference: "utr-123", memo: null } });
  });

  it("clears a blank optional field to null rather than an empty string", () => {
    const result = reviseFieldsFromForm({ ...base, externalReference: "  ", memo: "  " });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fields.externalReference).toBeNull();
      expect(result.fields.memo).toBeNull();
    }
  });

  it("collects errors for missing amount, date and method rather than guessing", () => {
    const result = reviseFieldsFromForm({ amountText: "", paymentDate: "", method: "", externalReference: "", memo: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("Enter a payment amount.");
      expect(result.errors).toContain("Enter a payment date.");
      expect(result.errors).toContain("Select a payment method.");
    }
  });
});

describe("remainingAfterThisPayment", () => {
  it("subtracts this Payment from the current remaining amount", () => {
    expect(remainingAfterThisPayment(400000, 200000)).toBe(200000);
  });

  it("never goes negative - clamps to 0 exactly like the backend's own settlement calculator", () => {
    expect(remainingAfterThisPayment(100000, 300000)).toBe(0);
  });

  it("passes remaining through unchanged when the amount is not yet known", () => {
    expect(remainingAfterThisPayment(100000, null)).toBe(100000);
  });
});

describe("overpaymentWarning", () => {
  it("is null while the amount does not exceed remaining", () => {
    expect(overpaymentWarning(400000, 400000)).toBeNull();
    expect(overpaymentWarning(400000, 100000)).toBeNull();
  });

  it("warns, naming the excess, once the amount exceeds remaining - never silently caps it", () => {
    const warning = overpaymentWarning(100000, 150000);
    expect(warning).toContain("50000");
    expect(warning).toContain("overpayment override");
  });

  it("is null when remaining is not yet known", () => {
    expect(overpaymentWarning(null, 150000)).toBeNull();
  });
});

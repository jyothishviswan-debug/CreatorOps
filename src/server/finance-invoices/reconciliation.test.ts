import { describe, expect, it } from "vitest";

import { reconcileInvoiceAgainstPayable, type ReconcileDeclaredInput } from "./reconciliation";
import { buildPin, FIXTURE_TAX_LINE } from "./testing/invoice-fixtures";
import { INVOICE_RECONCILIATION_CODES } from "./types";

const PIN = buildPin();

function declared(overrides: Partial<ReconcileDeclaredInput> = {}): ReconcileDeclaredInput {
  return {
    currency: "INR",
    subtotalMinor: null,
    taxLines: [],
    declaredTotalMinor: 5_000_000,
    externalInvoiceNumber: "INV-001",
    counterpartyType: "PARTNER",
    counterpartyRef: "partner-fixture",
    commercialPeriod: PIN.commercialPeriod,
    ...overrides,
  };
}

describe("exact match", () => {
  it("is MATCH when currency, total, counterparty and period all agree and a document is present", () => {
    const result = reconcileInvoiceAgainstPayable({ declared: declared(), pin: PIN, documentPresent: true, documentRequired: true, duplicateNumberDetected: false });
    expect(result.state).toBe("MATCH");
    expect(result.findings).toEqual([]);
  });
});

describe("amount mismatch", () => {
  it("is MISMATCH when the declared total differs from the pinned Payable's expected total, and preserves both figures implicitly (no invented correction)", () => {
    const result = reconcileInvoiceAgainstPayable({ declared: declared({ declaredTotalMinor: 4_999_999 }), pin: PIN, documentPresent: true, documentRequired: true, duplicateNumberDetected: false });
    expect(result.state).toBe("MISMATCH");
    expect(result.findings.map((f) => f.code)).toEqual(["TOTAL_AMOUNT_MISMATCH"]);
  });
});

describe("Step 15C: reconciles to the gross expected Invoice total, never the after-TDS net payment", () => {
  it("MATCHes against payableGrossInvoiceExpectedMinor even though payableExpectedNetPaymentMinor differs (TDS withheld)", () => {
    // The fixture pin: serviceBase 5,000,000, TDS 500,000, gross 5,000,000, net 4,500,000.
    expect(PIN.payableGrossInvoiceExpectedMinor).toBe(5_000_000);
    expect(PIN.payableExpectedNetPaymentMinor).toBe(4_500_000);
    const result = reconcileInvoiceAgainstPayable({ declared: declared({ declaredTotalMinor: 5_000_000 }), pin: PIN, documentPresent: true, documentRequired: true, duplicateNumberDetected: false });
    expect(result.state).toBe("MATCH");
  });

  it("MISMATCHes when the Invoice declares the after-TDS net payment figure instead of the gross total", () => {
    const result = reconcileInvoiceAgainstPayable({ declared: declared({ declaredTotalMinor: PIN.payableExpectedNetPaymentMinor! }), pin: PIN, documentPresent: true, documentRequired: true, duplicateNumberDetected: false });
    expect(result.state).toBe("MISMATCH");
    expect(result.findings.map((f) => f.code)).toEqual(["TOTAL_AMOUNT_MISMATCH"]);
  });

  it("is MISSING_IN_PAYABLE when the pinned Payable has no computed gross expected Invoice total", () => {
    const noBase = buildPin({ payableServiceBaseMinor: null, payableGrossInvoiceExpectedMinor: null, payableExpectedNetPaymentMinor: null });
    const result = reconcileInvoiceAgainstPayable({ declared: declared(), pin: noBase, documentPresent: true, documentRequired: true, duplicateNumberDetected: false });
    expect(result.state).toBe("MISSING_IN_PAYABLE");
    expect(result.findings.map((f) => f.code)).toContain("MISSING_PAYABLE_TOTAL");
  });
});

describe("Step 15C section 20: subtotal vs service base - informational only, never blocks", () => {
  it("a subtotal that matches the service base raises no finding", () => {
    const result = reconcileInvoiceAgainstPayable({ declared: declared({ subtotalMinor: PIN.payableServiceBaseMinor! }), pin: PIN, documentPresent: true, documentRequired: true, duplicateNumberDetected: false });
    expect(result.findings.map((f) => f.code)).not.toContain("SUBTOTAL_SERVICE_BASE_MISMATCH");
  });

  it("a subtotal that differs from the service base raises a WARNING, never a BLOCKER, and never changes the overall MATCH state on its own once counted", () => {
    const result = reconcileInvoiceAgainstPayable({ declared: declared({ subtotalMinor: PIN.payableServiceBaseMinor! - 1 }), pin: PIN, documentPresent: true, documentRequired: true, duplicateNumberDetected: false });
    const finding = result.findings.find((f) => f.code === "SUBTOTAL_SERVICE_BASE_MISMATCH")!;
    expect(finding.severity).toBe("WARNING");
    expect(result.state).toBe("REVIEW_REQUIRED"); // a WARNING with no other blocker => REVIEW_REQUIRED, never BLOCKED/MISMATCH
  });

  it("no finding when the Invoice declares no subtotal at all", () => {
    const result = reconcileInvoiceAgainstPayable({ declared: declared({ subtotalMinor: null }), pin: PIN, documentPresent: true, documentRequired: true, duplicateNumberDetected: false });
    expect(result.findings.map((f) => f.code)).not.toContain("SUBTOTAL_SERVICE_BASE_MISMATCH");
  });
});

describe("currency mismatch", () => {
  it("is BLOCKED when the declared currency differs from the pinned Payable's currency", () => {
    const result = reconcileInvoiceAgainstPayable({ declared: declared({ currency: "USD" }), pin: PIN, documentPresent: true, documentRequired: true, duplicateNumberDetected: false });
    expect(result.state).toBe("BLOCKED");
    expect(result.findings.map((f) => f.code)).toContain("CURRENCY_MISMATCH");
  });
});

describe("missing invoice total", () => {
  it("is MISSING_IN_INVOICE when no total is declared yet", () => {
    const result = reconcileInvoiceAgainstPayable({ declared: declared({ declaredTotalMinor: null }), pin: PIN, documentPresent: false, documentRequired: true, duplicateNumberDetected: false });
    expect(result.state).toBe("MISSING_IN_INVOICE");
    expect(result.findings.map((f) => f.code)).toContain("MISSING_INVOICE_TOTAL");
  });
});

describe("duplicate invoice number", () => {
  it("is BLOCKED when the normalized number is already claimed by a different Invoice head", () => {
    const result = reconcileInvoiceAgainstPayable({ declared: declared(), pin: PIN, documentPresent: true, documentRequired: true, duplicateNumberDetected: true });
    expect(result.state).toBe("BLOCKED");
    expect(result.findings.map((f) => f.code)).toContain("DUPLICATE_INVOICE_NUMBER");
  });
});

describe("arithmetic inconsistency", () => {
  it("is a WARNING (REVIEW_REQUIRED), never a blocker, and never invents a correction", () => {
    const result = reconcileInvoiceAgainstPayable(
      { declared: declared({ subtotalMinor: 4_000_000, taxLines: [FIXTURE_TAX_LINE], declaredTotalMinor: 5_000_000 }), pin: PIN, documentPresent: true, documentRequired: true, duplicateNumberDetected: false },
    );
    expect(result.state).toBe("REVIEW_REQUIRED");
    const finding = result.findings.find((f) => f.code === "ARITHMETIC_INCONSISTENT")!;
    expect(finding.severity).toBe("WARNING");
    // The message never embeds a literal figure - findings are visible without finance_amounts.
    expect(finding.message).not.toMatch(/\d/);
  });

  it("a consistent subtotal+tax=total has no arithmetic finding", () => {
    const result = reconcileInvoiceAgainstPayable(
      { declared: declared({ subtotalMinor: 4_100_000, taxLines: [FIXTURE_TAX_LINE], declaredTotalMinor: 5_000_000 }), pin: PIN, documentPresent: true, documentRequired: true, duplicateNumberDetected: false },
    );
    expect(result.findings.map((f) => f.code)).not.toContain("ARITHMETIC_INCONSISTENT");
  });
});

describe("missing document", () => {
  it("is a BLOCKER when a document is required but absent", () => {
    const result = reconcileInvoiceAgainstPayable({ declared: declared(), pin: PIN, documentPresent: false, documentRequired: true, duplicateNumberDetected: false });
    expect(result.state).toBe("BLOCKED");
    expect(result.findings.map((f) => f.code)).toContain("MISSING_INVOICE_DOCUMENT");
  });

  it("is not surfaced when a document is not required", () => {
    const result = reconcileInvoiceAgainstPayable({ declared: declared(), pin: PIN, documentPresent: false, documentRequired: false, duplicateNumberDetected: false });
    expect(result.findings.map((f) => f.code)).not.toContain("MISSING_INVOICE_DOCUMENT");
  });
});

describe("counterparty and commercial period defensive checks", () => {
  it("counterparty mismatch is a BLOCKER", () => {
    const result = reconcileInvoiceAgainstPayable({ declared: declared({ counterpartyRef: "someone-else" }), pin: PIN, documentPresent: true, documentRequired: true, duplicateNumberDetected: false });
    expect(result.state).toBe("BLOCKED");
    expect(result.findings.map((f) => f.code)).toContain("COUNTERPARTY_MISMATCH");
  });

  it("commercial period mismatch is a BLOCKER", () => {
    const result = reconcileInvoiceAgainstPayable(
      { declared: declared({ commercialPeriod: { periodKey: "2024-04", periodStart: "2024-04-01", periodEnd: "2024-04-30" } }), pin: PIN, documentPresent: true, documentRequired: true, duplicateNumberDetected: false },
    );
    expect(result.state).toBe("BLOCKED");
    expect(result.findings.map((f) => f.code)).toContain("COMMERCIAL_PERIOD_MISMATCH");
  });
});

describe("the closed code/state sets", () => {
  it("every finding code belongs to the closed INVOICE_RECONCILIATION_CODES set", () => {
    const scenarios = [
      declared({ currency: "USD" }),
      declared({ declaredTotalMinor: null }),
      declared({ counterpartyRef: "x" }),
      declared({ subtotalMinor: 1, taxLines: [], declaredTotalMinor: 2 }),
    ];
    for (const scenario of scenarios) {
      const result = reconcileInvoiceAgainstPayable({ declared: scenario, pin: PIN, documentPresent: false, documentRequired: true, duplicateNumberDetected: true });
      for (const finding of result.findings) expect(INVOICE_RECONCILIATION_CODES as readonly string[]).toContain(finding.code);
    }
  });
});

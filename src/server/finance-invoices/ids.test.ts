import { describe, expect, it } from "vitest";

import { invoiceDocumentIdempotencyKey, invoiceNumberClaimId, invoiceRefFor, normalizeInvoiceNumber } from "./ids";

describe("invoiceRefFor", () => {
  it("is deterministic in the payableRef - the same Payable always resolves to the same Invoice head id", () => {
    const ref = invoiceRefFor("pay_0123456789abcdef0123");
    expect(ref).toBe(invoiceRefFor("pay_0123456789abcdef0123"));
    expect(ref).toMatch(/^inv_[0-9a-f]{20}$/);
  });

  it("different Payables resolve to different Invoice heads", () => {
    expect(invoiceRefFor("pay_0123456789abcdef0123")).not.toBe(invoiceRefFor("pay_ffffffffffffffffffff"));
  });
});

describe("normalizeInvoiceNumber", () => {
  it("trims, collapses internal whitespace and uppercases - never fuzzy beyond that", () => {
    expect(normalizeInvoiceNumber("  inv-001  ")).toBe("INV-001");
    expect(normalizeInvoiceNumber("INV   001")).toBe("INV 001");
    expect(normalizeInvoiceNumber("Inv-001")).toBe("INV-001");
  });

  it("does NOT fuzzy-merge distinct-looking numbers", () => {
    expect(normalizeInvoiceNumber("INV-001")).not.toBe(normalizeInvoiceNumber("INV 001"));
    expect(normalizeInvoiceNumber("INV001")).not.toBe(normalizeInvoiceNumber("INV-001"));
  });
});

describe("invoiceNumberClaimId", () => {
  it("is deterministic in (counterpartyType, counterpartyRef, normalizedNumber)", () => {
    const id = invoiceNumberClaimId("PARTNER", "partner-1", "INV-001");
    expect(id).toBe(invoiceNumberClaimId("PARTNER", "partner-1", "INV-001"));
  });

  it("differs across counterparty, ref or number", () => {
    const base = invoiceNumberClaimId("PARTNER", "partner-1", "INV-001");
    expect(invoiceNumberClaimId("VENDOR", "partner-1", "INV-001")).not.toBe(base);
    expect(invoiceNumberClaimId("PARTNER", "partner-2", "INV-001")).not.toBe(base);
    expect(invoiceNumberClaimId("PARTNER", "partner-1", "INV-002")).not.toBe(base);
  });
});

describe("invoiceDocumentIdempotencyKey", () => {
  it("is deterministic and differs across version or content hash", () => {
    const sha = "a".repeat(64);
    const key = invoiceDocumentIdempotencyKey("inv_00000000000000000001", 1, sha);
    expect(key).toBe(invoiceDocumentIdempotencyKey("inv_00000000000000000001", 1, sha));
    expect(invoiceDocumentIdempotencyKey("inv_00000000000000000001", 2, sha)).not.toBe(key);
    expect(invoiceDocumentIdempotencyKey("inv_00000000000000000001", 1, "b".repeat(64))).not.toBe(key);
  });
});

import { describe, expect, it } from "vitest";

import { generatePaymentRef, normalizeExternalReference, paymentReferenceClaimId } from "./ids";

describe("generatePaymentRef", () => {
  it("produces a pmt_ prefixed 20-hex-char opaque ref, and a fresh one every call (never deterministic)", () => {
    const a = generatePaymentRef();
    const b = generatePaymentRef();
    expect(a).toMatch(/^pmt_[0-9a-f]{20}$/);
    expect(b).toMatch(/^pmt_[0-9a-f]{20}$/);
    expect(a).not.toBe(b);
  });
});

describe("normalizeExternalReference", () => {
  it("strips case, whitespace and hyphens/underscores so equivalent references collide", () => {
    expect(normalizeExternalReference("UTR 123-456")).toBe(normalizeExternalReference("utr123456"));
    expect(normalizeExternalReference(" utr_123_456 ")).toBe(normalizeExternalReference("UTR-123-456"));
  });

  it("returns null for an empty or whitespace-only input", () => {
    expect(normalizeExternalReference("")).toBeNull();
    expect(normalizeExternalReference("   ")).toBeNull();
  });

  it("does not collide two genuinely different references", () => {
    expect(normalizeExternalReference("UTR111")).not.toBe(normalizeExternalReference("UTR222"));
  });
});

describe("paymentReferenceClaimId", () => {
  it("is deterministic in (method, normalizedKey) and different methods never collide on the same key", () => {
    const a = paymentReferenceClaimId("BANK_TRANSFER", "UTR123456");
    const b = paymentReferenceClaimId("BANK_TRANSFER", "UTR123456");
    const c = paymentReferenceClaimId("UPI", "UTR123456");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

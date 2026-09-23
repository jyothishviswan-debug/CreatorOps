import { describe, expect, it } from "vitest";

import { redactInvoiceEventMetadata } from "./invoice-events";

describe("redactInvoiceEventMetadata", () => {
  it("keeps only allowlisted keys with a value of the expected safe shape", () => {
    expect(redactInvoiceEventMetadata({ version: 1, reason: "A valid reason.", junkKey: "anything" })).toEqual({ version: 1, reason: "A valid reason." });
  });

  it("returns null for empty/absent input", () => {
    expect(redactInvoiceEventMetadata(null)).toBeNull();
    expect(redactInvoiceEventMetadata(undefined)).toBeNull();
    expect(redactInvoiceEventMetadata({})).toBeNull();
    expect(redactInvoiceEventMetadata({ junkKey: "x" })).toBeNull();
  });

  it("never lets an amount-looking value through, even under an allowlisted free-text key", () => {
    expect(redactInvoiceEventMetadata({ reason: "Paid ₹50000 in cash" })).toBeNull();
    expect(redactInvoiceEventMetadata({ reason: "Total is INR 5000000" })).toBeNull();
    expect(redactInvoiceEventMetadata({ fileName: "invoice_5000000.pdf" })).toEqual({ fileName: "invoice_5000000.pdf" }); // a digit run under 9+ is fine; below threshold
  });

  it("never lets an identity-shaped value through", () => {
    expect(redactInvoiceEventMetadata({ reason: "PAN is ABCDE1234F" })).toBeNull();
    expect(redactInvoiceEventMetadata({ reason: "Contact me at a@b.com" })).toBeNull();
    expect(redactInvoiceEventMetadata({ reason: "Account 123456789012" })).toBeNull();
  });

  it("rejects a status/kind/code value that is not the exact enum member", () => {
    expect(redactInvoiceEventMetadata({ fromStatus: "NOT_A_REAL_STATUS" })).toBeNull();
    expect(redactInvoiceEventMetadata({ toStatus: "SUBMITTED" })).toEqual({ toStatus: "SUBMITTED" });
  });

  it("has NO amount-shaped key at all - the allowlist itself never grows one", () => {
    // Every key name that could plausibly hold a minor-units figure is absent from the allowlist.
    const suspicious = ["amount", "amountMinor", "declaredTotalMinor", "subtotalMinor", "totalMinor", "payableExpectedTotalMinorSigned"];
    for (const key of suspicious) expect(redactInvoiceEventMetadata({ [key]: 5_000_000 })).toBeNull();
  });

  it("mimeType only accepts the exact PDF constant", () => {
    expect(redactInvoiceEventMetadata({ mimeType: "application/pdf" })).toEqual({ mimeType: "application/pdf" });
    expect(redactInvoiceEventMetadata({ mimeType: "application/msword" })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { redactPaymentEventMetadata } from "./payment-events";

describe("redactPaymentEventMetadata", () => {
  it("keeps only allowlisted keys with valid values", () => {
    expect(redactPaymentEventMetadata({ version: 1, fromStatus: "DRAFT", toStatus: "RECORDED", method: "UPI" })).toEqual({ version: 1, fromStatus: "DRAFT", toStatus: "RECORDED", method: "UPI" });
  });

  it("drops an unknown key entirely, never passing it through", () => {
    expect(redactPaymentEventMetadata({ version: 1, amountMinor: 90_000 })).toEqual({ version: 1 });
  });

  it("drops a known key whose value fails its own check", () => {
    expect(redactPaymentEventMetadata({ fromStatus: "NOT_A_REAL_STATUS" })).toBeNull();
    expect(redactPaymentEventMetadata({ version: -1 })).toBeNull();
  });

  it("never allows a raw money amount under any key name - amountMinor and similar are not on the allowlist at all", () => {
    const result = redactPaymentEventMetadata({ amountMinor: 12_345, confirmedPaidMinor: 1, expectedNetPaymentMinor: 1 });
    expect(result).toBeNull();
  });

  it("rejects a reason/label that looks like an identity value, email, or embedded amount", () => {
    expect(redactPaymentEventMetadata({ reason: "PAN ABCPE1234F noted" })).toBeNull();
    expect(redactPaymentEventMetadata({ reason: "contact me at a@b.com" })).toBeNull();
    expect(redactPaymentEventMetadata({ reason: "paid rs 500 extra" })).toBeNull();
  });

  it("accepts an ordinary safe reason", () => {
    expect(redactPaymentEventMetadata({ reason: "Manager approved a partial transfer this month" })).toEqual({ reason: "Manager approved a partial transfer this month" });
  });

  it("returns null for null/undefined/empty input", () => {
    expect(redactPaymentEventMetadata(null)).toBeNull();
    expect(redactPaymentEventMetadata(undefined)).toBeNull();
    expect(redactPaymentEventMetadata({})).toBeNull();
  });

  it("is idempotent: redacting an already-redacted object returns the same result", () => {
    const once = redactPaymentEventMetadata({ version: 2, method: "CHEQUE", reason: "test note", junk: "x" });
    const twice = redactPaymentEventMetadata(once);
    expect(twice).toEqual(once);
  });
});

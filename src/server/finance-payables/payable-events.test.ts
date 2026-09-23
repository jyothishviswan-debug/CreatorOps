import { describe, expect, it } from "vitest";

import { buildPayableEvent, PAYABLE_EVENT_METADATA_ALLOWLIST, redactPayableEventMetadata } from "./payable-events";
import { PAYABLE_EVENT_KINDS } from "./types";

// Step 15A section 15: the audit trail's metadata allowlist. The event history is readable by
// anyone who may read the Payable, so it must never carry an amount (amounts are behind the
// finance_amounts sensitive category), a restricted identity value, or contract text.

describe("the required event kinds all exist", () => {
  it("names exactly the section 15 minimum", () => {
    expect([...PAYABLE_EVENT_KINDS].sort()).toEqual(
      ["MANUAL_ADJUSTMENT_ADDED", "MANUAL_ADJUSTMENT_REMOVED", "PAYABLE_CREATED", "PAYABLE_READY_FOR_INVOICE", "PAYABLE_VERSION_CREATED", "PAYABLE_VOIDED", "SOURCE_REVISION_DETECTED"].sort(),
    );
  });
});

describe("no amount can ever be represented in event metadata", () => {
  it("the allowlist has no amount / total / money key at all", () => {
    const keys = Object.keys(PAYABLE_EVENT_METADATA_ALLOWLIST);
    expect(keys.filter((key) => /amount|total|minor|money|fee|sum|value|price/i.test(key))).toEqual([]);
  });

  it("drops an amount-shaped key even when a caller passes one", () => {
    expect(redactPayableEventMetadata({ totalAmountMinorSigned: 5_000_000, amountMinorSigned: -50_000, lineCount: 2 })).toEqual({ lineCount: 2 });
  });

  it("keeps the currency CODE (not a figure) but refuses a currency-qualified reason", () => {
    expect(redactPayableEventMetadata({ currency: "INR" })).toEqual({ currency: "INR" });
    expect(redactPayableEventMetadata({ reason: "Deducting INR 500 for the transfer fee." })).toBeNull();
    expect(redactPayableEventMetadata({ reason: "Finance confirmed the transfer fee is borne by the partner." })).toEqual({ reason: "Finance confirmed the transfer fee is borne by the partner." });
  });
});

describe("the allowlist is an allowlist, not a blocklist", () => {
  it("drops an unknown key entirely, however innocent it looks", () => {
    expect(redactPayableEventMetadata({ note: "hello", freeText: "hello", snapshot: { anything: true } })).toBeNull();
  });

  it("drops an allowlisted key whose VALUE has the wrong shape", () => {
    expect(redactPayableEventMetadata({ determinationState: "APPROVED", changeKind: "deleted", commercialPeriod: "2024-13", version: 0 })).toBeNull();
    expect(redactPayableEventMetadata({ determinationState: "DETERMINISTIC", changeKind: "revised", commercialPeriod: "2024-03", version: 2 })).toEqual({
      determinationState: "DETERMINISTIC",
      changeKind: "revised",
      commercialPeriod: "2024-03",
      version: 2,
    });
  });

  it("refuses identity-shaped and email-shaped free text", () => {
    for (const reason of ["The PAN is ABCDE1234F.", "Bank account 123456789012 was corrected.", "Contact finance@example.com about this.", "Aadhaar 1234 5678 9012 on file."]) {
      expect(redactPayableEventMetadata({ reason })).toBeNull();
    }
  });

  it("keeps only the closed review / blocked code lists, and only when every member is valid", () => {
    expect(redactPayableEventMetadata({ openReviewCodes: ["NARRATIVE_INCENTIVE"] })).toEqual({ openReviewCodes: ["NARRATIVE_INCENTIVE"] });
    expect(redactPayableEventMetadata({ openReviewCodes: ["NARRATIVE_INCENTIVE", "SOMETHING_ELSE"] })).toBeNull();
    expect(redactPayableEventMetadata({ blockedCodes: ["CURRENCY_MISSING"] })).toEqual({ blockedCodes: ["CURRENCY_MISSING"] });
  });
});

describe("building an event", () => {
  it("stores the redacted metadata, never the raw input", () => {
    const event = buildPayableEvent({
      payableRef: "pay_00000000000000000001",
      kind: "PAYABLE_CREATED",
      version: 1,
      actorUserRef: "user-1",
      metadata: { counterpartyType: "PARTNER", totalAmountMinorSigned: 5_000_000, secret: "x" },
      requestId: "req-1",
      createdAt: "2024-04-03T00:00:00.000Z",
    });
    expect(event.metadata).toEqual({ counterpartyType: "PARTNER" });
  });

  it("stores null when nothing survives", () => {
    expect(buildPayableEvent({ payableRef: "p", kind: "PAYABLE_VOIDED", version: 1, actorUserRef: "u", metadata: { totalAmountMinorSigned: 1 }, requestId: "r", createdAt: "2024-04-03T00:00:00.000Z" }).metadata).toBeNull();
  });
});

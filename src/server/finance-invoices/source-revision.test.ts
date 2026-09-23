import { describe, expect, it } from "vitest";

import { compareInvoicePayableRevision, INVOICE_SOURCE_REVISION_MESSAGES } from "./source-revision";
import { INVOICE_SOURCE_CURRENCY_STATES } from "./types";

// Step 16A section 15: the source-revision comparison is a WARNING and nothing else - a pure
// function over the pinned Payable version and the Payable's current latest version. It never
// mutates an Invoice.

describe("the closed state set", () => {
  it("is exactly the two states section 15 names, and every one has a message", () => {
    expect([...INVOICE_SOURCE_CURRENCY_STATES]).toEqual(["CURRENT", "PAYABLE_REVISION_AVAILABLE"]);
    for (const state of INVOICE_SOURCE_CURRENCY_STATES) expect(INVOICE_SOURCE_REVISION_MESSAGES[state].length).toBeGreaterThan(20);
  });
});

describe("comparing the pinned version against the current one", () => {
  it("the same version is CURRENT", () => {
    expect(compareInvoicePayableRevision({ payableVersion: 2 }, { latestVersion: 2, status: "READY_FOR_INVOICE" })).toEqual({ state: "CURRENT", payableRevisionAvailable: false });
  });

  it("a newer Payable version is PAYABLE_REVISION_AVAILABLE", () => {
    expect(compareInvoicePayableRevision({ payableVersion: 2 }, { latestVersion: 3, status: "DRAFT" }).state).toBe("PAYABLE_REVISION_AVAILABLE");
  });

  it("offers nothing when the current Payable cannot be resolved at all", () => {
    expect(compareInvoicePayableRevision({ payableVersion: 2 }, null)).toEqual({ state: "CURRENT", payableRevisionAvailable: false });
  });

  it("a historical pinned version stays reported unchanged across repeated comparisons", () => {
    const first = compareInvoicePayableRevision({ payableVersion: 1 }, { latestVersion: 4, status: "DRAFT" });
    const second = compareInvoicePayableRevision({ payableVersion: 1 }, { latestVersion: 4, status: "DRAFT" });
    expect(first).toEqual(second);
    expect(first.state).toBe("PAYABLE_REVISION_AVAILABLE");
  });
});

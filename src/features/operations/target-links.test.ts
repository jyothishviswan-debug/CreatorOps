import { describe, expect, it } from "vitest";

import type { TargetType } from "@/server/operations/target-ref";

import { approvalSourceHref, targetHref, targetLabel } from "./target-links";

// Step 18B: proves the closed target -> canonical-route map matches this app's REAL route shapes
// (the ones src/app/**/[*] actually declares), and that the two target types with no standalone
// detail route of their own (PARTNER_ACCOUNT, AGREEMENT) deliberately yield null rather than a
// guessed URL - TaskDetail/ReminderDetail only render "Open linked record" when this returns a href.

const TARGET_HREF_CASES: Array<[TargetType, string, string | null]> = [
  ["PARTNER", "prt_1", "/partners/prt_1"],
  ["VENDOR", "vnd_1", "/vendors/vnd_1"],
  ["CAMPAIGN", "cmp_1", "/campaigns/cmp_1"],
  ["ASSIGNMENT", "asn_1", "/assignments/asn_1"],
  ["CONTENT", "cnt_1", "/content/cnt_1"],
  ["PARTNER_REVIEW", "rev_1", "/partner-reviews/rev_1"],
  ["PAYABLE", "pyb_1", "/finance/payables/pyb_1"],
  ["INVOICE", "inv_1", "/finance/invoices/inv_1"],
  ["PAYMENT", "pmt_1", "/finance/payments/pmt_1"],
  ["AGREEMENT", "agr_1", null],
  ["PARTNER_ACCOUNT", "pac_1", null],
];

describe("targetHref", () => {
  for (const [targetType, targetRef, expected] of TARGET_HREF_CASES) {
    it(`${targetType} -> ${expected ?? "null (no standalone detail route)"}`, () => {
      expect(targetHref({ targetType, targetRef, targetVersion: null })).toBe(expected);
    });
  }

  it("URL-encodes a ref that contains special characters", () => {
    expect(targetHref({ targetType: "PARTNER", targetRef: "prt/with space", targetVersion: null })).toBe("/partners/prt%2Fwith%20space");
  });
});

describe("targetLabel", () => {
  it("renders 'Type · ref' as the safe secondary label", () => {
    expect(targetLabel({ targetType: "CAMPAIGN", targetRef: "cmp_1", targetVersion: null })).toBe("Campaign · cmp_1");
  });
});

describe("approvalSourceHref (spec section 6/11's own deep-link map - Open source never routes anywhere but the item's real source screen)", () => {
  it("maps every one of the four Step 18A source modules to its real canonical route", () => {
    expect(approvalSourceHref({ sourceModule: "finance_payables", sourceRef: "pyb_1" })).toBe("/finance/payables/pyb_1");
    expect(approvalSourceHref({ sourceModule: "finance_invoices", sourceRef: "inv_1" })).toBe("/finance/invoices/inv_1");
    expect(approvalSourceHref({ sourceModule: "finance_payments", sourceRef: "pmt_1" })).toBe("/finance/payments/pmt_1");
    expect(approvalSourceHref({ sourceModule: "partner_reviews", sourceRef: "rev_1" })).toBe("/partner-reviews/rev_1");
  });

  it("returns null for an unrecognized source module rather than guessing a route", () => {
    expect(approvalSourceHref({ sourceModule: "something_new", sourceRef: "x" })).toBeNull();
  });
});

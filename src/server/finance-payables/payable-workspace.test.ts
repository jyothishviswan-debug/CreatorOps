import { describe, expect, it } from "vitest";

import { comparePayableHeads, decodePayableCursor, encodePayableCursor, matchesPayableFilters } from "./payable-workspace-service";
import { listPayablesQuerySchema, payableHeadDocSchema, type PayableHeadDoc } from "./types";

// Step 15A section 14: the bounded list contract - which filters the workspace supports, the
// deterministic total order, and the deterministic cursor. (That every scope branch maps to a
// source-controlled composite index is certified in src/server/shared/firestore-indexes.test.ts.)

function head(overrides: Partial<PayableHeadDoc> & { payableRef: string }): PayableHeadDoc {
  return payableHeadDocSchema.parse({
    docVersion: 1,
    counterpartyType: "PARTNER",
    counterpartyRef: "partner-1",
    periodKey: "2024-03",
    periodStart: "2024-03-01",
    periodEnd: "2024-03-31",
    currency: "INR",
    sourceType: "PARTNER_REVIEW",
    agreementRef: "agr_0123456789abcdef0123",
    agreementVersion: 2,
    sourceReviewRef: "pr_0123456789abcdef0123",
    sourceReviewVersion: 1,
    businessKey: "b".repeat(64),
    ownerUid: null,
    regionIds: [],
    teamIds: [],
    partnerUid: "partner-uid",
    vendorUid: null,
    status: "DRAFT",
    latestVersion: 1,
    readyVersion: null,
    display: { counterpartyName: "Acme", counterpartyNameLower: "acme", totalAmountMinorSigned: 1, determinationState: "DETERMINISTIC", openReviewCount: 0, lineCount: 1, projectedAt: "2024-04-03T00:00:00.000Z" },
    createdAt: "2024-04-03T00:00:00.000Z",
    createdByUserRef: "u",
    updatedAt: "2024-04-03T00:00:00.000Z",
    updatedByUserRef: "u",
    ...overrides,
  });
}

describe("the supported filter dimensions", () => {
  const subject = head({ payableRef: "pay_00000000000000000001" });
  const parse = (query: unknown) => listPayablesQuerySchema.parse(query);

  it("filters by lifecycle status, counterparty type, counterparty and commercial period", () => {
    expect(matchesPayableFilters(subject, parse({ status: "DRAFT" }))).toBe(true);
    expect(matchesPayableFilters(subject, parse({ status: "VOID" }))).toBe(false);
    expect(matchesPayableFilters(subject, parse({ counterpartyType: "PARTNER" }))).toBe(true);
    expect(matchesPayableFilters(subject, parse({ counterpartyType: "VENDOR" }))).toBe(false);
    expect(matchesPayableFilters(subject, parse({ counterpartyRef: "partner-1" }))).toBe(true);
    expect(matchesPayableFilters(subject, parse({ counterpartyRef: "partner-2" }))).toBe(false);
    expect(matchesPayableFilters(subject, parse({ commercialPeriod: "2024-03" }))).toBe(true);
    expect(matchesPayableFilters(subject, parse({ commercialPeriod: "2024-04" }))).toBe(false);
  });

  it("combines filters conjunctively, and an empty query matches everything", () => {
    expect(matchesPayableFilters(subject, parse({ status: "DRAFT", counterpartyType: "PARTNER", commercialPeriod: "2024-03" }))).toBe(true);
    expect(matchesPayableFilters(subject, parse({ status: "DRAFT", commercialPeriod: "2024-04" }))).toBe(false);
    expect(matchesPayableFilters(subject, parse({}))).toBe(true);
  });

  it("rejects an unknown filter key and an invalid value rather than silently ignoring them", () => {
    expect(listPayablesQuerySchema.safeParse({ somethingElse: "x" }).success).toBe(false);
    expect(listPayablesQuerySchema.safeParse({ status: "APPROVED" }).success).toBe(false);
    expect(listPayablesQuerySchema.safeParse({ commercialPeriod: "2024-13" }).success).toBe(false);
    expect(listPayablesQuerySchema.safeParse({ limit: 500 }).success).toBe(false);
  });
});

describe("the deterministic total order", () => {
  it("is newest update first, then the period, then the opaque ref", () => {
    const older = head({ payableRef: "pay_00000000000000000001", updatedAt: "2024-04-01T00:00:00.000Z" });
    const newer = head({ payableRef: "pay_00000000000000000002", updatedAt: "2024-04-05T00:00:00.000Z" });
    expect([older, newer].sort(comparePayableHeads).map((entry) => entry.payableRef)).toEqual(["pay_00000000000000000002", "pay_00000000000000000001"]);

    const samePeriodA = head({ payableRef: "pay_0000000000000000000a" });
    const samePeriodB = head({ payableRef: "pay_0000000000000000000b" });
    expect([samePeriodB, samePeriodA].sort(comparePayableHeads).map((entry) => entry.payableRef)).toEqual(["pay_0000000000000000000a", "pay_0000000000000000000b"]);

    const earlierPeriod = head({ payableRef: "pay_0000000000000000000c", periodKey: "2024-02", periodStart: "2024-02-01", periodEnd: "2024-02-29" });
    expect([earlierPeriod, samePeriodA].sort(comparePayableHeads).map((entry) => entry.periodKey)).toEqual(["2024-03", "2024-02"]);
  });

  it("is a total order: sorting is stable however the input is shuffled", () => {
    const heads = [head({ payableRef: "pay_0000000000000000000a" }), head({ payableRef: "pay_0000000000000000000b" }), head({ payableRef: "pay_0000000000000000000c", updatedAt: "2024-04-09T00:00:00.000Z" })];
    const forward = [...heads].sort(comparePayableHeads).map((entry) => entry.payableRef);
    const reversed = [...heads].reverse().sort(comparePayableHeads).map((entry) => entry.payableRef);
    expect(reversed).toEqual(forward);
  });
});

describe("the page cursor", () => {
  it("round-trips a deterministic offset", () => {
    for (const offset of [0, 1, 25, 999]) expect(decodePayableCursor(encodePayableCursor(offset))).toBe(offset);
    expect(encodePayableCursor(25)).toBe(encodePayableCursor(25));
  });

  it("treats an absent, malformed or tampered cursor as the first page rather than crashing", () => {
    for (const cursor of [undefined, "", "not-base64url", Buffer.from('{"offset":-3}').toString("base64url"), Buffer.from("[]").toString("base64url")]) {
      expect(decodePayableCursor(cursor)).toBe(0);
    }
  });
});

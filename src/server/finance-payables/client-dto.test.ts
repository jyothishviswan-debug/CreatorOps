import { describe, expect, it } from "vitest";

import { payableHeadDocSchema, payableLineSchema, payableVersionDocSchema } from "./types";
import { buildSnapshot } from "./testing/payable-fixtures";
import { toPayableHeadDto, toPayableLineDto, toPayableRowDto, toPayableSnapshotDto, toPayableVersionDto, toPayableVersionSummaryDto } from "./client-dto";

// Step 15A follow-up: the amount-redaction MECHANISM (every money-shaped field of a Payable DTO
// gated on options.amountsVisible) is unit-tested directly here, against the pure DTO mappers -
// never against a live actor. As of the finance_amounts widening (Partnership Manager now holds
// it, same as Head/Super Admin - see seed-access-data.ts and payable-permissions.test.ts), every
// role that can reach a Payable at all ALSO holds finance_amounts; canAccessSensitive has no
// per-user override, so no real actor can exercise the amountsVisible:false path anymore. The
// mapping code must still redact correctly for any future role/category that lacks it, so the
// mechanism is proven here structurally instead of through an unreachable live scenario.

const SNAPSHOT_WITH_MONEY = buildSnapshot({
  accountTransferFee: { applicable: true, amountMinor: 50_000, details: "Flat monthly transfer fee" },
  incentive: { applicable: true, narrative: null, slabs: [{ slabRef: "sl_00000000000000000001", metricId: "views", lowerBound: 100_000, upperBound: null, unit: "views", amountMinor: 25_000 }] },
});

const LINE = payableLineSchema.parse({
  lineRef: "pl_00000000000000000001",
  label: "Fixed component",
  category: "BASE_FIXED",
  amountMinorSigned: 5_000_000,
  source: "AGREEMENT",
  sourceRef: "agr_0123456789abcdef0123@2",
  reason: "Confirmed Agreement fixed fee.",
  actor: null,
  resolvesCode: null,
});

const VERSION = payableVersionDocSchema.parse({
  payableRef: "pay_00000000000000000001",
  version: 1,
  businessKey: "a".repeat(64),
  snapshot: SNAPSHOT_WITH_MONEY,
  determination: { state: "DETERMINISTIC", unresolved: [], blocked: [], warnings: [] },
  lines: [LINE],
  totalAmountMinorSigned: 5_000_000,
  currency: "INR",
  serviceBaseMinor: 5_000_000,
  gstMinor: 0,
  grossInvoiceExpectedMinor: 5_000_000,
  tdsMinor: 0,
  expectedNetPaymentMinor: 5_000_000,
  calculationRuleVersion: "MONTHLY_ANALYTICS_PRORATION_V1",
  openReviewCodes: [],
  changeKind: "created",
  reason: null,
  createdAt: "2024-04-03T00:00:00.000Z",
  createdByUserRef: "user-fixture",
});

const HEAD = payableHeadDocSchema.parse({
  payableRef: "pay_00000000000000000001",
  docVersion: 1,
  counterpartyType: "PARTNER",
  counterpartyRef: "partner-fixture",
  periodKey: "2024-03",
  periodStart: "2024-03-01",
  periodEnd: "2024-03-31",
  currency: "INR",
  sourceType: "PARTNER_REVIEW",
  agreementRef: "agr_0123456789abcdef0123",
  agreementVersion: 2,
  sourceReviewRef: "pr_0123456789abcdef0123",
  sourceReviewVersion: 1,
  businessKey: "a".repeat(64),
  partnerUid: "partner-fixture",
  status: "DRAFT",
  latestVersion: 1,
  display: { counterpartyName: "Fixture Partner", counterpartyNameLower: "fixture partner", totalAmountMinorSigned: 5_000_000, determinationState: "DETERMINISTIC", openReviewCount: 0, lineCount: 1, projectedAt: "2024-04-03T00:00:00.000Z" },
  createdAt: "2024-04-03T00:00:00.000Z",
  createdByUserRef: "user-fixture",
  updatedAt: "2024-04-03T00:00:00.000Z",
  updatedByUserRef: "user-fixture",
});

describe("Payable DTO amount redaction - visible", () => {
  const VISIBLE = { amountsVisible: true };

  it("toPayableLineDto passes the real signed amount through", () => {
    expect(toPayableLineDto(LINE, VISIBLE).amountMinorSigned).toBe(5_000_000);
  });

  it("toPayableSnapshotDto passes every money-shaped field through: fixed, transfer fee, incentive slab", () => {
    const dto = toPayableSnapshotDto(SNAPSHOT_WITH_MONEY, VISIBLE);
    expect(dto.fixedComponent!.amountMinor).toBe(5_000_000);
    expect(dto.accountTransferFee!.amountMinor).toBe(50_000);
    expect(dto.incentive!.slabs[0]!.amountMinor).toBe(25_000);
  });

  it("toPayableVersionDto / toPayableVersionSummaryDto pass the total through", () => {
    expect(toPayableVersionDto(VERSION, VISIBLE).totalAmountMinorSigned).toBe(5_000_000);
    expect(toPayableVersionSummaryDto(VERSION, VISIBLE).totalAmountMinorSigned).toBe(5_000_000);
  });

  it("toPayableVersionDto / toPayableVersionSummaryDto pass the five Step 15C tax totals through, never collapsed into one figure", () => {
    const dto = toPayableVersionDto(VERSION, VISIBLE);
    expect(dto.serviceBaseMinor).toBe(5_000_000);
    expect(dto.gstMinor).toBe(0);
    expect(dto.grossInvoiceExpectedMinor).toBe(5_000_000);
    expect(dto.tdsMinor).toBe(0);
    expect(dto.expectedNetPaymentMinor).toBe(5_000_000);
    expect(dto.calculationRuleVersion).toBe("MONTHLY_ANALYTICS_PRORATION_V1");
    const summary = toPayableVersionSummaryDto(VERSION, VISIBLE);
    expect(summary.serviceBaseMinor).toBe(5_000_000);
    expect(summary.calculationRuleVersion).toBe("MONTHLY_ANALYTICS_PRORATION_V1");
  });

  it("toPayableHeadDto / toPayableRowDto pass the total through", () => {
    expect(toPayableHeadDto(HEAD, "Fixture Partner", VISIBLE).totalAmountMinorSigned).toBe(5_000_000);
    expect(toPayableRowDto(HEAD, "Fixture Partner", VISIBLE).totalAmountMinorSigned).toBe(5_000_000);
  });
});

describe("Payable DTO amount redaction - withheld", () => {
  const WITHHELD = { amountsVisible: false };

  it("toPayableLineDto nulls the signed amount, never zeros it", () => {
    const dto = toPayableLineDto(LINE, WITHHELD);
    expect(dto.amountMinorSigned).toBeNull();
    expect(dto.amountMinorSigned).not.toBe(0);
  });

  it("toPayableSnapshotDto nulls every money-shaped field but keeps the non-money facts (applicable flags, details, unit, bounds)", () => {
    const dto = toPayableSnapshotDto(SNAPSHOT_WITH_MONEY, WITHHELD);
    expect(dto.fixedComponent).toEqual({ applicable: true, amountMinor: null });
    expect(dto.accountTransferFee).toEqual({ applicable: true, amountMinor: null, details: "Flat monthly transfer fee" });
    expect(dto.incentive!.slabs[0]).toEqual({ slabRef: "sl_00000000000000000001", metricId: "views", lowerBound: 100_000, upperBound: null, unit: "views", amountMinor: null });
    // Non-money evidence is fully intact - the workflow stays operable without amounts.
    expect(dto.qualifyingContent).toEqual(SNAPSHOT_WITH_MONEY.qualifyingContent);
    expect(dto.currency).toBe("INR");
  });

  it("toPayableVersionDto / toPayableVersionSummaryDto null the total and cascade into every line", () => {
    const version = toPayableVersionDto(VERSION, WITHHELD);
    expect(version.totalAmountMinorSigned).toBeNull();
    expect(version.lines[0]!.amountMinorSigned).toBeNull();
    expect(version.snapshot.fixedComponent!.amountMinor).toBeNull();
    expect(toPayableVersionSummaryDto(VERSION, WITHHELD).totalAmountMinorSigned).toBeNull();
    // Everything else on the summary/version stays visible - only money is gated.
    expect(version.determinationState).toBe("DETERMINISTIC");
    expect(toPayableVersionSummaryDto(VERSION, WITHHELD).agreementRef).toBe("agr_0123456789abcdef0123");
  });

  it("toPayableVersionDto / toPayableVersionSummaryDto null every Step 15C tax total, but keep calculationRuleVersion (not money) visible", () => {
    const version = toPayableVersionDto(VERSION, WITHHELD);
    expect(version.serviceBaseMinor).toBeNull();
    expect(version.gstMinor).toBeNull();
    expect(version.grossInvoiceExpectedMinor).toBeNull();
    expect(version.tdsMinor).toBeNull();
    expect(version.expectedNetPaymentMinor).toBeNull();
    expect(version.calculationRuleVersion).toBe("MONTHLY_ANALYTICS_PRORATION_V1");
    const summary = toPayableVersionSummaryDto(VERSION, WITHHELD);
    expect(summary.serviceBaseMinor).toBeNull();
    expect(summary.calculationRuleVersion).toBe("MONTHLY_ANALYTICS_PRORATION_V1");
  });

  it("toPayableHeadDto / toPayableRowDto null the total but keep status/workflow fields visible", () => {
    const head = toPayableHeadDto(HEAD, "Fixture Partner", WITHHELD);
    expect(head.totalAmountMinorSigned).toBeNull();
    expect(head.status).toBe("DRAFT");
    const row = toPayableRowDto(HEAD, "Fixture Partner", WITHHELD);
    expect(row.totalAmountMinorSigned).toBeNull();
    expect(row.status).toBe("DRAFT");
  });

  it("never leaks the real figure under a different key: a withheld version's JSON contains no trace of 5000000, 50000 or 25000", () => {
    const serialized = JSON.stringify(toPayableVersionDto(VERSION, WITHHELD));
    for (const real of ["5000000", "50000", "25000"]) expect(serialized).not.toContain(real);
  });
});

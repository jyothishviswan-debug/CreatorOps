import { describe, expect, it } from "vitest";

import type { AgreementDraftEntryDto } from "@/server/finance-agreements/client-dto";
import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import { buildFieldViewModels } from "../field-view-model";
import { fieldLabel } from "../format";
import type { IntakeCounterparty, LocalEdits } from "./intake-logic";
import { buildReadiness, buildReviewGroups, clip, confirmDisabledReason, describeResolved, draftResolver, frozenResolver, sourceModeHint, type BuildReviewInput } from "./review-summary";

function entry(over: Partial<AgreementDraftEntryDto> = {}): AgreementDraftEntryDto {
  return { value: null, origin: "MANUAL", decision: "PENDING", extractedValue: null, decidedByUserRef: null, decidedAt: null, provenance: { label: "Manual entry", extractionRunRef: null, page: null, confidence: null }, ...over };
}
const decided = (value: unknown, over: Partial<AgreementDraftEntryDto> = {}) => entry({ value, decision: "ACCEPTED", ...over });

const partner: IntakeCounterparty = { type: "PARTNER", ref: "p1", displayName: "Acme Media", platforms: ["instagram", "youtube"], accountRefs: ["a1"], mode: "account-specific" };
const models = (draft: Partial<Record<AgreementFieldKey, AgreementDraftEntryDto>>) => buildFieldViewModels({ draft, counterpartyType: "PARTNER" });

function input(over: Partial<BuildReviewInput> & { draft?: Partial<Record<AgreementFieldKey, AgreementDraftEntryDto>>; edits?: LocalEdits } = {}): BuildReviewInput {
  const all = models(over.draft ?? {});
  return {
    counterparty: partner,
    version: { confirmed: false, sourceMode: "MANUAL" },
    resolve: draftResolver(all, over.edits ?? {}),
    models: all,
    artifact: null,
    extractionStatus: null,
    extractionAttached: false,
    unresolvedCount: 0,
    kyc: null,
    fieldLabel,
    ...over,
  };
}
const group = (groups: ReturnType<typeof buildReviewGroups>, key: string) => groups.find((item) => item.key === key)!;

describe("the grouped summary", () => {
  it("has the groups the design names, in order", () => {
    expect(buildReviewGroups(input()).map((item) => item.key)).toEqual(["counterparty", "scope", "artifact", "discrepancies", "kyc", "terms", "targets", "dates", "source"]);
  });

  it("names the counterparty and the platform / account scope explicitly", () => {
    const groups = buildReviewGroups(input());
    expect(group(groups, "counterparty").rows).toEqual([{ label: "Partner", text: "Acme Media" }]);
    expect(group(groups, "scope").rows.map((row) => row.text)).toEqual(["Account-specific", "Instagram + YouTube"]);
    const vendor = buildReviewGroups(input({ counterparty: { type: "VENDOR", ref: "v1", displayName: "Studio Co", platforms: [], accountRefs: [], mode: "vendor" } }));
    expect(group(vendor, "counterparty").rows[0]).toEqual({ label: "Vendor", text: "Studio Co" });
    expect(group(vendor, "scope").rows[0]!.text).toContain("Vendor");
  });

  it("states the contract artifact and extraction status, or that entry is manual", () => {
    expect(group(buildReviewGroups(input()), "artifact").rows[0]!.text).toContain("manual entry");
    const groups = buildReviewGroups(input({ artifact: { fileName: "agreement.pdf", status: "EXTRACTED" }, extractionStatus: "PARTIAL", extractionAttached: true }));
    const rows = group(groups, "artifact").rows;
    expect(rows[0]!.text).toBe("agreement.pdf");
    expect(rows[1]).toMatchObject({ text: "Attached to this draft", chip: { label: "Partial" } });
  });

  it("counts unresolved discrepancies", () => {
    expect(group(buildReviewGroups(input({ unresolvedCount: 3 })), "discrepancies").chip).toEqual({ label: "3 open", tone: "orange" });
    expect(group(buildReviewGroups(input()), "discrepancies").chip?.label).toBe("None");
  });

  it("shows KYC readiness as status text only", () => {
    const groups = buildReviewGroups(input({ kyc: { state: "INCOMPLETE", components: { pan: "PRESENT", aadhaar: "MISSING", gst: "NOT_APPLICABLE", bank: "PRESENT" } } }));
    expect(group(groups, "kyc").rows.map((row) => `${row.label}: ${row.text}`)).toEqual(["Status: Incomplete", "PAN: Available", "Aadhaar: Missing", "Bank details: Available", "GST certificate: Not applicable"]);
    expect(group(buildReviewGroups(input()), "kyc").rows[0]!.text).toBe("Not loaded yet");
  });

  it("lists every payment-affecting term with what it currently resolves to", () => {
    const groups = buildReviewGroups(
      input({
        draft: {
          currency: decided("INR"),
          paymentCycle: decided("MONTHLY"),
          fixedComponent: decided({ applicable: true, amountMinor: 3500000 }),
          incentive: entry({ decision: "NOT_APPLICABLE" }),
          qualifyingUnit: entry({ decision: "UNAVAILABLE" }),
        },
      }),
    );
    const byLabel = Object.fromEntries(group(groups, "terms").rows.map((row) => [row.label, row.text]));
    expect(byLabel["Currency"]).toBe("INR");
    expect(byLabel["Payment cycle"]).toBe("Monthly");
    expect(byLabel["Fixed component"]).toBe("₹35,000");
    expect(byLabel["Incentive slabs"]).toBe("Not applicable");
    expect(byLabel["Qualifying unit"]).toBe("Unavailable");
    expect(byLabel["Monthly required qualifying content"]).toBe("Not decided yet");
    expect(group(groups, "terms").rows).toHaveLength(13);
  });

  it("keeps warning-only targets in their own group, worded as monitoring only", () => {
    const groups = buildReviewGroups(input({ draft: { performanceTargets: decided([{ targetRef: "t", metricId: "views", targetValue: 100, unit: "views", comparison: "at_least", affectsPayment: false }]) } }));
    expect(group(groups, "targets").chip?.label).toBe("Monitoring only · does not affect payment");
    expect(group(groups, "targets").rows[0]!.text).toBe("views: at least 100 views");
    expect(group(groups, "terms").rows.some((row) => row.label.toLowerCase().includes("target"))).toBe(false);
  });

  it("shows the effective period and the signed date", () => {
    const groups = buildReviewGroups(input({ draft: { effectiveDate: decided("2026-09-01"), terminationDate: decided("2027-08-31"), signedDate: decided("2026-08-20") } }));
    expect(group(groups, "dates").rows.map((row) => row.text)).toEqual(["1 Sep 2026 – 31 Aug 2027", "20 Aug 2026"]);
    expect(group(buildReviewGroups(input()), "dates").rows[0]!.text).toBe("Not decided yet");
  });

  it("an unsaved edit is reflected in the summary", () => {
    const groups = buildReviewGroups(input({ edits: { paymentCycle: { decision: "CORRECTED", value: "QUARTERLY" } } }));
    expect(group(groups, "terms").rows.find((row) => row.label === "Payment cycle")!.text).toBe("Quarterly");
  });

  it("each summarized field links to its anchor", () => {
    const payment = group(buildReviewGroups(input()), "terms").rows;
    expect(payment.every((row) => row.anchorId?.startsWith("field-"))).toBe(true);
  });
});

describe("source mode", () => {
  const m = (origin: "EXTRACTED" | "MANUAL" | "MASTER_DATA", decision: "ACCEPTED" | "CORRECTED" | "PENDING") => ({ origin, decision }) as never;
  it("mirrors the server rule: Manual / Extracted / Mixed", () => {
    expect(sourceModeHint([])).toBe("MANUAL");
    expect(sourceModeHint([m("EXTRACTED", "PENDING")])).toBe("MANUAL");
    expect(sourceModeHint([m("EXTRACTED", "ACCEPTED"), m("MASTER_DATA", "ACCEPTED")])).toBe("EXTRACTED");
    expect(sourceModeHint([m("EXTRACTED", "ACCEPTED"), m("EXTRACTED", "CORRECTED")])).toBe("MIXED");
    expect(sourceModeHint([m("EXTRACTED", "ACCEPTED"), m("MANUAL", "ACCEPTED")])).toBe("MIXED");
  });
  it("a confirmed version shows its recorded mode", () => {
    const groups = buildReviewGroups(input({ version: { confirmed: true, sourceMode: "MIXED" } }));
    expect(group(groups, "source").rows[0]).toEqual({ label: "Recorded", text: "Mixed" });
    expect(group(buildReviewGroups(input()), "source").rows[0]).toEqual({ label: "So far", text: "Manual" });
  });
});

describe("frozen (confirmed) terms", () => {
  it("resolves from the terms and the recorded decisions", () => {
    const resolve = frozenResolver({
      terms: { commercial: { currency: "INR", paymentCycle: "MONTHLY" } } as never,
      contactSnapshot: null,
      fieldProvenance: { incentive: { origin: "MANUAL", decision: "NOT_APPLICABLE", decidedByUserRef: null, decidedAt: null, provenance: { label: "x", extractionRunRef: null, page: null, confidence: null } } } as never,
    });
    expect(resolve("currency")).toEqual({ state: "value", value: "INR" });
    expect(resolve("incentive")).toMatchObject({ state: "not_applicable" });
    expect(resolve("remarks")).toEqual({ state: "unavailable" });
  });
});

describe("readiness", () => {
  const unresolved = [
    { fieldKey: "paymentCycle" as const, label: "Payment cycle" },
    { fieldKey: "currency" as const, label: "Currency" },
  ];
  it("lists every unresolved field with a jump anchor", () => {
    const items = buildReadiness({ unresolved, localEdits: {}, commercialIssues: [] });
    expect(items).toEqual([
      { message: "Payment cycle needs a decision.", anchorId: "field-paymentCycle" },
      { message: "Currency needs a decision.", anchorId: "field-currency" },
    ]);
    expect(confirmDisabledReason(items)).toBe("2 items need attention before this Agreement can be confirmed.");
  });
  it("a field with an unsaved edit counts as decided (Confirm saves it first)", () => {
    const items = buildReadiness({ unresolved, localEdits: { paymentCycle: { decision: "CORRECTED", value: "MONTHLY" } }, commercialIssues: [] });
    expect(items.map((item) => item.anchorId)).toEqual(["field-currency"]);
    expect(confirmDisabledReason(items)).toBe("1 item needs attention before this Agreement can be confirmed.");
  });
  it("cross-field problems block too, and nothing blocks a clean draft", () => {
    const items = buildReadiness({ unresolved: [], localEdits: {}, commercialIssues: [{ fieldKey: "currency", message: "A currency is required when any amount is present." }] });
    expect(items).toEqual([{ message: "A currency is required when any amount is present.", anchorId: "field-currency" }]);
    expect(confirmDisabledReason([])).toBeNull();
  });
});

describe("helpers", () => {
  it("clips long text in the summary", () => {
    expect(clip("short")).toBe("short");
    expect(clip("x".repeat(200)).endsWith("…")).toBe(true);
    expect(clip("x".repeat(200)).length).toBeLessThan(150);
  });
  it("describes each resolution state in words", () => {
    expect(describeResolved("currency", { state: "undecided" }, null)).toBe("Not decided yet");
    expect(describeResolved("currency", { state: "unavailable" }, null)).toBe("Unavailable");
    expect(describeResolved("currency", { state: "not_applicable", value: null }, null)).toBe("Not applicable");
    expect(describeResolved("fixedComponent", { state: "value", value: { applicable: true, amountMinor: 100 } }, "INR")).toBe("₹1");
  });
});

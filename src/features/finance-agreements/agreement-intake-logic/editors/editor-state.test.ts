import { describe, expect, it } from "vitest";

import { AGREEMENT_FIELD_KEYS } from "@/server/finance-agreements/fields";

import { editorKindFor } from "../../field-view-model";
import { blankLfcSfcRow, blankSlab, blankTarget, editorStateToValue, hasValueEditor, initialEditorState, isEditorStateBlank, splitPlatformText } from "./editor-state";
import { valueLines } from "./value-lines";
import { OTHER_METRIC_OPTION, TARGET_METRICS, defaultUnitForMetric, isKnownTargetMetric, metricSelectValue, targetMetricLabel } from "../../target-metrics";

const value = (fieldKey: Parameters<typeof editorStateToValue>[0], state: Parameters<typeof editorStateToValue>[2]) => editorStateToValue(fieldKey, editorKindFor(fieldKey), state);

describe("which fields get a value editor", () => {
  it("every DECIDED non-identity registry field has one; identity values and computed fields have none", () => {
    for (const key of AGREEMENT_FIELD_KEYS) {
      const kind = editorKindFor(key);
      if (kind === "acknowledge" || kind === "computed") expect(hasValueEditor(kind), key).toBe(false);
      else expect(hasValueEditor(kind), key).toBe(true);
    }
  });
});

describe("text-like editors", () => {
  it("trims and validates plain text with the registry limits", () => {
    expect(value("counterpartyName", { kind: "text", text: "  Acme Media  " })).toEqual({ ok: true, value: "Acme Media" });
    const tooLong = value("counterpartyName", { kind: "text", text: "x".repeat(201) });
    expect(tooLong.ok).toBe(false);
    expect(value("pinCode", { kind: "text", text: "12345" }).ok).toBe(false);
    expect(value("pinCode", { kind: "text", text: "560001" })).toEqual({ ok: true, value: "560001" });
  });

  it("validates dates, currency, payment cycle and counts", () => {
    expect(value("effectiveDate", { kind: "text", text: "2026-09-01" })).toEqual({ ok: true, value: "2026-09-01" });
    expect(value("effectiveDate", { kind: "text", text: "2026-02-30" }).ok).toBe(false);
    expect(value("currency", { kind: "text", text: "inr" })).toEqual({ ok: true, value: "INR" });
    expect(value("currency", { kind: "text", text: "rupee" }).ok).toBe(false);
    expect(value("paymentCycle", { kind: "text", text: "MONTHLY" })).toEqual({ ok: true, value: "MONTHLY" });
    expect(value("paymentCycle", { kind: "text", text: "DAILY" }).ok).toBe(false);
    expect(value("monthlyRequiredQualifyingContentCount", { kind: "text", text: "12" })).toEqual({ ok: true, value: 12 });
    expect(value("monthlyRequiredQualifyingContentCount", { kind: "text", text: "1.5" }).ok).toBe(false);
  });

  it("the qualifying unit accepts ONLY the two supported units (never free text such as reel)", () => {
    expect(value("qualifyingUnit", { kind: "text", text: "approved_content_thread" }).ok).toBe(true);
    expect(value("qualifyingUnit", { kind: "text", text: "approved_current_link" }).ok).toBe(true);
    expect(value("qualifyingUnit", { kind: "text", text: "reel" }).ok).toBe(false);
    expect(value("qualifyingUnit", { kind: "text", text: "" }).ok).toBe(false);
  });

  it("opens an unsupported qualifying unit BLANK (never pre-mapped) and a supported one as is", () => {
    expect(initialEditorState("qualifyingUnit", "qualifyingUnit", "reel")).toEqual({ kind: "text", text: "" });
    expect(initialEditorState("qualifyingUnit", "qualifyingUnit", "approved_current_link")).toEqual({ kind: "text", text: "approved_current_link" });
  });

  it("booleans need a choice", () => {
    expect(value("invoiceRequired", { kind: "boolean", value: null }).ok).toBe(false);
    expect(value("invoiceRequired", { kind: "boolean", value: false })).toEqual({ ok: true, value: false });
    expect(initialEditorState("invoiceRequired", "boolean", true)).toEqual({ kind: "boolean", value: true });
  });

  it("platforms are split, normalized and de-duplication is reported", () => {
    expect(splitPlatformText(" Instagram, YouTube\nfacebook ,, ")).toEqual(["Instagram", "YouTube", "facebook"]);
    expect(value("platforms", { kind: "platforms", text: "Instagram, YouTube" })).toEqual({ ok: true, value: ["instagram", "youtube"] });
    expect(value("platforms", { kind: "platforms", text: "instagram, Instagram" }).ok).toBe(false);
    expect(value("platforms", { kind: "platforms", text: "" }).ok).toBe(false);
    expect(initialEditorState("platforms", "platforms", ["instagram", "youtube"])).toEqual({ kind: "platforms", text: "instagram, youtube" });
  });
});

describe("money editors (rupees <-> integer minor units, no floats)", () => {
  it("fixed component: rupees become exact minor units", () => {
    expect(value("fixedComponent", { kind: "money", draft: { applicable: true, amountText: "35,000.50" } })).toEqual({ ok: true, value: { applicable: true, amountMinor: 3500050 } });
    expect(value("fixedComponent", { kind: "money", draft: { applicable: true, amountText: "19.99" } })).toEqual({ ok: true, value: { applicable: true, amountMinor: 1999 } });
    expect(value("fixedComponent", { kind: "money", draft: { applicable: true, amountText: "" } }).ok).toBe(false);
    expect(value("fixedComponent", { kind: "money", draft: { applicable: true, amountText: "10.005" } }).ok).toBe(false);
  });

  it("the editor always states the component as applicable (Not applicable is a decision, not an editor state)", () => {
    const result = value("fixedComponent", { kind: "money", draft: { applicable: false, amountText: "500" } });
    expect(result).toEqual({ ok: true, value: { applicable: true, amountMinor: 50000 } });
  });

  it("account transfer fee and advance payment take an amount OR details", () => {
    expect(value("accountTransferFee", { kind: "money", draft: { applicable: true, amountText: "", details: "" } }).ok).toBe(false);
    expect(value("accountTransferFee", { kind: "money", draft: { applicable: true, amountText: "", details: "Bank charges apply" } })).toEqual({ ok: true, value: { applicable: true, amountMinor: null, details: "Bank charges apply" } });
    expect(value("advancePayment", { kind: "money", draft: { applicable: true, amountText: "10000", details: "" } })).toEqual({ ok: true, value: { applicable: true, details: null, amountMinor: 1000000 } });
  });

  it("opens with the stored amount as rupee text", () => {
    expect(initialEditorState("fixedComponent", "fixedComponent", { applicable: true, amountMinor: 3500050 })).toEqual({ kind: "money", draft: { applicable: true, amountText: "35000.50", details: "" } });
    expect(initialEditorState("advancePayment", "advancePayment", null)).toEqual({ kind: "money", draft: { applicable: true, amountText: "", details: "" } });
  });
});

describe("incentive slabs", () => {
  const slab = { metricId: "views", lowerBoundText: "1000", upperBoundText: "5000", unit: "views", amountText: "2500", description: "" };
  it("builds slabs with exact minor units and refs, and needs at least one", () => {
    const result = value("incentive", { kind: "incentive", narrativeText: "", slabs: [slab] });
    expect(result).toEqual({ ok: true, value: { applicable: true, narrative: null, slabs: [{ slabRef: "slab-1", metricId: "views", lowerBound: 1000, upperBound: 5000, unit: "views", amountMinor: 250000, description: null }] } });
    expect(value("incentive", { kind: "incentive", narrativeText: "", slabs: [] }).ok).toBe(false);
  });
  it("reports bounds and blanks per slab", () => {
    const bad = value("incentive", { kind: "incentive", narrativeText: "", slabs: [{ ...slab, upperBoundText: "500" }, { ...blankSlab() }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.some((message) => message.includes("Slab 1") && message.includes("upper bound"))).toBe(true);
      expect(bad.errors.some((message) => message.includes("Slab 2"))).toBe(true);
    }
  });
  it("round-trips a stored value into the editor and back", () => {
    const stored = { applicable: true, narrative: null, slabs: [{ slabRef: "s1", metricId: "reach", lowerBound: 0, upperBound: null, unit: "accounts", amountMinor: 100050, description: "Base" }] };
    const state = initialEditorState("incentive", "incentive", stored);
    expect(state).toEqual({ kind: "incentive", narrativeText: "", slabs: [{ slabRef: "s1", metricId: "reach", lowerBoundText: "0", upperBoundText: "", unit: "accounts", amountText: "1000.50", description: "Base" }] });
    expect(value("incentive", state)).toEqual({ ok: true, value: stored });
  });
});

describe("LFC / SFC (explicit rules only)", () => {
  it("needs at least one format and rejects duplicates", () => {
    expect(value("lfcSfc", { kind: "lfcSfc", ruleRef: "", rows: [] }).ok).toBe(false);
    expect(value("lfcSfc", { kind: "lfcSfc", ruleRef: "", rows: [{ format: "Reel", kind: "SFC" }, { format: "Reel", kind: "LFC" }] }).ok).toBe(false);
    expect(value("lfcSfc", { kind: "lfcSfc", ruleRef: "R1", rows: [{ format: "Reel", kind: "SFC" }, { format: "Video", kind: "LFC" }] })).toEqual({ ok: true, value: { ruleRef: "R1", byFormat: { Reel: "SFC", Video: "LFC" } } });
    expect(blankLfcSfcRow()).toEqual({ format: "", kind: "LFC" });
  });
  it("opens with the stored rows", () => {
    expect(initialEditorState("lfcSfc", "lfcSfc", { ruleRef: "R1", byFormat: { Reel: "SFC" } })).toEqual({ kind: "lfcSfc", ruleRef: "R1", rows: [{ format: "Reel", kind: "SFC" }] });
  });
});

describe("performance targets (monitoring only, never payment)", () => {
  it("builds targets that ALWAYS carry affectsPayment:false and comparison at_least", () => {
    const result = value("performanceTargets", { kind: "targets", rows: [{ metricId: "followerGrowth", targetValueText: "1,000", unit: "followers" }] });
    expect(result).toEqual({ ok: true, value: [{ targetRef: "target-1", metricId: "followerGrowth", targetValue: 1000, unit: "followers", comparison: "at_least", period: null, anchor: null, affectsPayment: false }] });
  });
  it("the editor state has no way to carry affectsPayment", () => {
    expect(Object.keys(blankTarget()).sort()).toEqual(["metricId", "targetValueText", "unit"]);
    const stored = [{ targetRef: "t1", metricId: "views", targetValue: 100000, unit: "views", comparison: "at_least", period: null, anchor: null, affectsPayment: false }];
    const state = initialEditorState("performanceTargets", "performanceTargets", stored);
    expect(JSON.stringify(state)).not.toContain("affectsPayment");
    expect(value("performanceTargets", state)).toEqual({ ok: true, value: stored });
  });
  it("reports blanks per row", () => {
    const bad = value("performanceTargets", { kind: "targets", rows: [blankTarget()] });
    expect(bad.ok).toBe(false);
  });
});

describe("blank detection", () => {
  it("an untouched editor is blank (no error wall)", () => {
    expect(isEditorStateBlank({ kind: "text", text: "  " })).toBe(true);
    expect(isEditorStateBlank({ kind: "boolean", value: null })).toBe(true);
    expect(isEditorStateBlank({ kind: "money", draft: { applicable: true, amountText: "", details: "" } })).toBe(true);
    expect(isEditorStateBlank({ kind: "incentive", narrativeText: "", slabs: [] })).toBe(true);
    expect(isEditorStateBlank({ kind: "targets", rows: [blankTarget()] })).toBe(false);
    expect(isEditorStateBlank({ kind: "text", text: "x" })).toBe(false);
  });
});

describe("value lines", () => {
  it("scalars are one line; structured values are one line per row", () => {
    expect(valueLines("currency", "INR")).toEqual(["INR"]);
    expect(valueLines("currency", null)).toEqual(["—"]);
    // Step 14C.3: a known metric id (views, reach, ...) is shown with its human label, never the raw id, in both
    // incentive slabs and performance targets.
    const slabs = { applicable: true, slabs: [{ slabRef: "a", metricId: "views", lowerBound: 0, upperBound: 10, unit: "views", amountMinor: 100000, description: null }, { slabRef: "b", metricId: "views", lowerBound: 10, upperBound: null, unit: "views", amountMinor: 200000, description: null }] };
    expect(valueLines("incentive", slabs, { currency: "INR" })).toEqual(["Views: 0–10 views → ₹1,000", "Views: 10+ views → ₹2,000"]);
    expect(valueLines("performanceTargets", [{ targetRef: "t", metricId: "reach", targetValue: 5, unit: "accounts", comparison: "at_least", affectsPayment: false }])).toEqual(["Reach: at least 5 accounts · Period not specified"]);
    expect(valueLines("performanceTargets", [{ targetRef: "t", metricId: "reach", targetValue: 5, unit: "accounts", comparison: "at_least", period: "Every 30 days", affectsPayment: false }])).toEqual(["Reach: at least 5 accounts · Every 30 days"]);
    expect(valueLines("lfcSfc", { byFormat: { Reel: "SFC", Video: "LFC" } })).toEqual(["Reel: SFC", "Video: LFC"]);
    expect(valueLines("qualifyingUnit", "reel")).toEqual(["reel"]);
    expect(valueLines("qualifyingUnit", "approved_content_thread")).toEqual(["Approved Content"]);
  });
});

describe("target metrics", () => {
  it("lists the Analytics-backed metrics and treats anything else as an 'other' metric id", () => {
    expect(TARGET_METRICS.map((metric) => metric.id)).toEqual(["followerGrowth", "reach", "views", "engagement", "likes", "comments"]);
    expect(isKnownTargetMetric("views")).toBe(true);
    expect(isKnownTargetMetric("saves")).toBe(false);
    expect(targetMetricLabel("followerGrowth")).toBe("Follower growth");
    expect(targetMetricLabel("saves")).toBe("saves");
    expect(defaultUnitForMetric("engagement")).toBe("%");
    expect(defaultUnitForMetric("saves")).toBe("");
    expect(metricSelectValue("views", false)).toBe("views");
    expect(metricSelectValue("saves", false)).toBe(OTHER_METRIC_OPTION);
    expect(metricSelectValue("", true)).toBe(OTHER_METRIC_OPTION);
    expect(metricSelectValue("", false)).toBe("");
  });
});

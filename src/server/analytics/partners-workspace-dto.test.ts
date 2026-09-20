import { describe, expect, it } from "vitest";

import { buildPartnersWorkspaceDto, INVALID_MONTH_NOTICE, overLimitNotice, TRUNCATION_DISCLOSURE, unavailablePartnersNotice, type BuildWorkspaceParams } from "./partners-workspace-dto";
import { channelRecord, contentRecord, month } from "./partners-workspace-fixtures";
import type { PartnerRecordWindow } from "./partners-workspace-metrics";
import { parseWorkspaceParams, type WorkspaceParamsInput } from "./partners-workspace-params";

const win = (content: PartnerRecordWindow["content"] = [], channel: PartnerRecordWindow["channel"] = [], truncated = false): PartnerRecordWindow => ({ content, channel, truncated });
const partner = (ref: string, displayName: string) => ({ ref, displayName, regions: ["Kerala"], targetAudience: ["India 1" as const] });

function build(params: WorkspaceParamsInput, extra: Partial<BuildWorkspaceParams> & { selected: BuildWorkspaceParams["selected"]; windows: PartnerRecordWindow[] }) {
  return buildPartnersWorkspaceDto({ state: parseWorkspaceParams(params), unavailableCount: 0, contextWindows: extra.windows, single: null, ...extra });
}

// Three Partners: A has July + August data, B only July, C only a channel snapshot in August.
const A = win(
  [contentRecord({ platform: "instagram", views: 100, reportingPeriod: month("2019-08") }), contentRecord({ platform: "youtube", views: 200, reportingPeriod: month("2019-07") })],
  [channelRecord({ reportingPeriod: month("2019-08") })],
);
const B = win([contentRecord({ platform: "instagram", views: 5, reportingPeriod: month("2019-07") })]);
const C = win([], [channelRecord({ reportingPeriod: month("2019-08"), createdAt: "2019-09-01T00:00:00.000Z" })]);
const selected = [partner("ref-a", "Alpha"), partner("ref-b", "Beta"), partner("ref-c", "Gamma")];

describe("month default - from imported data, follows the selection context, explicit is never changed", () => {
  it("defaults to the latest month with data in the CURRENT context (data from 2019, not today's calendar month)", () => {
    const dto = build({ partners: "ref-a,ref-b,ref-c" }, { selected, windows: [A, B, C] });
    expect(dto.month).toMatchObject({ resolved: "2019-08", label: "August 2019", source: "latest_default", sourceLabel: "Latest reporting month with data" });
    expect(dto.month.options.map((o) => o.month)).toEqual(["2019-08", "2019-07"]);
    expect(dto.month.resolved).not.toBe(new Date().toISOString().slice(0, 7));
  });
  it("the default follows the selection: Partners with only July data default to July", () => {
    const dto = build({ partners: "ref-b" }, { selected: [selected[1]!], windows: [B] });
    expect(dto.month).toMatchObject({ resolved: "2019-07", source: "latest_default" });
  });
  it("an explicit month is honored exactly - even with no data (then it stays, flagged) - and is never replaced by the default", () => {
    const dto = build({ partners: "ref-a", month: "2019-07" }, { selected: [selected[0]!], windows: [A] });
    expect(dto.month).toMatchObject({ resolved: "2019-07", source: "explicit", sourceLabel: "Selected month" });
    const empty = build({ partners: "ref-a", month: "2030-01" }, { selected: [selected[0]!], windows: [A] });
    expect(empty.month).toMatchObject({ resolved: "2030-01", source: "explicit" });
    expect(empty.month.options.find((o) => o.month === "2030-01")).toMatchObject({ hasData: false, selected: true });
    expect(empty.coverage.text).toBe("0 of 1 selected Partner has Analytics data for January 2030");
  });
  it("an invalid month is treated as absent with a neutral notice", () => {
    const dto = build({ partners: "ref-a", month: "2019-13" }, { selected: [selected[0]!], windows: [A] });
    expect(dto.month.source).toBe("latest_default");
    expect(dto.notices).toContain(INVALID_MONTH_NOTICE);
  });
  it("nothing selected and nothing in the scope yields 'No reporting month with data yet'", () => {
    const dto = build({}, { selected: [], windows: [], contextWindows: [win()] });
    expect(dto.month).toMatchObject({ resolved: null, label: null, source: "none", sourceLabel: "No reporting month with data yet", options: [] });
    expect(dto.mode).toBe("empty");
    expect(dto.coverage.text).toBeNull();
  });
  it("with no selection the month list comes from the whole-scope context windows", () => {
    const dto = build({}, { selected: [], windows: [], contextWindows: [win([contentRecord({ reportingPeriod: month("2018-11") })])] });
    expect(dto.month).toMatchObject({ resolved: "2018-11", source: "latest_default" });
  });
});

describe("coverage - x of y over the SELECTED Partners, never dropping one", () => {
  it("counts Partners with >= 1 in-month record (content OR channel) and keeps every row", () => {
    const dto = build({ partners: "ref-a,ref-b,ref-c", month: "2019-08" }, { selected, windows: [A, B, C] });
    expect(dto.coverage).toMatchObject({ selectedCount: 3, withDataCount: 2, text: "2 of 3 selected Partners have Analytics data for August 2019" });
    expect(dto.comparison!.table.rows.map((r) => [r.displayName, r.coverage.state])).toEqual([
      ["Alpha", "content_and_channel"],
      ["Beta", "no_data"],
      ["Gamma", "channel_only"],
    ]);
  });
  it("row order is the selection order", () => {
    const dto = build({ partners: "ref-c,ref-a,ref-b" }, { selected: [selected[2]!, selected[0]!, selected[1]!], windows: [C, A, B] });
    expect(dto.comparison!.table.rows.map((r) => r.displayName)).toEqual(["Gamma", "Alpha", "Beta"]);
  });
  it("the platform filter changes what counts as data - even a caller-supplied mixed window is restricted", () => {
    const dto = build({ partners: "ref-a", month: "2019-07", platform: "instagram" }, { selected: [selected[0]!], windows: [A] });
    expect(dto.coverage.text).toBe("0 of 1 selected Partner has Instagram Analytics data for July 2019");
    // ...and the month default follows the platform-filtered context (YouTube had 2019-07, Instagram only 2019-08).
    const yt = build({ partners: "ref-a", platform: "youtube" }, { selected: [selected[0]!], windows: [A] });
    expect(yt.month).toMatchObject({ resolved: "2019-07", source: "latest_default" });
  });
});

describe("modes and the selector contract", () => {
  it("0 / 1 / 2+ selected Partners map to empty / single / comparison", () => {
    expect(build({}, { selected: [], windows: [] }).mode).toBe("empty");
    expect(build({ partners: "ref-a" }, { selected: [selected[0]!], windows: [A] }).mode).toBe("single");
    expect(build({ partners: "ref-a,ref-b" }, { selected: selected.slice(0, 2), windows: [A, B] }).mode).toBe("comparison");
  });
  it("only a single selection offers 'Open full Partner Analytics', carrying the resolved month and the platform", () => {
    const one = build({ partners: "ref-a", platform: "youtube" }, { selected: [selected[0]!], windows: [A] });
    expect(one.links.openFullPartnerHref).toBe("/analytics/partner/ref-a?platform=youtube&month=2019-07"); // YouTube's own latest month with data
    const explicit = build({ partners: "ref-a", month: "2019-08" }, { selected: [selected[0]!], windows: [A] });
    expect(explicit.links.openFullPartnerHref).toBe("/analytics/partner/ref-a?month=2019-08");
    const many = build({ partners: "ref-a,ref-b" }, { selected: selected.slice(0, 2), windows: [A, B] });
    expect(many.links.openFullPartnerHref).toBeNull();
    expect(many.comparison!.table.rows[0]!.analyticsHref).toBe("/analytics/partner/ref-a?month=2019-08");
  });
  it("platform switch links preserve selection, filters and an EXPLICIT month (a default month keeps following the data)", () => {
    const dto = build({ partners: "ref-a,ref-b", month: "2019-07", targetAudience: ["India 1"], region: "Kerala" }, { selected: selected.slice(0, 2), windows: [A, B] });
    const hrefs = dto.links.platformSwitch.map((item) => [item.selection, item.href, item.active]);
    expect(hrefs).toEqual([
      ["all", "/analytics/partners?partners=ref-a%2Cref-b&month=2019-07&targetAudience=India+1&region=Kerala", true],
      ["instagram", "/analytics/partners?partners=ref-a%2Cref-b&month=2019-07&platform=instagram&targetAudience=India+1&region=Kerala", false],
      ["youtube", "/analytics/partners?partners=ref-a%2Cref-b&month=2019-07&platform=youtube&targetAudience=India+1&region=Kerala", false],
    ]);
    const auto = build({ partners: "ref-a,ref-b" }, { selected: selected.slice(0, 2), windows: [A, B] });
    expect(auto.links.platformSwitch[1]!.href).toBe("/analytics/partners?partners=ref-a%2Cref-b&platform=instagram");
  });
  it("the selector carries the validated state and safe display identity only", () => {
    const dto = build({ partners: "ref-a", targetAudience: ["India 1", "bogus"], month: "2019-07" }, { selected: [selected[0]!], windows: [A] });
    expect(dto.selector.limit).toBe(10);
    expect(dto.selector.state).toEqual({ partnerRefs: ["ref-a"], month: "2019-07", platform: "all", targetAudience: ["India 1"], regions: [], metric: "engagement" });
    expect(dto.selector.selected).toEqual([{ ref: "ref-a", displayName: "Alpha", regions: ["Kerala"], targetAudience: ["India 1"] }]);
  });
  it("the metric switch exists only in comparison mode and keeps ONE active metric", () => {
    expect(build({ partners: "ref-a" }, { selected: [selected[0]!], windows: [A] }).links.metricSwitch).toBeNull();
    const dto = build({ partners: "ref-a,ref-b", metric: "views" }, { selected: selected.slice(0, 2), windows: [A, B] });
    expect(dto.links.metricSwitch!.map((i) => [i.metric, i.active])).toEqual([["views", true], ["engagement", false], ["likes", false], ["comments", false]]);
    expect(dto.comparison!.metric).toBe("views");
    expect(dto.comparison!.matrices.map((m) => m.title)).toEqual(["Instagram Views", "YouTube Views"]);
  });
  it("clearing the selection keeps filters / platform / explicit month", () => {
    const dto = build({ partners: "ref-a", month: "2019-07", platform: "instagram", region: "Kerala" }, { selected: [selected[0]!], windows: [A] });
    expect(dto.links.clearSelectionHref).toBe("/analytics/partners?month=2019-07&platform=instagram&region=Kerala");
  });
});

describe("notices are neutral and existence-free", () => {
  it("unavailable Partners (unknown, out of scope and malformed collapse into one count)", () => {
    expect(unavailablePartnersNotice(1)).toBe("1 selected Partner is not available");
    expect(unavailablePartnersNotice(2)).toBe("2 selected Partners are not available");
    const dto = build({ partners: `ref-a,${"x".repeat(300)}` }, { selected: [selected[0]!], windows: [A], unavailableCount: 2 });
    expect(dto.notices).toEqual(["3 selected Partners are not available"]);
  });
  it("over-limit refs are ignored with a disclosed notice", () => {
    expect(overLimitNotice(1)).toBe("Only the first 10 selected Partners are shown; 1 more was ignored");
    const refs = Array.from({ length: 12 }, (_, i) => `p${i}`).join(",");
    const dto = build({ partners: refs }, { selected: [selected[0]!], windows: [A] });
    expect(dto.notices).toContain("Only the first 10 selected Partners are shown; 2 more were ignored");
  });
  it("a notice never carries a ref or a name", () => {
    const dto = build({ partners: "secret-ref-1,ref-a" }, { selected: [selected[0]!], windows: [A], unavailableCount: 1 });
    expect(JSON.stringify(dto.notices)).not.toContain("secret-ref-1");
  });
});

describe("month exclusions and truncation are disclosed", () => {
  it("records without a usable single-month period are counted per reason, never placed in a month", () => {
    const w = win([contentRecord({ reportingPeriod: month("2019-08") }), contentRecord({ reportingPeriod: null }), contentRecord({ reportingPeriod: { start: "2019-07-15", end: "2019-08-14" } }), contentRecord({ reportingPeriod: { start: "bad", end: "bad" } })]);
    const dto = build({ partners: "ref-a" }, { selected: [selected[0]!], windows: [w] });
    expect(dto.coverage.exclusions).toEqual({ noPeriod: 1, unparseable: 1, spans: 1 });
    expect(dto.coverage.exclusionNote).toContain("3 source records could not be placed in a single reporting month");
    expect(dto.month.options.map((o) => o.month)).toEqual(["2019-08"]);
    expect(dto.comparison).toBeNull();
    expect(build({ partners: "ref-a,ref-b" }, { selected: selected.slice(0, 2), windows: [w, B] }).comparison!.table.rows[0]!.publishedContent).toBe(1); // only the August record
  });
  it("no exclusions -> no note", () => {
    expect(build({ partners: "ref-a" }, { selected: [selected[0]!], windows: [A] }).coverage.exclusionNote).toBeNull();
  });
  it("a truncated window is disclosed (and only then)", () => {
    const truncated = build({ partners: "ref-a" }, { selected: [selected[0]!], windows: [win(A.content, A.channel, true)] });
    expect(truncated.coverage.truncatedNote).toBe(TRUNCATION_DISCLOSURE);
    expect(build({ partners: "ref-a" }, { selected: [selected[0]!], windows: [A] }).coverage.truncatedNote).toBeNull();
  });
});

describe("actor-safety of the analysis DTO: no raw refs, uids or URLs beyond opaque hrefs; no scoring, follower total or unsupported metric", () => {
  const dto = build({ partners: "ref-a,ref-b,ref-c", month: "2019-08" }, { selected, windows: [A, B, C] });
  // The selector contract is the ONE place canonical refs appear (as `ref`); everything else is checked here.
  const { selector: _selector, ...analysis } = dto;
  void _selector;

  it("carries no raw source ref / uid / url / caption / username", () => {
    const json = JSON.stringify(analysis).replace(/"[a-zA-Z]*[hH]ref":"[^"]*"/g, '"href":""');
    for (const secret of ["uid-secret", "SRC-SECRET", "CHAN-SECRET", "batch-secret", "partner-secret", "RAW CAPTION", "RAW-URL", "raw_user_secret", "raw_channel_secret", "https://", "ref-a", "ref-b", "ref-c"]) expect(json, secret).not.toContain(secret);
  });
  it("partner refs occur ONLY inside *Href strings (and the selector contract)", () => {
    const strings: { key: string; value: string }[] = [];
    (function walk(value: unknown, key = "") {
      if (typeof value === "string") strings.push({ key, value });
      else if (Array.isArray(value)) value.forEach((item) => walk(item, key));
      else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
    })(analysis);
    for (const { key, value } of strings) if (/ref-[abc]/.test(value)) expect(key, `${key}=${value}`).toMatch(/[hH]ref$/);
  });
  it("has no score / rating / blended / weighted / composite / follower-total / Reach / Watch Time / Impressions / Shares / Saves key anywhere", () => {
    const keys: string[] = [];
    (function walk(value: unknown) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object")
        for (const [k, v] of Object.entries(value)) {
          keys.push(k);
          walk(v);
        }
    })(analysis);
    for (const key of keys) expect(key, key).not.toMatch(/score|rating|rank|weight|composite|blend|overall|reach|impression|watch|shares?$|saves?$|followerTotal|totalFollowers|growth|tier/i);
  });
});

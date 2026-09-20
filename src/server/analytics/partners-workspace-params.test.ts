import { describe, expect, it } from "vitest";

import {
  DEFAULT_TREND_METRIC,
  MAX_PARTNER_REF_LENGTH,
  MAX_REGION_FILTERS,
  PARTNER_SEARCH_DEFAULT_LIMIT,
  PARTNER_SEARCH_MAX_LIMIT,
  PARTNER_SELECTION_LIMIT,
  parsePartnerRefs,
  parsePartnerSearchInput,
  parseRegionValues,
  parseTargetAudienceValues,
  parseTrendMetric,
  parseWorkspaceParams,
  partnersWorkspacePath,
} from "./partners-workspace-params";

describe("selection cap and dedupe (?partners=)", () => {
  it("splits comma lists and repeated params, dedupes (first wins, caller's order), drops blanks", () => {
    expect(parsePartnerRefs("a,b,,c ,b")).toEqual({ refs: ["a", "b", "c"], ignoredOverLimit: 0, malformed: 0 });
    expect(parsePartnerRefs(["a,b", "c", "a"])).toEqual({ refs: ["a", "b", "c"], ignoredOverLimit: 0, malformed: 0 });
    expect(parsePartnerRefs(undefined)).toEqual({ refs: [], ignoredOverLimit: 0, malformed: 0 });
    expect(parsePartnerRefs("")).toEqual({ refs: [], ignoredOverLimit: 0, malformed: 0 });
    expect(parsePartnerRefs(" , ,")).toEqual({ refs: [], ignoredOverLimit: 0, malformed: 0 });
  });
  it("enforces the selection limit server-side and counts the ignored extras", () => {
    expect(PARTNER_SELECTION_LIMIT).toBe(10);
    const refs = Array.from({ length: 14 }, (_, i) => `p${i}`);
    const parsed = parsePartnerRefs(refs.join(","));
    expect(parsed.refs).toEqual(refs.slice(0, 10));
    expect(parsed.ignoredOverLimit).toBe(4);
  });
  it("duplicates do not count towards the cap", () => {
    const parsed = parsePartnerRefs(`${Array.from({ length: 10 }, (_, i) => `p${i}`).join(",")},p0,p1`);
    expect(parsed).toEqual({ refs: Array.from({ length: 10 }, (_, i) => `p${i}`), ignoredOverLimit: 0, malformed: 0 });
  });
  it("over-long tokens can never be a real ref: counted as malformed, never passed on", () => {
    const parsed = parsePartnerRefs(`ok,${"x".repeat(MAX_PARTNER_REF_LENGTH + 1)}`);
    expect(parsed).toEqual({ refs: ["ok"], ignoredOverLimit: 0, malformed: 1 });
  });
  it("ignores non-string garbage and never throws on a hostile token count", () => {
    expect(parsePartnerRefs([1, null, { a: 1 }, "z"] as unknown)).toEqual({ refs: ["z"], ignoredOverLimit: 0, malformed: 0 });
    expect(parsePartnerRefs(42)).toEqual({ refs: [], ignoredOverLimit: 0, malformed: 0 });
    const huge = Array.from({ length: 5000 }, (_, i) => `t${i}`).join(",");
    expect(parsePartnerRefs(huge).refs).toHaveLength(10);
  });
});

describe("Target Audience - canonical values only", () => {
  it("accepts exactly the five canonical values, in canonical order, deduped", () => {
    expect(parseTargetAudienceValues(["India 3", "India Alpha", "India 3"])).toEqual(["India Alpha", "India 3"]);
    expect(parseTargetAudienceValues("India 1")).toEqual(["India 1"]);
    expect(parseTargetAudienceValues(" India 2 ")).toEqual(["India 2"]);
  });
  it("ignores unknown / near-miss / free-text values (never trusted)", () => {
    expect(parseTargetAudienceValues(["india 1", "India 5", "Tier 1", "Pan India", "Regional", "", "India  1", "INDIA ALPHA"])).toEqual([]);
    expect(parseTargetAudienceValues(undefined)).toEqual([]);
    expect(parseTargetAudienceValues(7)).toEqual([]);
    expect(parseTargetAudienceValues(["India 1", "bogus"])).toEqual(["India 1"]);
  });
});

describe("region filter", () => {
  it("trims, drops blanks / over-long values, dedupes case-insensitively and bounds the count", () => {
    expect(parseRegionValues(["Kerala", " kerala ", "", "  ", "Tamil Nadu"])).toEqual(["Kerala", "Tamil Nadu"]);
    expect(parseRegionValues("x".repeat(61))).toEqual([]);
    expect(parseRegionValues(Array.from({ length: 20 }, (_, i) => `R${i}`))).toHaveLength(MAX_REGION_FILTERS);
    expect(parseRegionValues(undefined)).toEqual([]);
  });
});

describe("trend metric", () => {
  it("defaults to the labelled default (engagement) and accepts only the four metrics", () => {
    expect(DEFAULT_TREND_METRIC).toBe("engagement");
    expect(parseTrendMetric(undefined)).toBe("engagement");
    expect(parseTrendMetric("garbage")).toBe("engagement");
    expect(parseTrendMetric(["views"])).toBe("engagement");
    for (const metric of ["views", "engagement", "likes", "comments"]) expect(parseTrendMetric(metric)).toBe(metric);
    expect(parseTrendMetric(" likes ")).toBe("likes");
    expect(parseTrendMetric("reach")).toBe("engagement");
    expect(parseTrendMetric("impressions")).toBe("engagement");
  });
});

describe("parseWorkspaceParams - the whole URL state", () => {
  it("parses a full, valid state", () => {
    const state = parseWorkspaceParams({ partners: "a,b", month: "2026-08", platform: "YouTube", targetAudience: ["India 1", "India 2"], region: "Kerala", metric: "views" });
    expect(state).toEqual({
      partnerRefs: ["a", "b"],
      ignoredOverLimit: 0,
      malformedPartnerTokens: 0,
      month: "2026-08",
      monthInvalid: false,
      platform: "youtube",
      targetAudience: ["India 1", "India 2"],
      regions: ["Kerala"],
      metric: "views",
    });
  });
  it("platform is normalized with the shared normalizer; anything else (or repeated) is All", () => {
    expect(parseWorkspaceParams({ platform: " Instagram " }).platform).toBe("instagram");
    for (const bad of ["tiktok", "insta", "", "all", ["instagram", "youtube"], undefined, 7]) expect(parseWorkspaceParams({ platform: bad }).platform).toBe("all");
  });
  it("garbage everywhere degrades to the empty default state without throwing", () => {
    const state = parseWorkspaceParams({ partners: { x: 1 }, month: "nope", platform: null, targetAudience: 5, region: [{}], metric: [] });
    expect(state).toMatchObject({ partnerRefs: [], month: null, monthInvalid: true, platform: "all", targetAudience: [], regions: [], metric: "engagement" });
  });
  it("an invalid month is flagged, never interpreted", () => {
    expect(parseWorkspaceParams({ month: "2026-13" })).toMatchObject({ month: null, monthInvalid: true });
    expect(parseWorkspaceParams({ month: ["2026-08", "2026-09"] })).toMatchObject({ month: null, monthInvalid: true });
    expect(parseWorkspaceParams({ month: "" })).toMatchObject({ month: null, monthInvalid: false });
  });
});

describe("partnersWorkspacePath - the ONE URL writer", () => {
  const base = { partnerRefs: [] as string[], month: null, platform: "all" as const, targetAudience: [] as never[], regions: [] as string[], metric: "engagement" as const };
  it("the bare state is the bare path", () => {
    expect(partnersWorkspacePath(base)).toBe("/analytics/partners");
  });
  it("carries only non-default values; month only when explicit", () => {
    expect(partnersWorkspacePath({ ...base, partnerRefs: ["a", "b"], month: "2026-08", platform: "youtube", targetAudience: ["India 1", "India 2"], regions: ["Kerala"], metric: "views" })).toBe(
      "/analytics/partners?partners=a%2Cb&month=2026-08&platform=youtube&targetAudience=India+1&targetAudience=India+2&region=Kerala&metric=views",
    );
    expect(partnersWorkspacePath({ ...base, partnerRefs: ["a"] })).toBe("/analytics/partners?partners=a");
  });
  it("round-trips through the parser", () => {
    const written = partnersWorkspacePath({ ...base, partnerRefs: ["p 1", "p&2"], month: "2026-02", platform: "instagram", targetAudience: ["India Alpha"], regions: ["Tamil Nadu"], metric: "comments" });
    const url = new URL(written, "http://x");
    const parsed = parseWorkspaceParams({ partners: url.searchParams.get("partners"), month: url.searchParams.get("month"), platform: url.searchParams.get("platform"), targetAudience: url.searchParams.getAll("targetAudience"), region: url.searchParams.getAll("region"), metric: url.searchParams.get("metric") });
    expect(parsed).toMatchObject({ partnerRefs: ["p 1", "p&2"], month: "2026-02", platform: "instagram", targetAudience: ["India Alpha"], regions: ["Tamil Nadu"], metric: "comments" });
  });
});

describe("parsePartnerSearchInput - bounded search input", () => {
  it("defaults, lower-cases the prefix and clamps the limit to the bound", () => {
    expect(PARTNER_SEARCH_DEFAULT_LIMIT).toBe(10);
    expect(PARTNER_SEARCH_MAX_LIMIT).toBe(20);
    expect(parsePartnerSearchInput({})).toEqual({ ok: true, input: { prefix: "", targetAudience: [], regions: [], limit: 10 } });
    expect(parsePartnerSearchInput({ q: "  AuRoRa ", limit: "500" })).toEqual({ ok: true, input: { prefix: "aurora", targetAudience: [], regions: [], limit: 20 } });
    expect(parsePartnerSearchInput({ limit: 5 })).toMatchObject({ ok: true, input: { limit: 5 } });
  });
  it("rejects an over-long query and a bad limit", () => {
    expect(parsePartnerSearchInput({ q: "x".repeat(101) })).toEqual({ ok: false, message: "Search text is too long." });
    for (const limit of ["abc", 0, -3, 2.5, "1.5", {}]) expect(parsePartnerSearchInput({ limit }), String(limit)).toEqual({ ok: false, message: "Invalid limit." });
  });
  it("Target Audience is canonical-only and region is bounded", () => {
    expect(parsePartnerSearchInput({ targetAudience: ["India 1", "Tier 1", "junk"], region: ["Kerala", ""] })).toEqual({ ok: true, input: { prefix: "", targetAudience: ["India 1"], regions: ["Kerala"], limit: 10 } });
  });
});

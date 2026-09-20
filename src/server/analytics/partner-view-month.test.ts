import { describe, expect, it } from "vitest";

import { buildPartnerAnalyticsView, buildPartnerPlatformSwitch, selectPartnerViewRecords } from "./partner-view-dto";
import { partnerAnalyticsPath } from "./partner-view-links";
import type { PlatformViewLabelInputs } from "./platform-view-dto";
import { buildMonthlyPartnerPlatformCards, sliceWindowToMonth } from "./partners-workspace-metrics";
import { channelRecord, contentRecord, month } from "./partners-workspace-fixtures";
import { countExclusions, monthLabel } from "./reporting-month";

// Step 12F regression + additive-month tests for the 12E Partner Analytics DTO. The
// 12E behavior (no `month`) must be byte-identical; a `month` restricts every
// section to that reporting month and only ever ADDS optional fields.
const inputs: PlatformViewLabelInputs = { actorUid: "a", grants: [], partners: new Map(), partnerAccounts: new Map(), campaigns: new Map(), batchFilenames: new Map() };
const coverage = { contentTruncated: false, channelTruncated: false };

const content = [
  contentRecord({ platform: "instagram", views: 100, reportingPeriod: month("2026-07") }),
  contentRecord({ platform: "instagram", views: 200, reportingPeriod: month("2026-08") }),
  contentRecord({ platform: "youtube", views: 300, reportingPeriod: month("2026-08") }),
  contentRecord({ platform: "instagram", views: 9999, reportingPeriod: null }),
  contentRecord({ platform: "instagram", views: 8888, reportingPeriod: { start: "2026-07-20", end: "2026-08-10" } }),
];
const channel = [channelRecord({ reportingPeriod: month("2026-08"), profileFollowers: 4242 }), channelRecord({ reportingPeriod: month("2026-07"), profileFollowers: 3131 })];

describe("partnerAnalyticsPath month parameter", () => {
  it("is byte-identical to 12E when no month is passed", () => {
    expect(partnerAnalyticsPath("p1")).toBe("/analytics/partner/p1");
    expect(partnerAnalyticsPath("p1", "all")).toBe("/analytics/partner/p1");
    expect(partnerAnalyticsPath("p1", "instagram")).toBe("/analytics/partner/p1?platform=instagram");
    expect(partnerAnalyticsPath("p 1", "youtube", null)).toBe("/analytics/partner/p%201?platform=youtube");
  });
  it("appends a validated month after the platform", () => {
    expect(partnerAnalyticsPath("p1", "all", "2026-08")).toBe("/analytics/partner/p1?month=2026-08");
    expect(partnerAnalyticsPath("p1", "youtube", "2026-08")).toBe("/analytics/partner/p1?platform=youtube&month=2026-08");
  });
  it("the platform switch carries the month only when given", () => {
    expect(buildPartnerPlatformSwitch("p1", "all").map((i) => i.href)).toEqual(["/analytics/partner/p1", "/analytics/partner/p1?platform=instagram", "/analytics/partner/p1?platform=youtube"]);
    expect(buildPartnerPlatformSwitch("p1", "all", "2026-08").map((i) => i.href)).toEqual(["/analytics/partner/p1?month=2026-08", "/analytics/partner/p1?platform=instagram&month=2026-08", "/analytics/partner/p1?platform=youtube&month=2026-08"]);
  });
});

describe("buildPartnerAnalyticsView - no month is byte-identical to 12E; a month only adds optional fields", () => {
  const selected = selectPartnerViewRecords(content, channel, "all");
  const base = buildPartnerAnalyticsView({ partnerRef: "p1", partnerDisplayName: "Alpha", selected, coverage, inputs });

  it("without a month there is no month / monthNotice / allPeriodsHref key and the period is 'All available imported periods'", () => {
    expect(Object.keys(base)).toEqual(["partner", "selection", "links", "coverage", "period", "kpis", "platformPerformance", "partnerAccounts", "publishedContent", "topContent", "sourceQuality"]);
    expect(Object.keys(base.links)).toEqual(["profileHref", "platformSwitch", "explorerContentHref", "explorerChannelHref"]);
    expect(base.period.label).toMatch(/^All available imported periods/);
    expect(base.platformPerformance.every((card) => card.trendBasis === undefined)).toBe(true);
  });

  const restricted = { content, channel, truncated: false };
  const inMonth = sliceWindowToMonth(restricted, "2026-08");
  const monthSelected = selectPartnerViewRecords(inMonth.content, inMonth.channel, "all");
  const monthDto = buildPartnerAnalyticsView({
    partnerRef: "p1",
    partnerDisplayName: "Alpha",
    selected: monthSelected,
    coverage,
    inputs,
    month: { month: "2026-08", label: monthLabel("2026-08"), excluded: countExclusions([...content, ...channel]), windowRecords: content.length + channel.length },
    platformPerformance: buildMonthlyPartnerPlatformCards(content, "all"),
  });

  it("a month view restricts every section to that month and never forces unplaceable records into it", () => {
    expect(monthDto.kpis.publishedContent.total).toBe(2);
    expect(monthDto.kpis.views.byPlatform).toEqual([
      { platform: "instagram", total: 200, recordsWithValue: 1, recordsTotal: 1 },
      { platform: "youtube", total: 300, recordsWithValue: 1, recordsTotal: 1 },
    ]);
    const json = JSON.stringify(monthDto);
    // Unplaceable records (no period 9999 / spanning 8888) and the other month's snapshot (3131) never appear.
    // (July's 100 legitimately appears in the monthly TREND card only - the trend is not month-filtered.)
    for (const excluded of [9999, 8888, 3131]) expect(json).not.toMatch(new RegExp(`[:,\\[]${excluded}[,}\\]]`));
    expect(JSON.stringify(monthDto.kpis) + JSON.stringify(monthDto.publishedContent) + JSON.stringify(monthDto.topContent)).not.toMatch(/[:,\[]100[,}\]]/);
    expect(monthDto.partnerAccounts.totalAccounts).toBe(0); // fixtures carry no account refs
    expect(monthDto.month).toEqual({ month: "2026-08", label: "August 2026", excluded: { noPeriod: 1, unparseable: 0, spans: 1 }, windowRecords: 7 });
  });
  it("labels the period as the month, marks the trend cards monthly and offers the 'all periods' link; hrefs keep the month", () => {
    expect(monthDto.period.label).toBe("August 2026");
    expect(monthDto.platformPerformance.every((card) => card.trendBasis === "month")).toBe(true);
    expect(monthDto.links.allPeriodsHref).toBe("/analytics/partner/p1");
    expect(monthDto.links.platformSwitch.map((i) => i.href)).toEqual(["/analytics/partner/p1?month=2026-08", "/analytics/partner/p1?platform=instagram&month=2026-08", "/analytics/partner/p1?platform=youtube&month=2026-08"]);
  });
  it("is otherwise the same DTO shape (every 12E key present)", () => {
    for (const key of Object.keys(base)) expect(monthDto, key).toHaveProperty(key);
    expect(Object.keys(monthDto).filter((key) => !(key in base))).toEqual(["month"]);
  });
  it("the month trend cards read ALL months (the trend is not month-filtered) while the KPIs are", () => {
    const igCard = monthDto.platformPerformance.find((card) => card.platform === "instagram")!;
    expect(igCard.recordCount).toBe(4);
    expect(igCard.trend.periods.map((p) => p.label)).toEqual(["Jul 2026", "Aug 2026"]);
    expect(igCard.trend.series.find((s) => s.metric === "views")!.values).toEqual([100, 200]);
  });
});

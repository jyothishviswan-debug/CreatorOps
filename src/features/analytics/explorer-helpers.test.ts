import { describe, expect, it } from "vitest";

import { channelRecordLabel, channelScopeLabel, collectChannelLabelRefs, collectContentLabelRefs, contentRecordLabel, contentScopeLabel, EXPLORER_PLATFORM_OPTIONS, parseExplorerPlatformParam, sourceLabel } from "./explorer-helpers";
import type { AnalyticsLabelMaps } from "@/server/analytics/label-resolution";

const labels: AnalyticsLabelMaps = {
  content: { "content-1": "Instagram content · rev 2" },
  campaigns: { "campaign-1": "Monsoon Launch" },
  partners: { "partner-1": "Nila Talks" },
  partnerAccounts: { "account-1": "@nilatalks" },
  batches: { "batch-1": "instagram-export.xlsx" },
};

describe("contentRecordLabel", () => {
  it("uses the resolved content label when matched", () => {
    expect(contentRecordLabel({ platform: "instagram", matchState: "MATCHED", reportingPeriod: null, matchedContentRef: "content-1", matchedCampaignRef: null, batchRef: "b", sheetName: "s", sourceRowNumber: 1 }, labels)).toBe(
      "Instagram content · rev 2",
    );
  });
  it("falls back to platform + reporting period, never a raw ref, when unmatched", () => {
    expect(
      contentRecordLabel({ platform: "youtube", matchState: "UNMATCHED", reportingPeriod: { start: "2026-07-01", end: "2026-07-31" }, matchedContentRef: null, matchedCampaignRef: null, batchRef: "b", sheetName: "s", sourceRowNumber: 1 }, labels),
    ).toBe("Youtube · 2026-07-01 – 2026-07-31");
  });
});

describe("channelRecordLabel", () => {
  it("uses the resolved partner account label when matched", () => {
    expect(
      channelRecordLabel({ platform: "youtube", matchState: "MATCHED", reportingPeriod: null, matchedPartnerRef: "partner-1", matchedPartnerAccountRef: "account-1", rawUsername: null, batchRef: "b", sheetName: "s", sourceRowNumber: 1 }, labels),
    ).toBe("@nilatalks");
  });
  it("falls back to platform + raw handle, never a raw ref, when unmatched", () => {
    expect(
      channelRecordLabel(
        { platform: "tiktok", matchState: "UNMATCHED", reportingPeriod: null, matchedPartnerRef: null, matchedPartnerAccountRef: null, rawUsername: "totally-unknown-handle", batchRef: "b", sheetName: "s", sourceRowNumber: 1 },
        labels,
      ),
    ).toBe("Tiktok · @totally-unknown-handle");
  });
});

describe("scope labels", () => {
  it("resolve content's matched campaign", () => {
    expect(contentScopeLabel({ platform: "instagram", matchState: "MATCHED", reportingPeriod: null, matchedContentRef: null, matchedCampaignRef: "campaign-1", batchRef: "b", sheetName: "s", sourceRowNumber: 1 }, labels)).toBe("Monsoon Launch");
  });
  it("resolve channel's matched partner", () => {
    expect(
      channelScopeLabel({ platform: "youtube", matchState: "MATCHED", reportingPeriod: null, matchedPartnerRef: "partner-1", matchedPartnerAccountRef: null, rawUsername: null, batchRef: "b", sheetName: "s", sourceRowNumber: 1 }, labels),
    ).toBe("Nila Talks");
  });
  it("is an em dash when nothing is matched", () => {
    expect(contentScopeLabel({ platform: "instagram", matchState: "UNMATCHED", reportingPeriod: null, matchedContentRef: null, matchedCampaignRef: null, batchRef: "b", sheetName: "s", sourceRowNumber: 1 }, labels)).toBe("—");
  });
});

describe("sourceLabel", () => {
  it("builds a safe filename · sheet · row label, never a raw batchRef", () => {
    expect(sourceLabel({ batchRef: "batch-1", sheetName: "Content Export", sourceRowNumber: 4 }, labels)).toBe("instagram-export.xlsx · sheet Content Export · row 4");
  });
  it("falls back honestly when the batch label hasn't resolved yet", () => {
    expect(sourceLabel({ batchRef: "unknown-batch", sheetName: "Content Export", sourceRowNumber: 4 }, labels)).toBe("Import batch · sheet Content Export · row 4");
  });
});

describe("collectContentLabelRefs / collectChannelLabelRefs", () => {
  it("dedupes and drops nulls", () => {
    const records = [
      { platform: "instagram", matchState: "MATCHED" as const, reportingPeriod: null, matchedContentRef: "c1", matchedCampaignRef: "camp1", batchRef: "b1", sheetName: "s", sourceRowNumber: 1 },
      { platform: "instagram", matchState: "MATCHED" as const, reportingPeriod: null, matchedContentRef: "c1", matchedCampaignRef: "camp1", batchRef: "b1", sheetName: "s", sourceRowNumber: 2 },
      { platform: "youtube", matchState: "UNMATCHED" as const, reportingPeriod: null, matchedContentRef: null, matchedCampaignRef: null, batchRef: "b2", sheetName: "s", sourceRowNumber: 3 },
    ];
    expect(collectContentLabelRefs(records)).toEqual({ contentRefs: ["c1"], campaignRefs: ["camp1"], batchRefs: ["b1", "b2"] });
  });

  it("does the same for channel refs", () => {
    const records = [{ platform: "youtube", matchState: "MATCHED" as const, reportingPeriod: null, matchedPartnerRef: "p1", matchedPartnerAccountRef: "a1", rawUsername: null, batchRef: "b1", sheetName: "s", sourceRowNumber: 1 }];
    expect(collectChannelLabelRefs(records)).toEqual({ partnerRefs: ["p1"], partnerAccountRefs: ["a1"], batchRefs: ["b1"] });
  });
});

describe("parseExplorerPlatformParam - the ?platform= deep link is safely parsed and normalized", () => {
  it("normalizes case and whitespace to the stored platform id", () => {
    expect(parseExplorerPlatformParam("instagram")).toBe("instagram");
    expect(parseExplorerPlatformParam("Instagram")).toBe("instagram");
    expect(parseExplorerPlatformParam(" YOUTUBE ")).toBe("youtube");
    expect(parseExplorerPlatformParam("TikTok")).toBe("tiktok");
  });
  it("neutralizes garbage, unknown platforms, empty and repeated params to no filter", () => {
    expect(parseExplorerPlatformParam("insta")).toBeUndefined();
    expect(parseExplorerPlatformParam("facebook")).toBeUndefined();
    expect(parseExplorerPlatformParam("")).toBeUndefined();
    expect(parseExplorerPlatformParam("   ")).toBeUndefined();
    expect(parseExplorerPlatformParam("instagram; DROP")).toBeUndefined();
    expect(parseExplorerPlatformParam(["instagram", "youtube"])).toBeUndefined();
    expect(parseExplorerPlatformParam(undefined)).toBeUndefined();
  });
  it("can only ever select a platform the Explorer's select actually offers", () => {
    for (const raw of ["instagram", "YOUTUBE", " tiktok"]) expect(EXPLORER_PLATFORM_OPTIONS as readonly string[]).toContain(parseExplorerPlatformParam(raw));
  });
});

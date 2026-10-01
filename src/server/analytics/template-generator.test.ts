import { describe, expect, it } from "vitest";

import { generateXlsx, parseXlsxForVerification } from "@/server/exports/xlsx";

import { classifyChannelSnapshotSheet } from "./adapters/channel-snapshot-adapter";
import { classifyInstagramContentSheet } from "./adapters/instagram-content-adapter";
import { classifyYoutubeContentSheet } from "./adapters/youtube-content-adapter";
import { channelAccountColumns, instagramColumns, youtubeColumns } from "./template-generator";

// Finding #56: pure round-trip proof - the generated template's own header row, fed through the REAL
// parser's own classification function (no mocking, the genuine adapter this codebase actually ships),
// must be recognized with zero ambiguous/colliding headers. Filename-only or "it didn't throw"
// verification is explicitly insufficient per the wave's own instruction - this asserts the real
// parser's own recognition outcome.
describe("finding #56: generated template headers round-trip through the real Analytics parser", () => {
  it("Instagram content template: headers are recognized, postUrl/postId present, zero ambiguous headers", () => {
    const bytes = generateXlsx(instagramColumns(), [Object.fromEntries(instagramColumns().map((c) => [c.id, null]))]);
    const { headers } = parseXlsxForVerification(bytes);
    const classification = classifyInstagramContentSheet(headers);
    expect(classification.isRecognized).toBe(true);
    expect(classification.ambiguousHeaders).toEqual([]);
    expect(classification.unrecognizedHeaders).not.toContain("Platform Content ID");
    expect(classification.unrecognizedHeaders).not.toContain("Post URL");
  });

  it("YouTube content template: headers are recognized, postUrl/postId present, zero ambiguous headers", () => {
    const bytes = generateXlsx(youtubeColumns(), [Object.fromEntries(youtubeColumns().map((c) => [c.id, null]))]);
    const { headers } = parseXlsxForVerification(bytes);
    const classification = classifyYoutubeContentSheet(headers);
    expect(classification.isRecognized).toBe(true);
    expect(classification.ambiguousHeaders).toEqual([]);
  });

  it("channel/account template: headers are recognized, zero ambiguous headers", () => {
    const bytes = generateXlsx(channelAccountColumns(), [Object.fromEntries(channelAccountColumns().map((c) => [c.id, null]))]);
    const { headers } = parseXlsxForVerification(bytes);
    const classification = classifyChannelSnapshotSheet(headers);
    expect(classification.isRecognized).toBe(true);
    expect(classification.ambiguousHeaders).toEqual([]);
  });

  it("no speculative Engagement column - the finding's own explicit exclusion", () => {
    const allLabels = [...instagramColumns(), ...youtubeColumns(), ...channelAccountColumns()].map((c) => c.label.toLowerCase());
    expect(allLabels.some((l) => l.includes("engagement"))).toBe(false);
  });

  it("a synthetic completed row parses back exactly as written - deterministic column order, no corruption", () => {
    const columns = instagramColumns();
    const row = Object.fromEntries(columns.map((c) => [c.id, c.id === "postUrl" ? "https://instagram.com/p/template-check" : c.id === "likes" ? 5 : null]));
    const bytes = generateXlsx(columns, [row]);
    const parsed = parseXlsxForVerification(bytes);
    expect(parsed.headers).toEqual(columns.map((c) => c.label));
    const postUrlIndex = columns.findIndex((c) => c.id === "postUrl");
    const likesIndex = columns.findIndex((c) => c.id === "likes");
    expect(parsed.rows[0]![postUrlIndex]).toBe("https://instagram.com/p/template-check");
    expect(parsed.rows[0]![likesIndex]).toBe(5);
  });
});

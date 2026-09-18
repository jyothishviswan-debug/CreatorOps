import { describe, expect, it } from "vitest";

import { classifyInstagramContentSheet, mapInstagramContentRows } from "./instagram-content-adapter";

describe("Instagram content adapter", () => {
  it("recognizes a sheet by its own header aliases regardless of exact sheet name", () => {
    const headers = ["Post ID", "Post URL", "Comments", "Likes"];
    const result = classifyInstagramContentSheet(headers);
    expect(result.isRecognized).toBe(true);
    expect(result.recognizedHeaderCount).toBe(4);
  });

  it("does not recognize a sheet with no identity header (no postId, no postUrl)", () => {
    const result = classifyInstagramContentSheet(["Comments", "Likes"]);
    expect(result.isRecognized).toBe(false);
  });

  it("flags an unsupported metric header as ignored, never merged into a supported field", () => {
    const result = classifyInstagramContentSheet(["Post URL", "Reach", "Shares"]);
    expect(result.isRecognized).toBe(true);
    expect(result.unsupportedHeaders.sort()).toEqual(["Reach", "Shares"].sort());
  });

  it("maps recognized rows into normalized candidates, missing metrics stay null (never 0)", () => {
    const headers = ["Post ID", "Post URL", "Comments", "Likes", "Views"];
    const rows = [{ "Post ID": "abc123", "Post URL": "https://instagram.com/p/abc123", Comments: "10", Likes: "200", Views: null }];
    const [candidate] = mapInstagramContentRows("Sheet1", rows, headers);
    expect(candidate.platform).toBe("instagram");
    expect(candidate.rawPostId).toBe("abc123");
    expect(candidate.comments).toBe(10);
    expect(candidate.likes).toBe(200);
    expect(candidate.views).toBeNull();
    expect(candidate.sourceRowNumber).toBe(2);
  });

  it("leaves an unrecognized header's data alone (never coerced) and reports it as ignored only when unsupported", () => {
    const headers = ["Post URL", "Some Custom Column"];
    const rows = [{ "Post URL": "https://instagram.com/p/xyz", "Some Custom Column": "whatever" }];
    const [candidate] = mapInstagramContentRows("Sheet1", rows, headers);
    expect(candidate.ignoredColumns).toEqual([]); // "Some Custom Column" is unrecognized, not unsupported - never listed as ignored
  });
});

import { describe, expect, it } from "vitest";

import { classifyYoutubeContentSheet, mapYoutubeContentRows } from "./youtube-content-adapter";

describe("YouTube content adapter", () => {
  it("recognizes YouTube-flavored headers distinct from Instagram's own wording", () => {
    const result = classifyYoutubeContentSheet(["Video ID", "Video URL", "Views", "Subscribers"]);
    expect(result.isRecognized).toBe(true);
  });

  it("does not recognize a sheet lacking any identity header", () => {
    const result = classifyYoutubeContentSheet(["Views", "Subscribers"]);
    expect(result.isRecognized).toBe(false);
  });

  it("maps a recognized row to a normalized candidate tagged platform=youtube", () => {
    const headers = ["Video ID", "Video URL", "Views", "Likes"];
    const rows = [{ "Video ID": "vid1", "Video URL": "https://youtube.com/watch?v=vid1", Views: "5000", Likes: "300" }];
    const [candidate] = mapYoutubeContentRows("Sheet1", rows, headers);
    expect(candidate.platform).toBe("youtube");
    expect(candidate.views).toBe(5000);
    expect(candidate.likes).toBe(300);
    expect(candidate.comments).toBeNull();
  });

  it("ignores an unsupported metric header without blocking the row", () => {
    const headers = ["Video URL", "Watch Time Minutes"];
    const rows = [{ "Video URL": "https://youtube.com/watch?v=x", "Watch Time Minutes": "120" }];
    const [candidate] = mapYoutubeContentRows("Sheet1", rows, headers);
    expect(candidate.ignoredColumns).toEqual(["Watch Time Minutes"]);
    expect(candidate.rawPostUrl).toBe("https://youtube.com/watch?v=x");
  });
});

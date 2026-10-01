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

  // Remediation-plan Wave B / finding #65 re-audit: no existing test exercised postDateTime alias
  // matching at all before this.
  it.each(["Post Date", "Publish Date", "Upload Date", "Published Date", "Published At", "Published", "published_at", "published-at"])(
    "recognizes %s as postDateTime and parses a real ISO date value from it",
    (header) => {
      const headers = ["Video URL", header];
      const rows = [{ "Video URL": "https://youtube.com/watch?v=abc", [header]: "2026-09-23T18:57:26+05:30" }];
      const [candidate] = mapYoutubeContentRows("Sheet1", rows, headers);
      expect(candidate.rawPostDateTime).toBe("2026-09-23T18:57:26+05:30");
      expect(candidate.postDateTimeIso).toBe(new Date("2026-09-23T18:57:26+05:30").toISOString());
    },
  );

  it("an invalid postDateTime value stays null, with the raw value still preserved (never dropped without a trace)", () => {
    const headers = ["Video URL", "Post Date"];
    const rows = [{ "Video URL": "https://youtube.com/watch?v=abc", "Post Date": "not a real date" }];
    const [candidate] = mapYoutubeContentRows("Sheet1", rows, headers);
    expect(candidate.postDateTimeIso).toBeNull();
    expect(candidate.rawPostDateTime).toBe("not a real date");
  });
});

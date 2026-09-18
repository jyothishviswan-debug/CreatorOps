import { describe, expect, it } from "vitest";

import { CONTENT_STATUSES } from "@/server/content/types";
import { contentDisplayTitle, contentTypeLabel, platformLabel, STATUS_LABELS, statusTone } from "./format";

describe("STATUS_LABELS", () => {
  it("has a label for every real ContentStatus, no extras, no gaps", () => {
    for (const status of CONTENT_STATUSES) {
      expect(STATUS_LABELS[status]).toBeTruthy();
    }
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...CONTENT_STATUSES].sort());
  });
});

describe("statusTone", () => {
  it("gives every status a tone, distinguishing terminal/branch states", () => {
    for (const status of CONTENT_STATUSES) {
      expect(statusTone(status)).toBeTruthy();
    }
    expect(statusTone("COMPLETED")).toBe("purple");
    expect(statusTone("CANCELLED")).toBe("red");
    expect(statusTone("REJECTED")).toBe("red");
    expect(statusTone("CHANGES_REQUIRED")).toBe("orange");
  });
});

describe("platformLabel / contentTypeLabel", () => {
  it("title-cases the first letter only, without altering the stored value elsewhere", () => {
    expect(platformLabel("instagram")).toBe("Instagram");
    expect(contentTypeLabel("reel")).toBe("Reel");
    expect(platformLabel("")).toBe("");
  });
});

describe("contentDisplayTitle", () => {
  it("prefers the real title when present", () => {
    expect(contentDisplayTitle({ title: "Community story reel", contentType: "reel", platform: "instagram" })).toBe("Community story reel");
  });

  it("falls back to a safe, derived label - never a raw ref - when there is no title", () => {
    expect(contentDisplayTitle({ title: null, contentType: "reel", platform: "instagram" })).toBe("Reel · Instagram");
  });
});

import { describe, expect, it } from "vitest";

import { CONTENT_STATUSES } from "@/server/content/types";
import { contentDisplayTitle, platformLabel, STATUS_LABELS, statusTone } from "./format";

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
    expect(statusTone("APPROVED")).toBe("purple");
    expect(statusTone("CANCELLED")).toBe("red");
    expect(statusTone("REVISION_REQUESTED")).toBe("orange");
    expect(statusTone("UNDER_REVIEW")).toBe("blue");
    expect(statusTone("OPEN")).toBe("gray");
  });
});

describe("platformLabel", () => {
  it("title-cases the first letter only, without altering the stored value elsewhere", () => {
    expect(platformLabel("instagram")).toBe("Instagram");
    expect(platformLabel("")).toBe("");
  });
});

describe("contentDisplayTitle", () => {
  it("derives a truthful label from the current links - never a raw ref", () => {
    expect(contentDisplayTitle({ currentLinks: [{ platform: "instagram" }], currentRevisionNumber: 1 })).toBe("Instagram · 1 link (rev 1)");
    expect(contentDisplayTitle({ currentLinks: [{ platform: "instagram" }, { platform: "youtube" }], currentRevisionNumber: 2 })).toBe("Instagram, Youtube · 2 links (rev 2)");
  });

  it("falls back to a safe label when there are no links yet", () => {
    expect(contentDisplayTitle({ currentLinks: [], currentRevisionNumber: 0 })).toBe("Submission thread (no links yet)");
  });
});

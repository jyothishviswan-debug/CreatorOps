import { describe, expect, it } from "vitest";

import { claimIdFor, computeNormalizedIdentity } from "./identity";

describe("computeNormalizedIdentity", () => {
  it("prefers the stable platform account id over profileUrl and handle", () => {
    const identity = computeNormalizedIdentity({ platform: "YouTube", platformAccountId: "UC12345", profileUrl: "https://youtube.com/@somehandle", handle: "somehandle" });
    expect(identity).toBe("youtube:id:uc12345");
  });

  it("falls back to profileUrl when no platform account id is given", () => {
    const identity = computeNormalizedIdentity({ platform: "Instagram", profileUrl: "https://instagram.com/creatorhouse", handle: "creatorhouse" });
    expect(identity).toBe("instagram:url:https://instagram.com/creatorhouse");
  });

  it("falls back to handle when neither a platform account id nor profileUrl is given", () => {
    const identity = computeNormalizedIdentity({ platform: "Instagram", handle: "@CreatorHouse" });
    expect(identity).toBe("instagram:handle:creatorhouse");
  });

  it("normalizes platform, id, url, and handle casing/whitespace/leading @ consistently", () => {
    const a = computeNormalizedIdentity({ platform: "  Instagram ", handle: " @CreatorHouse " });
    const b = computeNormalizedIdentity({ platform: "instagram", handle: "creatorhouse" });
    expect(a).toBe(b);
  });

  it("strips a trailing slash from profileUrl", () => {
    const a = computeNormalizedIdentity({ platform: "Instagram", profileUrl: "https://instagram.com/creatorhouse/" });
    const b = computeNormalizedIdentity({ platform: "Instagram", profileUrl: "https://instagram.com/creatorhouse" });
    expect(a).toBe(b);
  });

  it("folds platform into the key so the same raw id/handle on two platforms never collides", () => {
    const instagram = computeNormalizedIdentity({ platform: "Instagram", handle: "same" });
    const youtube = computeNormalizedIdentity({ platform: "YouTube", handle: "same" });
    expect(instagram).not.toBe(youtube);
  });

  it("returns null when no identity evidence is supplied at all", () => {
    expect(computeNormalizedIdentity({ platform: "Instagram" })).toBeNull();
  });

  it("returns null when platform itself is blank", () => {
    expect(computeNormalizedIdentity({ platform: "  ", handle: "creatorhouse" })).toBeNull();
  });
});

describe("claimIdFor", () => {
  it("is deterministic for the same normalized identity", () => {
    expect(claimIdFor("instagram:handle:creatorhouse")).toBe(claimIdFor("instagram:handle:creatorhouse"));
  });

  it("differs for different normalized identities", () => {
    expect(claimIdFor("instagram:handle:creatorhouse")).not.toBe(claimIdFor("instagram:handle:someoneelse"));
  });

  it("produces a Firestore-safe id (no slashes, bounded length)", () => {
    const id = claimIdFor("instagram:url:https://instagram.com/some/very/long/path/that/would/not/be/a/safe/doc/id");
    expect(id).not.toContain("/");
    expect(id.length).toBeLessThan(100);
  });
});

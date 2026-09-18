import { describe, expect, it } from "vitest";

import { classifyChannelSnapshotSheet, mapChannelSnapshotRows } from "./channel-snapshot-adapter";

describe("Channel snapshot adapter", () => {
  it("recognizes a sheet carrying at least one identity dimension", () => {
    expect(classifyChannelSnapshotSheet(["Platform Account ID", "Followers"]).isRecognized).toBe(true);
    expect(classifyChannelSnapshotSheet(["Profile URL"]).isRecognized).toBe(true);
    expect(classifyChannelSnapshotSheet(["Handle"]).isRecognized).toBe(true);
  });

  it("does not recognize a sheet with only a follower count and no identity dimension", () => {
    expect(classifyChannelSnapshotSheet(["Followers"]).isRecognized).toBe(false);
  });

  it("uses a per-row Platform column when present, never guessed from other content", () => {
    const headers = ["Platform", "Handle", "Followers"];
    const rows = [{ Platform: "YouTube", Handle: "creatorhouse", Followers: "1000" }];
    const [candidate] = mapChannelSnapshotRows("Sheet1", "instagram", rows, headers);
    expect(candidate.platform).toBe("YouTube");
  });

  it("falls back to the actor's own explicit platform selection when no per-row Platform column exists", () => {
    const headers = ["Handle", "Followers"];
    const rows = [{ Handle: "creatorhouse", Followers: "1000" }];
    const [candidate] = mapChannelSnapshotRows("Sheet1", "instagram", rows, headers);
    expect(candidate.platform).toBe("instagram");
  });

  it("normalizes a supplied profile URL for storage, and leaves it null when absent", () => {
    const headers = ["Profile URL"];
    const withUrl = mapChannelSnapshotRows("Sheet1", "instagram", [{ "Profile URL": "HTTPS://Instagram.com/CreatorHouse/" }], headers);
    expect(withUrl[0]!.normalizedProfileUrl).toBe("https://instagram.com/CreatorHouse");

    const withoutUrl = mapChannelSnapshotRows("Sheet1", "instagram", [{ "Profile URL": null }], headers);
    expect(withoutUrl[0]!.normalizedProfileUrl).toBeNull();
  });

  it("missing follower count stays null, never coerced to 0", () => {
    const headers = ["Handle", "Followers"];
    const rows = [{ Handle: "x", Followers: null }];
    const [candidate] = mapChannelSnapshotRows("Sheet1", "instagram", rows, headers);
    expect(candidate.profileFollowers).toBeNull();
  });
});

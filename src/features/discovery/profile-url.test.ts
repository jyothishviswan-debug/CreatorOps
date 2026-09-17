import { describe, expect, it } from "vitest";

import { deriveFromProfileUrl } from "./profile-url";

describe("deriveFromProfileUrl", () => {
  it("derives platform and handle from a plain Instagram profile URL", () => {
    expect(deriveFromProfileUrl("https://instagram.com/mrinaljha")).toEqual({ platform: "Instagram", handle: "mrinaljha" });
  });

  it("strips a leading @ from the handle", () => {
    expect(deriveFromProfileUrl("https://tiktok.com/@mrinaljha")).toEqual({ platform: "TikTok", handle: "mrinaljha" });
  });

  it("skips the /stories/ keyword for an Instagram story URL, capturing the username that follows it", () => {
    expect(deriveFromProfileUrl("https://www.instagram.com/stories/nct_aravind/")).toEqual({ platform: "Instagram", handle: "nct_aravind" });
  });

  it("captures no handle at all for an Instagram post/reel permalink - the segment after is a post id, not a username", () => {
    expect(deriveFromProfileUrl("https://www.instagram.com/reel/C1a2B3c4D5e/")).toEqual({ platform: "Instagram" });
    expect(deriveFromProfileUrl("https://instagram.com/p/C1a2B3c4D5e/")).toEqual({ platform: "Instagram" });
  });

  it("skips the /channel/ keyword for a YouTube channel-id URL, never capturing the keyword itself", () => {
    expect(deriveFromProfileUrl("https://www.youtube.com/channel/UCxyz123ABC")).toEqual({ platform: "YouTube", handle: "UCxyz123ABC" });
  });

  it("skips the /c/ keyword for a YouTube custom-name URL", () => {
    expect(deriveFromProfileUrl("https://youtube.com/c/MrinalJha")).toEqual({ platform: "YouTube", handle: "MrinalJha" });
  });

  it("handles a YouTube @handle URL directly, with no keyword to skip", () => {
    expect(deriveFromProfileUrl("https://youtube.com/@mrinaljha")).toEqual({ platform: "YouTube", handle: "mrinaljha" });
  });

  it("skips the /in/ keyword for a LinkedIn profile URL", () => {
    expect(deriveFromProfileUrl("https://www.linkedin.com/in/mrinal-jha")).toEqual({ platform: "LinkedIn", handle: "mrinal-jha" });
  });

  it("skips the /company/ keyword for a LinkedIn company URL", () => {
    expect(deriveFromProfileUrl("https://linkedin.com/company/acme")).toEqual({ platform: "LinkedIn", handle: "acme" });
  });

  it("returns {} for a malformed URL rather than throwing", () => {
    expect(deriveFromProfileUrl("not a url")).toEqual({});
  });

  it("returns no platform/handle for an unrecognized host", () => {
    expect(deriveFromProfileUrl("https://example.com/someone")).toEqual({ handle: "someone" });
  });
});

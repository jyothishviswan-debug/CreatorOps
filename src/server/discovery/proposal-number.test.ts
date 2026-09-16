import { describe, expect, it } from "vitest";

import { platformCodeFor } from "./proposal-number";

describe("platformCodeFor", () => {
  it("maps known platform labels to their compact code", () => {
    expect(platformCodeFor("Instagram")).toBe("IG");
    expect(platformCodeFor("YouTube")).toBe("YT");
    expect(platformCodeFor("TikTok")).toBe("TT");
    expect(platformCodeFor("Facebook")).toBe("FB");
    expect(platformCodeFor("LinkedIn")).toBe("LI");
    expect(platformCodeFor("Snapchat")).toBe("SC");
    expect(platformCodeFor("Pinterest")).toBe("PN");
  });

  it("maps the picker's \"X (Twitter)\" label to X, not a mangled abbreviation of the whole label", () => {
    expect(platformCodeFor("X (Twitter)")).toBe("X");
  });

  it("falls back to a short abbreviation for an unrecognized platform", () => {
    expect(platformCodeFor("Threads")).toBe("THR");
  });

  it("returns GEN for no platform on file", () => {
    expect(platformCodeFor(null)).toBe("GEN");
    expect(platformCodeFor("")).toBe("GEN");
  });
});

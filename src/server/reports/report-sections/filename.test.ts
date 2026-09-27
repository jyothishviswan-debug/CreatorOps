import { describe, expect, it } from "vitest";

import { buildSafeArtifactFilename, isSafeArtifactFilename } from "./filename";

describe("artifact filename safety", () => {
  it("builds a safe, lowercase, extension-correct filename", () => {
    const name = buildSafeArtifactFilename({ templateTitle: "Monthly Partner Performance", version: 3, format: "pdf" });
    expect(name).toBe("monthly-partner-performance-v3.pdf");
    expect(isSafeArtifactFilename(name)).toBe(true);
  });

  it("strips anything that is not a-z0-9- from the title", () => {
    const name = buildSafeArtifactFilename({ templateTitle: "Campaign / Event <script> Report", version: 1, format: "xlsx" });
    expect(name).not.toMatch(/[<>/]/);
    expect(isSafeArtifactFilename(name)).toBe(true);
  });

  it("never produces a path separator or traversal sequence, even from a hostile title", () => {
    const name = buildSafeArtifactFilename({ templateTitle: "../../etc/passwd", version: 1, format: "csv" });
    expect(name).not.toContain("..");
    expect(name).not.toContain("/");
    expect(isSafeArtifactFilename(name)).toBe(true);
  });

  it("falls back to a safe default if the title slugifies to nothing", () => {
    const name = buildSafeArtifactFilename({ templateTitle: "!!!???", version: 2, format: "pdf" });
    expect(isSafeArtifactFilename(name)).toBe(true);
  });
});

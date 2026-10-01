import { describe, expect, it } from "vitest";

import { classifyHeaders, fieldValueGetter, normalizeHeaderKey, type RawSheetRow } from "./shared";

type Field = "postId" | "postUrl";
const ALIASES: Record<Field, string[]> = { postId: ["Post ID", "Platform Content ID"], postUrl: ["Post URL", "Link to Post"] };

describe("normalizeHeaderKey", () => {
  it("is case-insensitive and whitespace-tolerant", () => {
    expect(normalizeHeaderKey("  Post   ID ")).toBe("post id");
    expect(normalizeHeaderKey("POST ID")).toBe(normalizeHeaderKey("post id"));
  });
});

describe("classifyHeaders", () => {
  it("maps recognized headers to canonical field ids, case/whitespace-insensitively", () => {
    const result = classifyHeaders(["post id", "  Link to Post  ", "Some Random Column"], ALIASES);
    expect(result.recognized.get("post id")).toBe("postId");
    expect(result.recognized.get("  Link to Post  ")).toBe("postUrl");
    expect(result.unrecognized).toEqual(["Some Random Column"]);
  });

  it("classifies a shared-unsupported-metric header as unsupported, never as recognized or unrecognized", () => {
    const result = classifyHeaders(["Post ID", "Reach", "Impressions"], ALIASES);
    expect(result.recognized.size).toBe(1);
    expect(result.unsupported.get("Reach")).toBe("reach");
    expect(result.unsupported.get("Impressions")).toBe("impressions");
    expect(result.unrecognized).toEqual([]);
  });

  it("leaves a genuinely unrecognized header completely alone", () => {
    const result = classifyHeaders(["Totally Unknown Header"], ALIASES);
    expect(result.recognized.size).toBe(0);
    expect(result.unsupported.size).toBe(0);
    expect(result.unrecognized).toEqual(["Totally Unknown Header"]);
  });

  // Remediation-plan Wave B / finding #55 re-audit: collision safety. Before this fix, two
  // differently-spelled headers normalizing to the same field silently let whichever came LAST in
  // column order win - the earlier column's entire data was dropped with zero indication anywhere.
  describe("collision safety", () => {
    it("two DIFFERENT raw headers normalizing to the SAME field are NEVER silently resolved to one - both are reported as ambiguous, neither stays in recognized", () => {
      const result = classifyHeaders(["Post_ID", "Post-ID"], ALIASES);
      expect(result.recognized.size).toBe(0);
      expect(result.ambiguous.get("postId")?.sort()).toEqual(["Post-ID", "Post_ID"].sort());
      // deterministic regardless of column order
      const reversed = classifyHeaders(["Post-ID", "Post_ID"], ALIASES);
      expect(reversed.recognized.size).toBe(0);
      expect(reversed.ambiguous.get("postId")?.sort()).toEqual(["Post-ID", "Post_ID"].sort());
    });

    it("a collision on ONE field never affects a different, unambiguous field in the same sheet", () => {
      const result = classifyHeaders(["Post_ID", "Post-ID", "Post URL"], ALIASES);
      expect(result.ambiguous.has("postId")).toBe(true);
      expect(result.recognized.get("Post URL")).toBe("postUrl");
    });

    it("three or more colliding headers are ALL reported, not just the first two", () => {
      const result = classifyHeaders(["Post ID", "Post_ID", "Post-ID"], ALIASES);
      expect(result.ambiguous.get("postId")?.sort()).toEqual(["Post ID", "Post-ID", "Post_ID"].sort());
    });

    it("fieldValueGetter never reads ANY of the colliding columns' data once a field is ambiguous", () => {
      const classification = classifyHeaders(["Post_ID", "Post-ID"], ALIASES);
      const row: RawSheetRow = { Post_ID: "wrong-one", "Post-ID": "also-wrong" };
      const get = fieldValueGetter(classification.recognized, row);
      expect(get("postId")).toBeUndefined();
    });

    it("a literal duplicate header string (identical text twice) is ALSO treated as ambiguous, never assumed to be the same column - classifyHeaders can't safely tell two same-named columns apart from one column listed twice, so it never guesses either way. Real-world duplicate headers are additionally rejected earlier, structurally, by xlsx-parser - see xlsx-parser.test.ts", () => {
      const result = classifyHeaders(["Post ID", "Post ID"], ALIASES);
      expect(result.recognized.size).toBe(0);
      expect(result.ambiguous.get("postId")).toEqual(["Post ID", "Post ID"]);
    });
  });
});

describe("fieldValueGetter", () => {
  it("reads a recognized field's raw value off a header-keyed row", () => {
    const classification = classifyHeaders(["Post ID", "Post URL"], ALIASES);
    const row: RawSheetRow = { "Post ID": "123", "Post URL": "https://example.com/p/123" };
    const get = fieldValueGetter(classification.recognized, row);
    expect(get("postId")).toBe("123");
    expect(get("postUrl")).toBe("https://example.com/p/123");
  });

  it("returns undefined for a field never recognized in this row's headers", () => {
    const classification = classifyHeaders(["Post ID"], ALIASES);
    const get = fieldValueGetter(classification.recognized, { "Post ID": "123" });
    expect(get("postUrl")).toBeUndefined();
  });
});

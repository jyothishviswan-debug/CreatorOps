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

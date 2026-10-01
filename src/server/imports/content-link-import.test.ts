import { describe, expect, it } from "vitest";

import type { ParsedSheet } from "@/server/analytics/xlsx-parser";

import { enumerateRows, groupClaimId, groupRows, malformedRowResult, normalizeHeader, resolveRow } from "./content-link-import";

// Finding #44 (user-decided): the content-link bulk import adapter's own pure functions - row parsing,
// header aliasing, grouping-by-Assignment (never per-row single-link calls, since
// recordContentLinksOnBehalf's own contract is one revision per call), malformed-row reporting, and
// claim-id determinism (the row-level idempotency mechanism, mirroring Analytics' own
// computeRowIdentityKey and contract-bundle's own rowClientRequestId).

describe("normalizeHeader / resolveRow", () => {
  it("normalizes case/whitespace and resolves every accepted alias", () => {
    expect(normalizeHeader("  Assignment   Ref ")).toBe("assignment ref");
    expect(resolveRow({ "Assignment Ref": " as-1 ", Platform: "Instagram", URL: "https://instagram.com/p/x" })).toEqual({
      assignmentRef: "as-1",
      platform: "Instagram",
      url: "https://instagram.com/p/x",
    });
    expect(resolveRow({ assignmentref: "as-2", platform: "youtube", link: "https://youtube.com/watch?v=1" })).toEqual({
      assignmentRef: "as-2",
      platform: "youtube",
      url: "https://youtube.com/watch?v=1",
    });
  });

  it("leaves a field unresolved (undefined) when no alias matches or the value is blank", () => {
    expect(resolveRow({ "Not A Real Header": "x" })).toEqual({});
    expect(resolveRow({ "Assignment Ref": "   " })).toEqual({});
  });
});

describe("enumerateRows", () => {
  const sheets: ParsedSheet[] = [
    {
      sheetName: "Sheet1",
      headers: ["Assignment Ref", "Platform", "URL"],
      rows: [
        { "Assignment Ref": "as-1", Platform: "instagram", URL: "https://instagram.com/p/a" },
        { "Assignment Ref": "as-1", Platform: "instagram", URL: "https://instagram.com/p/b" },
        { "Assignment Ref": "as-2", Platform: "youtube", URL: "https://youtube.com/watch?v=c" },
        { "Assignment Ref": "", Platform: "", URL: "" }, // wholly blank - silently skipped
        { "Assignment Ref": "as-3", Platform: "", URL: "https://instagram.com/p/d" }, // malformed - missing Platform
      ],
    },
  ];

  it("numbers rows starting at 2 (header is row 1), skips wholly-blank rows, and marks malformed rows incomplete", () => {
    const rows = enumerateRows(sheets);
    expect(rows).toHaveLength(4); // 4 blank row skipped
    expect(rows.map((r) => r.rowNumber)).toEqual([2, 3, 4, 6]);
    expect(rows[0]).toMatchObject({ assignmentRef: "as-1", platform: "instagram", url: "https://instagram.com/p/a", rawComplete: true });
    expect(rows[3]).toMatchObject({ assignmentRef: "as-3", platform: null, url: "https://instagram.com/p/d", rawComplete: false });
  });
});

describe("groupRows", () => {
  it("groups complete rows by assignmentRef (preserving each row), and separates malformed rows out", () => {
    const rows = enumerateRows([
      {
        sheetName: "S",
        headers: [],
        rows: [
          { "Assignment Ref": "as-1", Platform: "instagram", URL: "https://instagram.com/p/a" },
          { "Assignment Ref": "as-2", Platform: "youtube", URL: "https://youtube.com/watch?v=b" },
          { "Assignment Ref": "as-1", Platform: "instagram", URL: "https://instagram.com/p/c" },
          { "Assignment Ref": "as-4", Platform: "instagram" }, // missing URL - malformed
        ],
      },
    ]);
    const { groups, malformed } = groupRows(rows);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]!.assignmentRef).toBe("as-4");

    expect(groups).toHaveLength(2);
    const as1 = groups.find((g) => g.assignmentRef === "as-1")!;
    expect(as1.rows).toHaveLength(2);
    expect(as1.rows.map((r) => r.url)).toEqual(["https://instagram.com/p/a", "https://instagram.com/p/c"]);
    const as2 = groups.find((g) => g.assignmentRef === "as-2")!;
    expect(as2.rows).toHaveLength(1);
  });
});

describe("malformedRowResult", () => {
  it("names exactly the missing column(s), never a generic message", () => {
    const missingAll = malformedRowResult({ sheetName: "S", rowNumber: 5, assignmentRef: null, platform: null, url: null, rawComplete: false });
    expect(missingAll.outcome).toBe("ERROR");
    expect(missingAll.message).toBe("Missing required column(s): Assignment Ref, Platform, URL.");

    const missingOne = malformedRowResult({ sheetName: "S", rowNumber: 6, assignmentRef: "as-1", platform: "instagram", url: null, rawComplete: false });
    expect(missingOne.message).toBe("Missing required column(s): URL.");
  });
});

describe("groupClaimId - the row-level idempotency mechanism", () => {
  it("is deterministic and unique per (sourceHash, assignmentRef)", () => {
    const a = groupClaimId("hash1", "as-1");
    const b = groupClaimId("hash1", "as-1");
    expect(a).toBe(b);
    expect(groupClaimId("hash1", "as-2")).not.toBe(a);
    expect(groupClaimId("hash2", "as-1")).not.toBe(a);
  });
});

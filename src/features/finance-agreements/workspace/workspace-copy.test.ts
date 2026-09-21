import { describe, expect, it } from "vitest";

import { incompleteListSentence, pageStatusCopy, workspaceCountCopy, workspaceEmptyCopy } from "./workspace-copy";

describe("workspaceCountCopy", () => {
  it("is silent when nothing is truncated and there are no rows", () => {
    expect(workspaceCountCopy({ total: 0, headsRead: 3, headsTruncated: false })).toBeNull();
  });

  it("states the exact count when the read is complete", () => {
    expect(workspaceCountCopy({ total: 1, headsRead: 1, headsTruncated: false })).toBe("1 Agreement in this view.");
    expect(workspaceCountCopy({ total: 7, headsRead: 9, headsTruncated: false })).toBe("7 Agreements in this view.");
  });

  it("never presents an exact-looking total when the read was truncated", () => {
    const copy = workspaceCountCopy({ total: 42, headsRead: 500, headsTruncated: true })!;
    expect(copy).toContain("42 found among the 500 most recently updated Agreements read");
    expect(copy).toContain("may be incomplete");
    expect(copy).not.toMatch(/in this view/);
  });

  it("says none were FOUND (not none exist) when truncated and empty", () => {
    const copy = workspaceCountCopy({ total: 0, headsRead: 500, headsTruncated: true })!;
    expect(copy).toBe("None found among the 500 most recently updated Agreements read.");
  });
});

describe("workspaceEmptyCopy", () => {
  const base = { headsRead: 12, headsTruncated: false };

  it("no Agreements yet: invites creation only when the actor can manage", () => {
    expect(workspaceEmptyCopy({ ...base, anyFilterActive: false, canManage: true })).toEqual({ title: "No Agreements yet", description: "Create the first Agreement for a Partner or Vendor to see it here." });
    expect(workspaceEmptyCopy({ ...base, anyFilterActive: false, canManage: false }).description).toBe("Agreements you are authorized to see will appear here.");
  });

  it("no results with filters points at clearing them", () => {
    expect(workspaceEmptyCopy({ ...base, anyFilterActive: true, canManage: true })).toEqual({ title: "No matching Agreements", description: "Try a different search or filter, or clear the filters." });
  });

  it("truncated: never a flat 'none'", () => {
    const copy = workspaceEmptyCopy({ headsRead: 500, headsTruncated: true, anyFilterActive: true, canManage: true });
    expect(copy.title).toBe("None found in the Agreements read");
    expect(copy.description).toContain(incompleteListSentence(500));
    expect(copy.description).toContain("clear the filters");
    const noFilters = workspaceEmptyCopy({ headsRead: 500, headsTruncated: true, anyFilterActive: false, canManage: true });
    expect(noFilters.description).toBe(incompleteListSentence(500));
  });
});

describe("pageStatusCopy", () => {
  it("names the page and the rows on it", () => {
    expect(pageStatusCopy(2, 10)).toBe("Page 2 · 10 shown");
  });
});

import { describe, expect, it } from "vitest";

import { incompleteListSentence, workspaceCountCopy, workspaceEmptyCopy } from "./workspace-copy";

// Step 13C: the Workspace never presents a truncated (bounded, first-N) read as the complete month.

describe("workspaceCountCopy", () => {
  it("an untruncated read keeps the exact count and says nothing when empty", () => {
    expect(workspaceCountCopy({ total: 7, headsRead: 7, headsTruncated: false })).toBe("7 in this view.");
    expect(workspaceCountCopy({ total: 0, headsRead: 0, headsTruncated: false })).toBeNull();
  });

  it("a truncated read says the list is incomplete and never reads like an exact total", () => {
    const copy = workspaceCountCopy({ total: 120, headsRead: 500, headsTruncated: true })!;
    expect(copy).toBe("120 in this view, from the first 500 reviews read. The month has more reviews than the 500 read, so this list is incomplete - narrow by Partner to see the rest.");
    expect(copy).not.toBe("120 in this view.");
    expect(copy).toContain("incomplete");
  });

  it("a truncated read with no rows is 'none found in the reviews read' - never a certain zero", () => {
    const copy = workspaceCountCopy({ total: 0, headsRead: 500, headsTruncated: true })!;
    expect(copy).toContain("None found in the first 500 reviews read.");
    expect(copy).toContain("incomplete");
  });

  it("quotes the number of reviews actually read (an injected ceiling is quoted, not a hard-coded 500)", () => {
    expect(workspaceCountCopy({ total: 2, headsRead: 3, headsTruncated: true })).toContain("first 3 reviews read");
    expect(incompleteListSentence(3)).toContain("than the 3 read");
  });

  it("does not suggest Region as a way past the bound (Region narrows the reviews already read)", () => {
    expect(incompleteListSentence(500)).not.toMatch(/region/i);
  });
});

describe("workspaceEmptyCopy", () => {
  const base = { headsRead: 12, headsTruncated: false, anyFilterActive: false, monthLabel: "March 2019" };

  it("untruncated: the existing per-mode empty states are unchanged", () => {
    expect(workspaceEmptyCopy({ ...base, mode: "needs-review" })).toEqual({ title: "Nothing needs review", description: "Nothing to show for March 2019 in your authorized scope." });
    expect(workspaceEmptyCopy({ ...base, mode: "drafts" }).title).toBe("No drafts or reviews in progress");
    expect(workspaceEmptyCopy({ ...base, mode: "finalized" }).title).toBe("No finalized reviews");
    expect(workspaceEmptyCopy({ ...base, mode: "finalized", anyFilterActive: true })).toEqual({ title: "No matching reviews", description: "Try another Partner, region or month, or clear the filters." });
  });

  it("truncated: never claims there are none - it says none were found in the reviews read and that the list is incomplete", () => {
    for (const mode of ["needs-review", "drafts", "finalized", "signal"] as const) {
      for (const anyFilterActive of [false, true]) {
        const copy = workspaceEmptyCopy({ ...base, headsRead: 500, headsTruncated: true, mode, anyFilterActive });
        expect(copy.title).toBe("None found in the reviews read");
        expect(copy.description).toContain("The month has more reviews than the 500 read, so this list is incomplete");
      }
    }
  });
});

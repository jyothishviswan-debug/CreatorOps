import { describe, expect, it } from "vitest";

import { COMMERCIAL_CONFLICT_HEADER_LABEL, COMMERCIAL_CONFLICT_NOTE, COMMERCIAL_CONFLICT_SECTION_REASON, COMMERCIAL_CONFLICT_TEXT, commercialConflictNotice } from "./commercial-conflict";
import { unavailableReasonLabel } from "./format";

// Step 14C: the overlap-conflict presentation - the exact sentence, exactly one wording, no Agreement named or picked.

describe("commercialConflictNotice", () => {
  it("returns the exact sentence + the neutral note for a conflicted snapshot", () => {
    const notice = commercialConflictNotice({ policyConflict: { reason: "multiple_applicable_agreements", conflictCount: 2 } });
    expect(notice).toEqual({ text: "Multiple applicable Agreements require resolution", note: COMMERCIAL_CONFLICT_NOTE, conflictCount: 2 });
    expect(COMMERCIAL_CONFLICT_TEXT).toBe("Multiple applicable Agreements require resolution");
  });

  it("returns null for a conflict-free snapshot and for an older stored version with no marker (never a false conflict)", () => {
    expect(commercialConflictNotice({})).toBeNull();
    expect(commercialConflictNotice({ policyConflict: undefined })).toBeNull();
  });

  it("returns null for a marker reason it does not know (no invented conflict wording)", () => {
    expect(commercialConflictNotice({ policyConflict: { reason: "something_else", conflictCount: 2 } })).toBeNull();
  });

  it("the note says nothing is picked or merged, names no Agreement ref and no money / Finance vocabulary", () => {
    expect(COMMERCIAL_CONFLICT_NOTE).toMatch(/does not choose between Agreements or merge them/);
    for (const text of [COMMERCIAL_CONFLICT_NOTE, COMMERCIAL_CONFLICT_HEADER_LABEL, COMMERCIAL_CONFLICT_SECTION_REASON]) {
      expect(text).not.toMatch(/finance|payable|invoice|payment|₹|agr_/i);
    }
  });

  it("the exact sentence is used once: the header and the per-section reason use different wording, and the reason code has a label", () => {
    expect(COMMERCIAL_CONFLICT_HEADER_LABEL).not.toContain(COMMERCIAL_CONFLICT_TEXT);
    expect(COMMERCIAL_CONFLICT_SECTION_REASON).not.toContain(COMMERCIAL_CONFLICT_TEXT);
    expect(unavailableReasonLabel("multiple_applicable_agreements")).toBe(COMMERCIAL_CONFLICT_SECTION_REASON);
  });
});

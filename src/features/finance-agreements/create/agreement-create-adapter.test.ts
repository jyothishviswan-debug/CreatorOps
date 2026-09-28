import { describe, expect, it } from "vitest";

import { extractionUiState } from "./agreement-create-adapter";

// Final Whole-Product Certification: a real, reproduced regression in `extractionUiState` (base spec section 31).
// Reproduced live: uploading a scanned/no-text Agreement PDF genuinely ran OCR, got a real 200
// MANUAL_REVIEW_REQUIRED response from POST /api/finance/contracts/extract, and the page stayed stuck on
// "Upload the signed Agreement to see extraction results here." forever - a MANUAL_REVIEW_REQUIRED run can
// have zero fields (`classifyExtraction`'s `few_fields` / PDF-unreadable branches), so `attachable` (and
// therefore `attached`) can never become true for it, and the pre-fix code required `attached` before it would
// ever look at `runStatus` at all. Fixed by checking `runStatus === "MANUAL_REVIEW_REQUIRED"` BEFORE the
// `attached` gate - see agreement-create-adapter.ts for the full reasoning.
describe("extractionUiState", () => {
  const base = { hasArtifact: true, phase: "idle" as const, errored: false };

  it("shows manual_review immediately even when nothing was extracted to attach (the reproduced bug)", () => {
    expect(extractionUiState({ ...base, attached: false, runStatus: "MANUAL_REVIEW_REQUIRED" })).toBe("manual_review");
  });

  it("still shows manual_review once attached (idempotent, not a one-shot reveal)", () => {
    expect(extractionUiState({ ...base, attached: true, runStatus: "MANUAL_REVIEW_REQUIRED" })).toBe("manual_review");
  });

  it("a real EXTRACTED/PARTIAL run still stays idle in the UI until explicitly attached (unchanged behavior - proposals are not shown as final before a human confirms)", () => {
    expect(extractionUiState({ ...base, attached: false, runStatus: "EXTRACTED" })).toBe("idle");
    expect(extractionUiState({ ...base, attached: false, runStatus: "PARTIAL" })).toBe("idle");
  });

  it("EXTRACTED/PARTIAL surface their real state once attached", () => {
    expect(extractionUiState({ ...base, attached: true, runStatus: "EXTRACTED" })).toBe("complete");
    expect(extractionUiState({ ...base, attached: true, runStatus: "PARTIAL" })).toBe("partial");
  });

  it("no artifact yet, or no run yet, is idle regardless of attach state", () => {
    expect(extractionUiState({ ...base, hasArtifact: false, attached: false, runStatus: null })).toBe("idle");
    expect(extractionUiState({ ...base, hasArtifact: true, attached: false, runStatus: null })).toBe("idle");
  });

  it("an in-flight phase (uploading/extracting) or an error always wins, regardless of runStatus/attached", () => {
    expect(extractionUiState({ ...base, phase: "uploading", attached: false, runStatus: "MANUAL_REVIEW_REQUIRED" })).toBe("uploading");
    expect(extractionUiState({ ...base, phase: "extracting", attached: true, runStatus: "EXTRACTED" })).toBe("extracting");
    expect(extractionUiState({ ...base, errored: true, attached: true, runStatus: "EXTRACTED" })).toBe("error");
  });
});

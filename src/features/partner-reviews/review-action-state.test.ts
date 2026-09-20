import { describe, expect, it } from "vitest";

import type { ReviewActionPermissions } from "@/server/partner-reviews/ui-dto";

import { classifyActionFailure, computeReviewActionState } from "./review-action-state";

// Explicit grants only - the same shapes the seeded roles hold (no role names anywhere).
const NONE: ReviewActionPermissions = { canGenerate: false, canRefresh: false, canSubmit: false, canFinalize: false, canCreateRevision: false };
const MANAGER: ReviewActionPermissions = { canGenerate: true, canRefresh: true, canSubmit: true, canFinalize: false, canCreateRevision: true };
const HEAD: ReviewActionPermissions = { ...MANAGER, canFinalize: true };

const draft = { permissions: MANAGER, version: { version: 1, status: "DRAFT" as const, docVersion: 1 }, head: { openVersion: 1, currentFinalizedVersion: null, docVersion: 1 }, freshnessState: "current" as const };

describe("lifecycle action matrix (mirrors the server, never replaces it)", () => {
  it("Viewer / Analyst (no grants): no action at all, on any version", () => {
    for (const input of [draft, { ...draft, version: { version: 1, status: "IN_REVIEW" as const, docVersion: 2 } }]) {
      expect(computeReviewActionState({ ...input, permissions: NONE })).toMatchObject({ canRefresh: false, canSubmit: false, canFinalize: false, canCreateRevision: false, any: false });
    }
  });

  it("Manager on a Draft: refresh + submit, NO finalize", () => {
    expect(computeReviewActionState(draft)).toMatchObject({ canRefresh: true, canSubmit: true, canFinalize: false, canCreateRevision: false });
  });

  it("Manager on an In Review version: refresh, no submit, NO finalize", () => {
    expect(computeReviewActionState({ ...draft, version: { version: 1, status: "IN_REVIEW", docVersion: 2 } })).toMatchObject({ canRefresh: true, canSubmit: false, canFinalize: false });
  });

  it("Head on an In Review version: refresh + finalize; on a Draft: no finalize yet (a Draft must be submitted first)", () => {
    expect(computeReviewActionState({ ...draft, permissions: HEAD, version: { version: 1, status: "IN_REVIEW", docVersion: 2 } })).toMatchObject({ canRefresh: true, canFinalize: true, canSubmit: false });
    expect(computeReviewActionState({ ...draft, permissions: HEAD })).toMatchObject({ canFinalize: false, canSubmit: true });
  });

  it("a finalized current version: Create revision ONLY when recorded freshness says revision available and no version is open", () => {
    const finalized = { permissions: MANAGER, version: { version: 1, status: "FINALIZED" as const, docVersion: 3 }, head: { openVersion: null, currentFinalizedVersion: 1, docVersion: 4 } };
    expect(computeReviewActionState({ ...finalized, freshnessState: "revision_available" })).toMatchObject({ canCreateRevision: true, canRefresh: false, canSubmit: false, canFinalize: false });
    expect(computeReviewActionState({ ...finalized, freshnessState: "current" }).canCreateRevision).toBe(false);
    expect(computeReviewActionState({ ...finalized, freshnessState: null }).canCreateRevision).toBe(false);
    expect(computeReviewActionState({ ...finalized, freshnessState: "revision_available", permissions: NONE }).canCreateRevision).toBe(false);
    // An open revision blocks another one.
    expect(computeReviewActionState({ ...finalized, head: { ...finalized.head, openVersion: 2 }, freshnessState: "revision_in_progress" }).canCreateRevision).toBe(false);
  });

  it("a historical (superseded / non-current) version is read only", () => {
    expect(computeReviewActionState({ permissions: HEAD, version: { version: 1, status: "SUPERSEDED", docVersion: 5 }, head: { openVersion: null, currentFinalizedVersion: 2, docVersion: 9 }, freshnessState: "superseded" }).any).toBe(false);
    // The open version's actions never apply to a different version on screen.
    expect(computeReviewActionState({ permissions: HEAD, version: { version: 1, status: "FINALIZED", docVersion: 3 }, head: { openVersion: 2, currentFinalizedVersion: 1, docVersion: 6 }, freshnessState: "revision_in_progress" }).any).toBe(false);
  });
});

describe("failure classification from the accepted HTTP contract", () => {
  it("409 + REFRESH_REQUIRED => 'Refresh required' (never an automatic refresh)", () => {
    expect(classifyActionFailure({ status: 409, code: "not_ready", error: "stale", blockers: [{ code: "REFRESH_REQUIRED" }] }).kind).toBe("refresh_required");
  });
  it("409 + REVISION_NOT_NEEDED => no revision needed", () => {
    expect(classifyActionFailure({ status: 409, code: "not_ready", error: "same", blockers: [{ code: "REVISION_NOT_NEEDED" }] }).kind).toBe("revision_not_needed");
  });
  it("409 without blockers (stale write / conflict) => changed elsewhere; 401/403 => denied; other => error", () => {
    expect(classifyActionFailure({ status: 409, code: "stale_write", error: "changed" }).kind).toBe("changed_elsewhere");
    expect(classifyActionFailure({ status: 403, code: "unauthorized", error: "Forbidden." }).kind).toBe("denied");
    expect(classifyActionFailure({ status: 401, code: "unauthorized", error: "Forbidden." }).kind).toBe("denied");
    expect(classifyActionFailure({ status: 400, code: "invalid_input", error: "bad" })).toEqual({ kind: "error", message: "bad" });
  });
});

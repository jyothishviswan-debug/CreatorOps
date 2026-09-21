import { describe, expect, it } from "vitest";

import { MAX_AGREEMENT_VERSIONS } from "@/server/finance-agreements/types";

import { classifyActionFailure, computeAgreementActionState, isPageLevelFailure, reasonIssue, type ActionHead, type ActionVersion } from "./lifecycle-actions";

const BOTH = { canManage: true, canActivate: true };
const MANAGER = { canManage: true, canActivate: false };
const NONE = { canManage: false, canActivate: false };

const head = (overrides: Partial<ActionHead>): ActionHead => ({ status: "ACTIVE", openVersion: null, activeVersion: 1, lastEndedVersion: null, latestVersion: 1, ...overrides });
const version = (n: number, status: ActionVersion["status"], confirmed: boolean): ActionVersion => ({ version: n, status, confirmed });

const FIRST_DRAFT = { head: head({ status: "DRAFT", openVersion: 1, activeVersion: null }), versions: [version(1, "DRAFT", false)] };
const CONFIRMED_DRAFT = { head: head({ status: "DRAFT", openVersion: 1, activeVersion: null }), versions: [version(1, "DRAFT", true)] };
const ACTIVE = { head: head({}), versions: [version(1, "ACTIVE", true)] };
const SUSPENDED = { head: head({ status: "SUSPENDED" }), versions: [version(1, "SUSPENDED", true)] };
const ENDED = { head: head({ status: "ENDED", activeVersion: null, lastEndedVersion: 1 }), versions: [version(1, "ENDED", true)] };
const ACTIVE_WITH_REVISION = { head: head({ openVersion: 2, latestVersion: 2 }), versions: [version(2, "DRAFT", false), version(1, "ACTIVE", true)] };
const ACTIVE_WITH_CONFIRMED_REVISION = { head: head({ openVersion: 2, latestVersion: 2 }), versions: [version(2, "DRAFT", true), version(1, "ACTIVE", true)] };

const flags = (state: ReturnType<typeof computeAgreementActionState>) =>
  Object.entries(state)
    .filter(([key, value]) => key.startsWith("can") && value === true)
    .map(([key]) => key)
    .sort();

describe("lifecycle action availability", () => {
  it("an unconfirmed first DRAFT offers Continue draft + Confirm only (to a manager; never activate / revise)", () => {
    expect(flags(computeAgreementActionState({ permissions: BOTH, ...FIRST_DRAFT }))).toEqual(["canConfirm", "canContinueDraft"]);
    expect(flags(computeAgreementActionState({ permissions: MANAGER, ...FIRST_DRAFT }))).toEqual(["canConfirm", "canContinueDraft"]);
  });

  it("a confirmed DRAFT offers Activate only, and only with activation permission", () => {
    expect(flags(computeAgreementActionState({ permissions: BOTH, ...CONFIRMED_DRAFT }))).toEqual(["canActivate"]);
    const manager = computeAgreementActionState({ permissions: MANAGER, ...CONFIRMED_DRAFT });
    expect(flags(manager)).toEqual([]);
    expect(manager.note).toMatch(/waiting to be activated/);
  });

  it("an ACTIVE Agreement with no open version offers Create revision, Suspend and End (not Resume)", () => {
    expect(flags(computeAgreementActionState({ permissions: BOTH, ...ACTIVE }))).toEqual(["canCreateRevision", "canEnd", "canSuspend"]);
  });

  it("a SUSPENDED Agreement offers Create revision, Resume and End (not Suspend)", () => {
    expect(flags(computeAgreementActionState({ permissions: BOTH, ...SUSPENDED }))).toEqual(["canCreateRevision", "canEnd", "canResume"]);
  });

  it("an ENDED Agreement with no open draft offers only Create revision", () => {
    expect(flags(computeAgreementActionState({ permissions: BOTH, ...ENDED }))).toEqual(["canCreateRevision"]);
  });

  it("while a revision is open there is no second revision; the governing version can still be suspended / ended", () => {
    const unconfirmed = computeAgreementActionState({ permissions: BOTH, ...ACTIVE_WITH_REVISION });
    expect(flags(unconfirmed)).toEqual(["canConfirm", "canContinueDraft", "canEnd", "canSuspend"]);
    expect(unconfirmed.governingVersion).toBe(1);
    expect(unconfirmed.openVersion).toBe(2);
    const confirmed = computeAgreementActionState({ permissions: BOTH, ...ACTIVE_WITH_CONFIRMED_REVISION });
    expect(flags(confirmed)).toEqual(["canActivate", "canEnd", "canSuspend"]);
    expect(confirmed.openConfirmed).toBe(true);
  });

  it("a manager (no activation permission) never sees activate / revise / suspend / resume / end", () => {
    for (const state of [ACTIVE, SUSPENDED, ENDED, ACTIVE_WITH_CONFIRMED_REVISION]) {
      const result = computeAgreementActionState({ permissions: MANAGER, ...state });
      expect([result.canActivate, result.canCreateRevision, result.canSuspend, result.canResume, result.canEnd]).toEqual([false, false, false, false, false]);
    }
    expect(flags(computeAgreementActionState({ permissions: MANAGER, ...ACTIVE_WITH_REVISION }))).toEqual(["canConfirm", "canContinueDraft"]);
  });

  it("an actor with no permissions gets no action at all, and an explanatory note", () => {
    for (const state of [FIRST_DRAFT, CONFIRMED_DRAFT, ACTIVE, SUSPENDED, ENDED, ACTIVE_WITH_REVISION]) {
      const result = computeAgreementActionState({ permissions: NONE, ...state });
      expect(result.any).toBe(false);
      expect(flags(result)).toEqual([]);
      expect(result.note).toMatch(/you can view this Agreement/i);
    }
  });

  it("stops offering a revision at the version ceiling", () => {
    const capped = computeAgreementActionState({ permissions: BOTH, head: head({ latestVersion: MAX_AGREEMENT_VERSIONS }), versions: [version(MAX_AGREEMENT_VERSIONS, "ACTIVE", true)] });
    expect(capped.canCreateRevision).toBe(false);
  });

  it("there is no delete / remove / discard action in the state shape", () => {
    const keys = Object.keys(computeAgreementActionState({ permissions: BOTH, ...ACTIVE }));
    expect(keys.filter((key) => /delete|remove|discard/i.test(key))).toEqual([]);
  });
});

describe("failure classification", () => {
  const failure = (kind: Parameters<typeof classifyActionFailure>[0]["kind"], message = "msg", blockers?: { code: string; message: string }[]) => classifyActionFailure({ kind, message, ...(blockers ? { blockers } : {}) });

  it("stale -> the reload guidance (never a silent overwrite)", () => {
    const view = failure("stale");
    expect(view.kind).toBe("stale");
    expect(view.message).toMatch(/changed elsewhere/i);
    expect(isPageLevelFailure(view)).toBe(true);
  });

  it("denials and not-found are page level; everything else stays with the action", () => {
    expect(isPageLevelFailure(failure("forbidden"))).toBe(true);
    expect(isPageLevelFailure(failure("unauthorized"))).toBe(true);
    expect(isPageLevelFailure(failure("not_found"))).toBe(true);
    for (const kind of ["conflict", "invalid", "network", "error", "not_ready"] as const) expect(isPageLevelFailure(failure(kind))).toBe(false);
  });

  it("not_ready carries its blockers", () => {
    const view = failure("not_ready", "not ready", [{ code: "field_undecided", message: "x" }]);
    expect(view.kind).toBe("not_ready");
    expect(view.blockers).toEqual([{ code: "field_undecided", message: "x" }]);
    expect(failure("not_ready").blockers).toEqual([]);
  });
});

describe("reasonIssue", () => {
  it("requires 3-1000 characters after trimming", () => {
    expect(reasonIssue("")).toMatch(/at least 3/);
    expect(reasonIssue("  ab  ")).toMatch(/at least 3/);
    expect(reasonIssue("abc")).toBeNull();
    expect(reasonIssue(" abc ")).toBeNull();
    expect(reasonIssue("x".repeat(1000))).toBeNull();
    expect(reasonIssue("x".repeat(1001))).toMatch(/too long/);
  });
});

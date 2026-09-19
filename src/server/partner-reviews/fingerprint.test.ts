import { describe, expect, it } from "vitest";

import { canonicalJson, computeSourceFingerprint, evaluateFreshness } from "./fingerprint";

describe("canonicalJson / computeSourceFingerprint", () => {
  it("is independent of object key order at every depth, and array order is significant", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("drops undefined object values, keeps null, and never emits whitespace", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson({ a: 1 })).not.toMatch(/\s/);
  });

  it("produces a stable 64-hex sha256 that changes when any fact changes", () => {
    const facts = { assignments: [{ ref: "a1", version: 1 }], analytics: [] };
    const h = computeSourceFingerprint(facts);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeSourceFingerprint({ analytics: [], assignments: [{ version: 1, ref: "a1" }] })).toBe(h);
    expect(computeSourceFingerprint({ assignments: [{ ref: "a1", version: 2 }], analytics: [] })).not.toBe(h);
  });
});

describe("evaluateFreshness - closed state matrix", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const none = { openVersionExists: false, incompleteReasons: [] as string[] };

  it("DRAFT / IN_REVIEW: match -> current, mismatch -> refresh_available", () => {
    for (const status of ["DRAFT", "IN_REVIEW"] as const) {
      expect(evaluateFreshness(A, A, status, none).state).toBe("current");
      expect(evaluateFreshness(A, B, status, none).state).toBe("refresh_available");
    }
  });

  it("FINALIZED: match -> current; mismatch with no open version -> revision_available; with an open version -> revision_in_progress", () => {
    expect(evaluateFreshness(A, A, "FINALIZED", none).state).toBe("current");
    expect(evaluateFreshness(A, B, "FINALIZED", none).state).toBe("revision_available");
    expect(evaluateFreshness(A, B, "FINALIZED", { ...none, openVersionExists: true }).state).toBe("revision_in_progress");
  });

  it("a matching-but-incomplete snapshot is evidence_incomplete, and reasons are always reported alongside", () => {
    const result = evaluateFreshness(A, A, "FINALIZED", { openVersionExists: false, incompleteReasons: ["approved_content_without_analytics"] });
    expect(result).toEqual({ state: "evidence_incomplete", incompleteReasons: ["approved_content_without_analytics"] });
  });

  it("staleness is never hidden behind incompleteness", () => {
    const reasons = ["analytics_scan_truncated"];
    expect(evaluateFreshness(A, B, "DRAFT", { openVersionExists: false, incompleteReasons: reasons })).toEqual({ state: "refresh_available", incompleteReasons: reasons });
    expect(evaluateFreshness(A, B, "FINALIZED", { openVersionExists: false, incompleteReasons: reasons })).toEqual({ state: "revision_available", incompleteReasons: reasons });
  });

  it("SUPERSEDED is historical and never compared, whatever the fingerprints", () => {
    expect(evaluateFreshness(A, B, "SUPERSEDED", none).state).toBe("superseded");
    expect(evaluateFreshness(A, A, "SUPERSEDED", none).state).toBe("superseded");
  });

  it("only ever returns a member of the closed documented set", () => {
    const allowed = new Set(["current", "refresh_available", "revision_available", "revision_in_progress", "evidence_incomplete", "superseded"]);
    for (const status of ["DRAFT", "IN_REVIEW", "FINALIZED", "SUPERSEDED"] as const) {
      for (const cur of [A, B]) {
        for (const open of [true, false]) {
          for (const reasons of [[], ["x"]]) expect(allowed.has(evaluateFreshness(A, cur, status, { openVersionExists: open, incompleteReasons: reasons }).state)).toBe(true);
        }
      }
    }
  });
});

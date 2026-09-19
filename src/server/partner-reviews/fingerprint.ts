import { createHash } from "node:crypto";

import type { PartnerReviewFreshness, PartnerReviewStatus } from "./types";

// Step 13A: deterministic source fingerprint + derived freshness. Pure.

// Canonical JSON: object keys sorted lexicographically at every depth,
// arrays kept in their given order (callers sort what should be an
// unordered set BEFORE hashing), `undefined` object values dropped,
// no whitespace. The same facts always serialize to the same string.
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "object": {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
    }
    default:
      return "null";
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// The source fingerprint is the sha256 of the canonical JSON of the
// SOURCE FACTS that feed a snapshot (each source ref plus its
// version/updatedAt/revision marker and the status fields that matter).
// The caller must never put anything time-dependent in `sourceFacts` - no
// "now", no evidence cutoff, no overdue-relative-to-now boolean - so two
// collections over unchanged upstream data always hash identically.
export function computeSourceFingerprint(sourceFacts: unknown): string {
  return sha256Hex(canonicalJson(sourceFacts));
}

export type FreshnessContext = {
  // Whether some OTHER version of the same review is currently open
  // (DRAFT/IN_REVIEW). Only meaningful for a FINALIZED version.
  openVersionExists: boolean;
  incompleteReasons: string[];
};

// Derived freshness - computed on read/inspect, NEVER persisted, and it
// never mutates a finalized version.
//
//   SUPERSEDED                         -> superseded (historical, not compared)
//   fingerprints differ, DRAFT/IN_REVIEW -> refresh_available
//   fingerprints differ, FINALIZED, no open version -> revision_available
//   fingerprints differ, FINALIZED, open version    -> revision_in_progress
//   fingerprints match, incomplete evidence         -> evidence_incomplete
//   fingerprints match, complete evidence           -> current
//
// Staleness always wins over incompleteness (an incomplete snapshot is
// never allowed to hide that upstream has moved on); incompleteReasons
// are reported alongside every state regardless.
export function evaluateFreshness(snapshotFingerprint: string, currentFingerprint: string, status: PartnerReviewStatus, context: FreshnessContext): PartnerReviewFreshness {
  const incompleteReasons = [...context.incompleteReasons];

  if (status === "SUPERSEDED") return { state: "superseded", incompleteReasons };

  if (snapshotFingerprint !== currentFingerprint) {
    if (status === "FINALIZED") return { state: context.openVersionExists ? "revision_in_progress" : "revision_available", incompleteReasons };
    return { state: "refresh_available", incompleteReasons };
  }

  return { state: incompleteReasons.length > 0 ? "evidence_incomplete" : "current", incompleteReasons };
}

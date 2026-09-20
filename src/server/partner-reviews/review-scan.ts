import { FieldPath } from "firebase-admin/firestore";

import { listAssignmentDocs, assignmentsCollection, type AssignmentListCursor } from "@/server/assignments/firestore";
import { assignmentDocSchema, type AssignmentDoc } from "@/server/assignments/types";
import type { ScopeGrant } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { getPartnerDocsByRefs } from "@/server/partners/firestore";
import { isPartnerDocInScope } from "@/server/partners/partners-gate";
import type { PartnerDoc } from "@/server/partners/types";

import { listPartnerReviewHeadDocs, partnerReviewsCollection, getPartnerReviewVersionDoc, type PartnerReviewListCursor } from "./firestore";
import { groupAssignmentsByPartnerMonth, type CandidateGroup } from "./needs-review-candidates";
import { summaryOfVersion } from "./review-list-summary";
import type { HeadDisplay, PartnerReviewHeadDoc } from "./types";

// Step 13B: the bounded, scope-first READS behind the Overview, Workspace and
// Partner-wise pages. Every function here is bounded by an explicit ceiling with
// an explicit truncation flag, reads only heads / a bounded Assignment scan /
// bulk Partners - and NEVER invokes the evidence collector or the freshness
// evaluator (a static test and a runtime spy prove it): a list of N reviews costs
// O(page) head reads, never N freshness recomputations.

export const HEAD_SCAN_PAGE = 100;
// Ceiling on heads read for one Overview aggregate / Needs Review list.
export const HEAD_SCAN_CEILING = 500;
// Ceiling on Assignments read by the Needs Review candidate scan.
export const CANDIDATE_SCAN_CEILING = 500;
// Legacy heads (written before Step 13B: no display block) each cost one bounded
// version read to derive their summary; only this many are resolved per request.
export const LEGACY_FALLBACK_CAP = 40;
// Distinct review months offered in a month selector.
export const MONTH_OPTIONS_LIMIT = 12;

export type ScopeContext = { actorUid: string; grants: ScopeGrant[]; hasGlobal: boolean };

// --- Heads --------------------------------------------------------------------------------
export async function scanHeads(
  scope: ScopeContext,
  options: {
    periodKey?: string;
    periodKeyMax?: string;
    partnerRef?: string;
    partnerAuthorized?: boolean;
    ceiling?: number;
    // Stop after this many DISTINCT periodKeys have been seen (month selectors).
    distinctMonthLimit?: number;
  } = {},
): Promise<{ heads: PartnerReviewHeadDoc[]; truncated: boolean }> {
  const ceiling = options.ceiling ?? HEAD_SCAN_CEILING;
  const heads: PartnerReviewHeadDoc[] = [];
  const months = new Set<string>();
  let cursor: PartnerReviewListCursor | undefined;

  for (;;) {
    const page = await listPartnerReviewHeadDocs({
      limit: HEAD_SCAN_PAGE,
      cursor,
      actorUid: scope.actorUid,
      grants: scope.grants,
      hasGlobal: scope.hasGlobal,
      partnerRef: options.partnerRef,
      partnerAuthorized: options.partnerAuthorized,
      periodKey: options.periodKey,
      periodKeyMax: options.periodKeyMax,
    });
    for (const head of page.heads) {
      if (heads.length >= ceiling) return { heads, truncated: true };
      heads.push(head);
      months.add(head.periodKey);
    }
    if (!page.nextCursor) return { heads, truncated: false };
    if (options.distinctMonthLimit !== undefined && months.size >= options.distinctMonthLimit) return { heads, truncated: true };
    cursor = page.nextCursor;
  }
}

// Bulk existence check by deterministic reviewRef (one `getAll`, never a read per row).
export async function existingReviewRefs(reviewRefs: string[]): Promise<Set<string>> {
  const unique = [...new Set(reviewRefs)];
  const found = new Set<string>();
  const db = getAdminFirestore();
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    if (chunk.length === 0) continue;
    const snaps = await db.getAll(...chunk.map((ref) => partnerReviewsCollection().doc(ref)), { fieldMask: ["reviewRef"] });
    for (const snap of snaps) if (snap.exists) found.add(snap.id);
  }
  return found;
}

// The head list is scoped by the head's own point-in-time scope snapshot; the
// LIVE Partner is the authority. Every head surfaced to the browser is
// re-verified against its live Partner (one bulk read, the actor's grants read
// once) - a head whose Partner is out of scope or missing is dropped.
export async function verifyLiveScope(scope: ScopeContext, partnerRefs: string[]): Promise<Map<string, PartnerDoc>> {
  const partners = await getPartnerDocsByRefs(partnerRefs);
  const allowed = new Map<string, PartnerDoc>();
  for (const [ref, partner] of partners) if (isPartnerDocInScope(scope.grants, scope.actorUid, partner)) allowed.set(ref, partner);
  return allowed;
}

// --- Display projections ------------------------------------------------------------------
export type ResolvedDisplay = { display: HeadDisplay | null; source: "stored" | "derived_from_snapshot" | "unavailable" };

// The head's stored display block; for a legacy head, derived from the stored
// snapshot of its default version (one bounded version read, capped per request).
// Never touches upstream evidence.
export async function resolveDisplays(heads: PartnerReviewHeadDoc[], cap = LEGACY_FALLBACK_CAP): Promise<Map<string, ResolvedDisplay>> {
  const result = new Map<string, ResolvedDisplay>();
  let fallbackReads = 0;
  for (const head of heads) {
    if (head.display) {
      result.set(head.reviewRef, { display: head.display, source: "stored" });
      continue;
    }
    if (fallbackReads >= cap) {
      result.set(head.reviewRef, { display: null, source: "unavailable" });
      continue;
    }
    fallbackReads += 1;
    const versionNumber = head.openVersion ?? head.currentFinalizedVersion ?? head.latestVersion;
    const version = await getPartnerReviewVersionDoc(head.reviewRef, versionNumber);
    if (!version) {
      result.set(head.reviewRef, { display: null, source: "unavailable" });
      continue;
    }
    const finalizedVersion = head.currentFinalizedVersion !== null ? await getFinalizedAt(head) : null;
    result.set(head.reviewRef, {
      display: {
        version: version.version,
        status: version.status,
        summary: summaryOfVersion(version),
        evidenceCutoff: version.evidenceCutoff,
        lastEventKind: "generated",
        lastEventAt: head.updatedAt,
        revisionCount: Math.max(0, head.latestVersion - 1),
        supersededVersion: null,
        finalizedVersion: head.currentFinalizedVersion,
        finalizedAt: finalizedVersion,
      },
      source: "derived_from_snapshot",
    });
  }
  return result;
}

async function getFinalizedAt(head: PartnerReviewHeadDoc): Promise<string | null> {
  if (head.currentFinalizedVersion === null) return null;
  const version = await getPartnerReviewVersionDoc(head.reviewRef, head.currentFinalizedVersion);
  return version?.finalizedAt ?? null;
}

// --- Needs Review candidates ---------------------------------------------------------------
// ONE bounded, scoped scan of Assignments (the accepted listAssignmentDocs scope +
// cursor machinery, newest first), grouped by Partner + month. This finds the
// Partner-months found in the most recent CANDIDATE_SCAN_CEILING Assignments the
// actor's Assignment scope reaches - it is NOT an exhaustive account of every
// possible review month, and the UI says so.
export async function scanScopedAssignmentCandidates(scope: ScopeContext, options: { partnerRef?: string; ceiling?: number } = {}): Promise<{ groups: CandidateGroup[]; scanned: number; truncated: boolean }> {
  const ceiling = options.ceiling ?? CANDIDATE_SCAN_CEILING;
  const assignments: AssignmentDoc[] = [];
  let cursor: AssignmentListCursor | undefined;
  let truncated = false;

  for (;;) {
    const page = await listAssignmentDocs({ limit: 100, cursor, actorUid: scope.actorUid, grants: scope.grants, hasGlobal: scope.hasGlobal, partnerRef: options.partnerRef });
    for (const assignment of page.assignments) {
      if (assignments.length >= ceiling) {
        truncated = true;
        break;
      }
      assignments.push(assignment);
    }
    if (truncated || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { groups: groupAssignmentsByPartnerMonth(assignments), scanned: assignments.length, truncated };
}

// The Partner-wise page's own scan: the Partner was ALREADY authorized (live
// Partner scope), so its Assignments are read by partnerRef equality - the same
// Partner-scope authority the evidence collector uses - bounded by the ceiling.
export async function scanPartnerAssignmentMonths(partnerRef: string, ceiling = CANDIDATE_SCAN_CEILING): Promise<{ groups: CandidateGroup[]; scanned: number; truncated: boolean }> {
  const assignments: AssignmentDoc[] = [];
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let truncated = false;

  for (;;) {
    const remaining = ceiling + 1 - assignments.length;
    if (remaining <= 0) break;
    let query = assignmentsCollection().where("partnerRef", "==", partnerRef).orderBy(FieldPath.documentId()).limit(Math.min(100, remaining));
    if (last) query = query.startAfter(last);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    for (const doc of snapshot.docs) {
      if (assignments.length >= ceiling) {
        truncated = true;
        break;
      }
      const parsed = assignmentDocSchema.safeParse(doc.data());
      if (parsed.success) assignments.push(parsed.data);
    }
    if (truncated) break;
    last = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.docs.length < Math.min(100, remaining)) break;
  }
  return { groups: groupAssignmentsByPartnerMonth(assignments), scanned: assignments.length, truncated };
}

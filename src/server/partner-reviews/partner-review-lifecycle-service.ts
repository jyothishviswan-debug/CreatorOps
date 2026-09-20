import { z } from "zod";

import { PARTNER_REVIEW_LIFECYCLE_TRANSITIONS, canTransitionLifecycle } from "@/server/authz/lifecycle";
import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import type { PartnerReviewDetailDto } from "./client-dto";
import { collectPartnerEvidence } from "./evidence-collector";
import { getPartnerReviewVersionDoc, partnerReviewsCollection, partnerReviewVersionsCollection, versionDocId } from "./firestore";
import { appendPartnerReviewEvent } from "./partner-review-events";
import { buildReviewDetail, loadAuthorizedReview, scopeSnapshotOf } from "./partner-review-service";
import { buildHeadDisplay, carriedFinalized, computeReviewListSummary } from "./review-list-summary";
import {
  MAX_PARTNER_REVIEW_VERSIONS,
  partnerReviewHeadDocSchema,
  partnerReviewsConflictResult,
  partnerReviewsInvalidInputResult,
  partnerReviewsNotFoundResult,
  partnerReviewsNotReadyResult,
  partnerReviewsStaleResult,
  partnerReviewVersionDocSchema,
  type PartnerReviewHeadDoc,
  type PartnerReviewsServiceResult,
  type PartnerReviewVersionDoc,
} from "./types";

// Step 13A: the trusted version-lifecycle transitions - submit, finalize
// and create-revision. Every transition runs inside ONE Firestore
// transaction that reads the head and the version document(s) first and
// writes only afterwards ("all reads before writes"), verifies the
// caller's optimistic expectedDocVersion, and appends its audit event in
// the same transaction. Finalized/superseded versions are never edited:
// the only writes to a FINALIZED version are the single superseding
// transition performed by its replacement's finalize transaction.

const transitionInputSchema = z
  .object({
    version: z.number().int().min(1).optional(),
    expectedDocVersion: z.number().int().min(1),
  })
  .strict();

type LoadedTx = { head: PartnerReviewHeadDoc; version: PartnerReviewVersionDoc };

function parseTxDocs(headSnap: FirebaseFirestore.DocumentSnapshot, versionSnap: FirebaseFirestore.DocumentSnapshot): LoadedTx | null {
  const head = headSnap.exists ? partnerReviewHeadDocSchema.safeParse(headSnap.data()) : null;
  const version = versionSnap.exists ? partnerReviewVersionDocSchema.safeParse(versionSnap.data()) : null;
  if (!head?.success || !version?.success) return null;
  return { head: head.data, version: version.data };
}

// ---- Submit (DRAFT -> IN_REVIEW) ----------------------------------------------------

type SubmitTxResult = { kind: "ok"; head: PartnerReviewHeadDoc; version: PartnerReviewVersionDoc } | { kind: "stale" } | { kind: "not_found" } | { kind: "invalid"; from: string };

export async function submitPartnerReviewForReview(actor: ActorContext | null, reviewRef: unknown, rawInput: unknown, requestId: string): Promise<PartnerReviewsServiceResult<PartnerReviewDetailDto>> {
  const loaded = await loadAuthorizedReview(actor, reviewRef, "submit_partner_review");
  if (!loaded.ok) return loaded.error;

  const parsed = transitionInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnerReviewsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const { head, partner } = loaded;
  const targetVersion = parsed.data.version ?? head.openVersion;
  if (targetVersion === null) return partnerReviewsInvalidInputResult("This review has no open Draft version to submit.");
  if (!(await getPartnerReviewVersionDoc(head.reviewRef, targetVersion))) return partnerReviewsNotFoundResult("Partner review version not found.");

  const db = getAdminFirestore();
  const headRef = partnerReviewsCollection().doc(head.reviewRef);
  const versionRef = partnerReviewVersionsCollection(head.reviewRef).doc(versionDocId(targetVersion));

  const result = await db.runTransaction<SubmitTxResult>(async (tx) => {
    const [headSnap, versionSnap] = await Promise.all([tx.get(headRef), tx.get(versionRef)]);
    const docs = parseTxDocs(headSnap, versionSnap);
    if (!docs) return { kind: "not_found" };

    if (docs.version.docVersion !== parsed.data.expectedDocVersion) return { kind: "stale" };
    if (docs.head.openVersion !== docs.version.version || !canTransitionLifecycle(docs.version.status, "IN_REVIEW", PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)) {
      return { kind: "invalid", from: docs.version.status };
    }

    const now = new Date().toISOString();
    const version: PartnerReviewVersionDoc = { ...docs.version, status: "IN_REVIEW", submittedAt: now, submittedByUserRef: actor!.userRef, docVersion: docs.version.docVersion + 1 };
    const nextHead: PartnerReviewHeadDoc = {
      ...docs.head,
      ...scopeSnapshotOf(partner),
      latestStatus: docs.head.latestVersion === version.version ? "IN_REVIEW" : docs.head.latestStatus,
      docVersion: docs.head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
      display: buildHeadDisplay({ version, latestVersion: docs.head.latestVersion, event: { kind: "submitted", at: now }, finalized: carriedFinalized(docs.head) }),
      freshnessHint: null,
    };

    tx.set(versionRef, version);
    tx.set(headRef, nextHead);
    appendPartnerReviewEvent(tx, { reviewRef: head.reviewRef, kind: "submitted", version: version.version, actorUserRef: actor!.userRef, metadata: { from: "DRAFT", to: "IN_REVIEW" }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead, version };
  });

  if (result.kind === "not_found") return partnerReviewsNotFoundResult("Partner review version not found.");
  if (result.kind === "stale") return partnerReviewsStaleResult();
  if (result.kind === "invalid") return partnerReviewsInvalidInputResult(`Only a Draft version can be submitted for review - this version is ${result.from}.`);

  return { ok: true, data: await buildReviewDetail({ actor: actor!, head: result.head, partner, version: result.version, includeFreshness: true }) };
}

// ---- Finalize (IN_REVIEW -> FINALIZED, superseding the prior finalized) ---------------

type FinalizeTxResult =
  | { kind: "ok"; head: PartnerReviewHeadDoc; version: PartnerReviewVersionDoc }
  | { kind: "stale" }
  | { kind: "not_found" }
  | { kind: "invalid"; from: string };

// Freezes an IN_REVIEW version: it becomes FINALIZED and - in the SAME
// transaction - the head's previous current finalized version (if any)
// becomes SUPERSEDED and the head pointers move (currentFinalizedVersion =
// this version, openVersion = null). Only one of several concurrent
// finalize requests can win: each transaction reads the version first, so
// the losers observe the already-bumped docVersion / non-IN_REVIEW status
// and fail safely without writing.
//
// Step 13A.1 - finalize never KNOWINGLY freezes stale evidence. Order of
// checks:
//   1. authz (feature + finalize_approve action + live Partner scope);
//   2. cheap preconditions on the version as currently stored: it exists, the
//      caller's expectedDocVersion matches (stale_write), it is the head's
//      open version and IN_REVIEW (invalid_input) - all BEFORE any upstream
//      read, so a plainly invalid request costs nothing;
//   3. recompute the CURRENT upstream source fingerprint with the same
//      actor-independent collector every other path uses and compare it to
//      the version's stored sourceFingerprint. A mismatch means upstream
//      changed after the reviewed snapshot: reject with the module's typed
//      not-ready convention (HTTP 409 + blockers) and blocker code
//      REFRESH_REQUIRED. Finalize NEVER auto-refreshes - the reviewer must
//      explicitly refresh the In Review version (refresh endpoint) and then
//      finalize. A rejected stale finalize performs NO write of any kind
//      (no version/head change, no supersession, no event);
//   4. only then the transaction below - the only writer - which keeps its own
//      docVersion / open-version checks, so losers of a concurrent finalize
//      still fail safely.
// Missing or incomplete evidence alone does NOT block: a current snapshot
// that records its incompleteness (approved content without Analytics,
// rows without a reporting period, ...) freezes with those reasons intact.
// Only an unincorporated upstream CHANGE blocks.
//
// Residual window: upstream can still change between step 3 and the commit
// (the transaction deliberately does not read upstream - it would need
// unbounded cross-collection reads). Such a change is never silent: the
// finalized version simply reports freshness `revision_available`
// afterwards, and a revision can be created.
export async function finalizePartnerReview(actor: ActorContext | null, reviewRef: unknown, rawInput: unknown, requestId: string): Promise<PartnerReviewsServiceResult<PartnerReviewDetailDto>> {
  const loaded = await loadAuthorizedReview(actor, reviewRef, "finalize_approve");
  if (!loaded.ok) return loaded.error;

  const parsed = transitionInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnerReviewsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const { head, partner } = loaded;
  const targetVersion = parsed.data.version ?? head.openVersion;
  if (targetVersion === null) return partnerReviewsInvalidInputResult("This review has no open In Review version to finalize.");
  const target = await getPartnerReviewVersionDoc(head.reviewRef, targetVersion);
  if (!target) return partnerReviewsNotFoundResult("Partner review version not found.");

  // Cheap preconditions first (same precedence the transaction applies).
  if (target.docVersion !== parsed.data.expectedDocVersion) return partnerReviewsStaleResult();
  if (head.openVersion !== target.version || !canTransitionLifecycle(target.status, "FINALIZED", PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)) {
    return partnerReviewsInvalidInputResult(`Only an In Review version can be finalized - this version is ${target.status}.`);
  }

  // Stale-evidence guard (no writes on rejection, never auto-refresh).
  const current = await collectPartnerEvidence(head.partnerRef, { periodKey: head.periodKey, periodStart: head.periodStart, periodEnd: head.periodEnd });
  if (current.sourceFingerprint !== target.sourceFingerprint) {
    return partnerReviewsNotReadyResult("The evidence in this In Review version is out of date - upstream records changed after it was captured. Refresh the In Review version first, review the refreshed evidence, then finalize.", [
      { code: "REFRESH_REQUIRED", message: "Refresh the In Review version explicitly (refresh endpoint) before finalizing; finalize never refreshes automatically." },
    ]);
  }

  const db = getAdminFirestore();
  const headRef = partnerReviewsCollection().doc(head.reviewRef);
  const versionRef = partnerReviewVersionsCollection(head.reviewRef).doc(versionDocId(targetVersion));

  const result = await db.runTransaction<FinalizeTxResult>(async (tx) => {
    // ALL reads first: head, the version being finalized, and the prior
    // finalized version (only known once the head has been read).
    const [headSnap, versionSnap] = await Promise.all([tx.get(headRef), tx.get(versionRef)]);
    const docs = parseTxDocs(headSnap, versionSnap);
    if (!docs) return { kind: "not_found" };

    const priorNumber = docs.head.currentFinalizedVersion;
    const priorSnap = priorNumber !== null && priorNumber !== docs.version.version ? await tx.get(partnerReviewVersionsCollection(head.reviewRef).doc(versionDocId(priorNumber))) : null;
    const prior = priorSnap && priorSnap.exists ? partnerReviewVersionDocSchema.safeParse(priorSnap.data()) : null;

    if (docs.version.docVersion !== parsed.data.expectedDocVersion) return { kind: "stale" };
    if (docs.head.openVersion !== docs.version.version || !canTransitionLifecycle(docs.version.status, "FINALIZED", PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)) {
      return { kind: "invalid", from: docs.version.status };
    }
    // A recorded prior finalized version must be intact and FINALIZED.
    if (priorNumber !== null && (!prior?.success || !canTransitionLifecycle(prior.data.status, "SUPERSEDED", PARTNER_REVIEW_LIFECYCLE_TRANSITIONS))) {
      return { kind: "invalid", from: prior?.success ? prior.data.status : "MISSING" };
    }

    const now = new Date().toISOString();
    const finalized: PartnerReviewVersionDoc = { ...docs.version, status: "FINALIZED", finalizedAt: now, finalizedByUserRef: actor!.userRef, docVersion: docs.version.docVersion + 1 };
    const nextHead: PartnerReviewHeadDoc = {
      ...docs.head,
      ...scopeSnapshotOf(partner),
      currentFinalizedVersion: finalized.version,
      openVersion: null,
      latestStatus: docs.head.latestVersion === finalized.version ? "FINALIZED" : docs.head.latestStatus,
      docVersion: docs.head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
      display: buildHeadDisplay({
        version: finalized,
        latestVersion: docs.head.latestVersion,
        event: { kind: "finalized", at: now },
        finalized: { version: finalized.version, at: now },
        supersededVersion: prior?.success ? prior.data.version : null,
      }),
      freshnessHint: null,
    };

    tx.set(versionRef, finalized);
    if (prior?.success) {
      const superseded: PartnerReviewVersionDoc = { ...prior.data, status: "SUPERSEDED", supersededAt: now, supersededByVersion: finalized.version, docVersion: prior.data.docVersion + 1 };
      tx.set(partnerReviewVersionsCollection(head.reviewRef).doc(versionDocId(prior.data.version)), superseded);
    }
    tx.set(headRef, nextHead);

    appendPartnerReviewEvent(tx, {
      reviewRef: head.reviewRef,
      kind: "finalized",
      version: finalized.version,
      actorUserRef: actor!.userRef,
      metadata: { from: "IN_REVIEW", to: "FINALIZED", sourceFingerprint: finalized.sourceFingerprint, supersedesVersion: prior?.success ? prior.data.version : null },
      requestId,
      createdAt: now,
    });
    if (prior?.success) {
      appendPartnerReviewEvent(tx, {
        reviewRef: head.reviewRef,
        kind: "superseded",
        version: prior.data.version,
        actorUserRef: actor!.userRef,
        metadata: { from: "FINALIZED", to: "SUPERSEDED", supersededByVersion: finalized.version },
        requestId,
        createdAt: now,
      });
    }
    return { kind: "ok", head: nextHead, version: finalized };
  });

  if (result.kind === "not_found") return partnerReviewsNotFoundResult("Partner review version not found.");
  if (result.kind === "stale") return partnerReviewsStaleResult();
  if (result.kind === "invalid") return partnerReviewsInvalidInputResult(`Only an In Review version can be finalized - this version is ${result.from}.`);

  return { ok: true, data: await buildReviewDetail({ actor: actor!, head: result.head, partner, version: result.version, includeFreshness: true }) };
}

// ---- Create revision -----------------------------------------------------------------------

const revisionInputSchema = z.object({ expectedDocVersion: z.number().int().min(1) }).strict();

type RevisionTxResult =
  | { kind: "ok"; head: PartnerReviewHeadDoc; version: PartnerReviewVersionDoc }
  | { kind: "stale" }
  | { kind: "not_found" }
  | { kind: "open_version_exists" }
  | { kind: "no_finalized" }
  | { kind: "not_needed" };

// Creates the next version (latestVersion + 1) as a fresh DRAFT. Allowed
// only when: a current FINALIZED version exists, NO open version exists,
// and the finalized evidence is genuinely stale (its source fingerprint
// differs from the current one). The prior FINALIZED version is left
// untouched - it stays FINALIZED until the replacement itself is
// finalized. The transaction reads the head first and verifies the
// caller's expected HEAD docVersion, so under concurrency exactly one
// caller creates version N+1; the loser observes the new open version and
// gets a deterministic conflict.
export async function createPartnerReviewRevision(actor: ActorContext | null, reviewRef: unknown, rawInput: unknown, requestId: string): Promise<PartnerReviewsServiceResult<PartnerReviewDetailDto>> {
  const loaded = await loadAuthorizedReview(actor, reviewRef, "create");
  if (!loaded.ok) return loaded.error;

  const parsed = revisionInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnerReviewsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const { head, partner } = loaded;
  if (head.currentFinalizedVersion === null) return partnerReviewsInvalidInputResult("A revision can only be created after a version has been finalized.");
  if (head.openVersion !== null) return partnerReviewsConflictResult("A Draft or In Review version is already open for this review.");
  if (head.latestVersion >= MAX_PARTNER_REVIEW_VERSIONS) return partnerReviewsInvalidInputResult("This review has reached its maximum number of versions.");

  const evidence = await collectPartnerEvidence(head.partnerRef, { periodKey: head.periodKey, periodStart: head.periodStart, periodEnd: head.periodEnd });
  const summary = computeReviewListSummary(evidence.snapshot);

  const db = getAdminFirestore();
  const headRef = partnerReviewsCollection().doc(head.reviewRef);
  const finalizedRef = partnerReviewVersionsCollection(head.reviewRef).doc(versionDocId(head.currentFinalizedVersion));

  const result = await db.runTransaction<RevisionTxResult>(async (tx) => {
    const [headSnap, finalizedSnap] = await Promise.all([tx.get(headRef), tx.get(finalizedRef)]);
    const docs = parseTxDocs(headSnap, finalizedSnap);
    if (!docs) return { kind: "not_found" };

    if (docs.head.docVersion !== parsed.data.expectedDocVersion) return { kind: "stale" };
    if (docs.head.openVersion !== null) return { kind: "open_version_exists" };
    if (docs.head.currentFinalizedVersion === null || docs.head.currentFinalizedVersion !== docs.version.version || docs.version.status !== "FINALIZED") return { kind: "no_finalized" };
    if (docs.version.sourceFingerprint === evidence.sourceFingerprint) return { kind: "not_needed" };

    const now = new Date().toISOString();
    const nextNumber = docs.head.latestVersion + 1;
    const created: PartnerReviewVersionDoc = partnerReviewVersionDocSchema.parse({
      reviewRef: head.reviewRef,
      version: nextNumber,
      status: "DRAFT",
      docVersion: 1,
      snapshot: evidence.snapshot,
      evidenceCutoff: evidence.snapshot.evidenceCutoff,
      sourceFingerprint: evidence.sourceFingerprint,
      sourceRefs: evidence.sourceRefs,
      generatedAt: now,
      generatedByUserRef: actor!.userRef,
      createdAt: now,
      createdByUserRef: actor!.userRef,
      summary,
    });
    const nextHead: PartnerReviewHeadDoc = {
      ...docs.head,
      ...scopeSnapshotOf(partner),
      latestVersion: nextNumber,
      latestStatus: "DRAFT",
      openVersion: nextNumber,
      docVersion: docs.head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
      // The finalized version (still current) keeps its recorded finalization time; a legacy head without a
      // display block falls back to the finalized version document this transaction already read.
      display: buildHeadDisplay({ version: created, latestVersion: nextNumber, event: { kind: "revision_created", at: now }, finalized: carriedFinalized(docs.head, docs.version.finalizedAt) }),
      freshnessHint: null,
    };

    // tx.create fails loudly if version N+1 somehow already exists.
    tx.create(partnerReviewVersionsCollection(head.reviewRef).doc(versionDocId(nextNumber)), created);
    tx.set(headRef, nextHead);
    appendPartnerReviewEvent(tx, {
      reviewRef: head.reviewRef,
      kind: "revision_created",
      version: nextNumber,
      actorUserRef: actor!.userRef,
      metadata: { basedOnFinalizedVersion: docs.version.version, previousSourceFingerprint: docs.version.sourceFingerprint, sourceFingerprint: evidence.sourceFingerprint },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead, version: created };
  });

  if (result.kind === "not_found") return partnerReviewsNotFoundResult("Partner review not found.");
  if (result.kind === "stale") return partnerReviewsStaleResult();
  if (result.kind === "open_version_exists") return partnerReviewsConflictResult("A Draft or In Review version is already open for this review.");
  if (result.kind === "no_finalized") return partnerReviewsInvalidInputResult("A revision can only be created after a version has been finalized.");
  if (result.kind === "not_needed") {
    return partnerReviewsNotReadyResult("The finalized evidence still matches current upstream evidence, so no revision is needed.", [
      { code: "REVISION_NOT_NEEDED", message: "Current upstream evidence is unchanged since the finalized version." },
    ]);
  }

  return { ok: true, data: await buildReviewDetail({ actor: actor!, head: result.head, partner, version: result.version, evidence, includeFreshness: true }) };
}

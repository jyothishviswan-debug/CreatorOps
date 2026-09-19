import { z } from "zod";

import type { ActionId } from "@/server/authz/actions";
import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import type { PartnerDoc } from "@/server/partners/types";
import {
  toPartnerReviewHeadDto,
  toPartnerReviewVersionDto,
  toPartnerReviewVersionSummaryDto,
  type PartnerReviewDetailDto,
  type PartnerReviewFreshnessDto,
  type PartnerReviewVersionDto,
} from "./client-dto";
import { snapshotHasEvidence, type BuiltEvidence } from "./evidence-builder";
import { collectPartnerEvidence } from "./evidence-collector";
import { evaluateFreshness } from "./fingerprint";
import { getPartnerReviewHeadDoc, getPartnerReviewVersionDoc, listPartnerReviewVersionDocs, partnerReviewsCollection, partnerReviewVersionsCollection, versionDocId } from "./firestore";
import { appendPartnerReviewEvent } from "./partner-review-events";
import { loadAuthorizedPartner, requirePartnerReviewsAccess, requirePartnerReviewsFeatureAccess } from "./partner-reviews-gate";
import { derivePeriod, isFuturePeriod, isValidReviewRef, reviewRefFor } from "./period";
import { resolveActorSourceAccess } from "./source-access";
import { redactVersionForActor } from "./source-context-redaction";
import {
  PARTNER_REVIEW_OPEN_STATUSES,
  partnerReviewHeadDocSchema,
  partnerReviewsConflictResult,
  partnerReviewsInvalidInputResult,
  partnerReviewsNotFoundResult,
  partnerReviewsStaleResult,
  partnerReviewsUnauthorizedResult,
  partnerReviewVersionDocSchema,
  type NeedsReviewResult,
  type PartnerReviewFreshness,
  type PartnerReviewHeadDoc,
  type PartnerReviewsServiceResult,
  type PartnerReviewStatus,
  type PartnerReviewVersionDoc,
} from "./types";

// Step 13A: trusted Partner Reviews service - reads, generate, refresh,
// freshness inspection and derived Needs Review. Submit/finalize/revision
// live in partner-review-lifecycle-service.ts. Nothing here ever writes to
// an upstream Assignment/Content/Analytics/Partner/Campaign record.

// --- Shared helpers ----------------------------------------------------------------

export function isOpenStatus(status: PartnerReviewStatus): boolean {
  return (PARTNER_REVIEW_OPEN_STATUSES as readonly PartnerReviewStatus[]).includes(status);
}

// The head's own scope fields are a point-in-time copy of the LIVE
// Partner's scope, refreshed on every mutation - they only serve bounded
// scoped list queries (see firestore.ts).
export function scopeSnapshotOf(partner: PartnerDoc): Pick<PartnerReviewHeadDoc, "partnerUid" | "ownerUid" | "regionIds" | "teamIds"> {
  return { partnerUid: partner.uid, ownerUid: partner.ownerUid, regionIds: partner.regionIds, teamIds: partner.teamIds };
}

// Loads a review head by its opaque ref and applies, in order: Feature (+
// Action, for a mutation) access, existence, and the LIVE Partner's Record
// Scope. Knowing a reviewRef never grants access. A missing review (or a
// missing underlying Partner) is not_found; an out-of-scope Partner is the
// existing safe scope_denied convention (HTTP 403 "Forbidden.").
export async function loadAuthorizedReview(
  actor: ActorContext | null,
  reviewRef: unknown,
  action: ActionId | null,
): Promise<{ ok: true; head: PartnerReviewHeadDoc; partner: PartnerDoc } | { ok: false; error: PartnerReviewsServiceResult<never> }> {
  const gate = action ? await requirePartnerReviewsAccess(actor, action) : await requirePartnerReviewsFeatureAccess(actor);
  if (!gate.ok) return { ok: false, error: partnerReviewsUnauthorizedResult(gate.reason) };

  if (typeof reviewRef !== "string" || reviewRef.length === 0) return { ok: false, error: partnerReviewsInvalidInputResult("Missing reviewRef.") };
  if (!isValidReviewRef(reviewRef)) return { ok: false, error: partnerReviewsNotFoundResult("Partner review not found.") };

  const head = await getPartnerReviewHeadDoc(reviewRef);
  if (!head) return { ok: false, error: partnerReviewsNotFoundResult("Partner review not found.") };

  const loaded = await loadAuthorizedPartner(actor!, head.partnerRef);
  if (!loaded.ok) return { ok: false, error: loaded.kind === "missing" ? partnerReviewsNotFoundResult("Partner review not found.") : loaded.error };

  return { ok: true, head, partner: loaded.partner };
}

// Pure-ish helper: the freshness of one version against a freshly built
// evidence bundle. `current` is null for a SUPERSEDED version (never compared).
function freshnessFor(head: PartnerReviewHeadDoc, version: PartnerReviewVersionDoc, current: BuiltEvidence | null, evaluatedAt: string): PartnerReviewFreshnessDto {
  const result: PartnerReviewFreshness = evaluateFreshness(version.sourceFingerprint, current?.sourceFingerprint ?? version.sourceFingerprint, version.status, {
    openVersionExists: head.openVersion !== null && head.openVersion !== version.version,
    incompleteReasons: version.snapshot.completeness.incompleteReasons,
  });
  return {
    ...result,
    version: version.version,
    snapshotFingerprint: version.sourceFingerprint,
    currentFingerprint: current?.sourceFingerprint ?? null,
    evaluatedAt,
  };
}

// The version a caller means by default: the open version if any, else the
// current finalized one, else the newest.
export function defaultVersionNumber(head: PartnerReviewHeadDoc): number {
  return head.openVersion ?? head.currentFinalizedVersion ?? head.latestVersion;
}

// Builds the actor-facing version DTO: the canonical stored evidence is run
// through the actor-scoped source-context redaction (which of the source
// Campaigns/Assignments/Content/Analytics records THIS actor may access is
// resolved once, in bulk). Every response that carries a snapshot or
// sourceRefs - reads AND mutation results - is built through here, so the
// acting user's response is redacted exactly like a plain read.
export async function buildActorVersionDto(actor: ActorContext, version: PartnerReviewVersionDoc): Promise<PartnerReviewVersionDto> {
  const access = await resolveActorSourceAccess(actor, version.snapshot);
  return toPartnerReviewVersionDto(version, redactVersionForActor(version, access));
}

// PER-REVIEW detail builder. `includeFreshness` triggers a bounded
// collectPartnerEvidence() recomputation for THIS one review (or reuses the
// bundle the caller just collected via `evidence`). That is acceptable for
// a single detail view but must NEVER be reached from a list/overview path:
// heads/list DTOs come from partner-review-list-service.ts, which is kept
// free of the collector and of freshness on purpose.
export async function buildReviewDetail(args: {
  actor: ActorContext;
  head: PartnerReviewHeadDoc;
  partner: PartnerDoc;
  version: PartnerReviewVersionDoc;
  // When supplied, freshness is computed against this bundle instead of a
  // fresh collection (the caller has just collected it).
  evidence?: BuiltEvidence;
  includeFreshness: boolean;
}): Promise<PartnerReviewDetailDto> {
  const { actor, head, partner, version } = args;
  const [versions, selectedVersion] = await Promise.all([listPartnerReviewVersionDocs(head.reviewRef), buildActorVersionDto(actor, version)]);

  let freshness: PartnerReviewFreshnessDto | null = null;
  if (args.includeFreshness) {
    const evaluatedAt = new Date().toISOString();
    if (version.status === "SUPERSEDED") {
      freshness = freshnessFor(head, version, null, evaluatedAt);
    } else {
      const evidence = args.evidence ?? (await collectPartnerEvidence(head.partnerRef, { periodKey: head.periodKey, periodStart: head.periodStart, periodEnd: head.periodEnd }));
      freshness = freshnessFor(head, version, evidence, evaluatedAt);
    }
  }

  return {
    head: toPartnerReviewHeadDto(head, partner.displayName),
    versions: versions.versions.map(toPartnerReviewVersionSummaryDto),
    hasMoreVersions: versions.hasMore,
    selectedVersion,
    freshness,
  };
}

// --- List ------------------------------------------------------------------------------
// The scoped head list lives in partner-review-list-service.ts, DELIBERATELY
// a separate module that never imports the evidence collector or the
// freshness evaluator: a list / overview page may show many reviews and must
// never trigger a full upstream freshness recomputation per row. Freshness is
// exposed ONLY through the single-review services below (getPartnerReview,
// getPartnerReviewVersion, inspectPartnerReviewFreshness). A test enforces
// that boundary (partner-reviews-boundary.test.ts). Re-exported here so
// existing importers keep working.
export { listPartnerReviewHeads, type ListPartnerReviewHeadsInput } from "./partner-review-list-service";

// --- Read ------------------------------------------------------------------------------

const versionNumberSchema = z.number().int().min(1);

// Head + bounded version summaries + the selected (default: open, else
// current finalized, else newest) version's full evidence detail + derived
// freshness (computed on read - never persisted, never mutating).
export async function getPartnerReview(actor: ActorContext | null, reviewRef: unknown, input: { version?: unknown } = {}): Promise<PartnerReviewsServiceResult<PartnerReviewDetailDto>> {
  const loaded = await loadAuthorizedReview(actor, reviewRef, null);
  if (!loaded.ok) return loaded.error;

  let versionNumber = defaultVersionNumber(loaded.head);
  if (input.version !== undefined) {
    const parsed = versionNumberSchema.safeParse(input.version);
    if (!parsed.success) return partnerReviewsInvalidInputResult("version must be a positive integer.");
    versionNumber = parsed.data;
  }

  const version = await getPartnerReviewVersionDoc(loaded.head.reviewRef, versionNumber);
  if (!version) return partnerReviewsNotFoundResult("Partner review version not found.");

  return { ok: true, data: await buildReviewDetail({ actor: actor!, head: loaded.head, partner: loaded.partner, version, includeFreshness: true }) };
}

export async function getPartnerReviewVersion(
  actor: ActorContext | null,
  reviewRef: unknown,
  versionInput: unknown,
): Promise<PartnerReviewsServiceResult<{ reviewRef: string; version: PartnerReviewVersionDto; freshness: PartnerReviewFreshnessDto }>> {
  const loaded = await loadAuthorizedReview(actor, reviewRef, null);
  if (!loaded.ok) return loaded.error;

  const parsed = versionNumberSchema.safeParse(typeof versionInput === "string" && /^\d+$/.test(versionInput) ? Number(versionInput) : versionInput);
  if (!parsed.success) return partnerReviewsInvalidInputResult("version must be a positive integer.");

  const version = await getPartnerReviewVersionDoc(loaded.head.reviewRef, parsed.data);
  if (!version) return partnerReviewsNotFoundResult("Partner review version not found.");

  const evaluatedAt = new Date().toISOString();
  const current = version.status === "SUPERSEDED" ? null : await collectPartnerEvidence(loaded.head.partnerRef, { periodKey: loaded.head.periodKey, periodStart: loaded.head.periodStart, periodEnd: loaded.head.periodEnd });

  return { ok: true, data: { reviewRef: loaded.head.reviewRef, version: await buildActorVersionDto(actor!, version), freshness: freshnessFor(loaded.head, version, current, evaluatedAt) } };
}

// Inspects current-source freshness for one version (default: the open,
// else the current finalized, else the newest version). Read-only: it
// never mutates any version, finalized or not.
export async function inspectPartnerReviewFreshness(
  actor: ActorContext | null,
  reviewRef: unknown,
  input: { version?: unknown } = {},
): Promise<PartnerReviewsServiceResult<{ reviewRef: string; periodKey: string; freshness: PartnerReviewFreshnessDto }>> {
  const loaded = await loadAuthorizedReview(actor, reviewRef, null);
  if (!loaded.ok) return loaded.error;

  let versionNumber = defaultVersionNumber(loaded.head);
  if (input.version !== undefined) {
    const parsed = versionNumberSchema.safeParse(input.version);
    if (!parsed.success) return partnerReviewsInvalidInputResult("version must be a positive integer.");
    versionNumber = parsed.data;
  }

  const version = await getPartnerReviewVersionDoc(loaded.head.reviewRef, versionNumber);
  if (!version) return partnerReviewsNotFoundResult("Partner review version not found.");

  const evaluatedAt = new Date().toISOString();
  const current = version.status === "SUPERSEDED" ? null : await collectPartnerEvidence(loaded.head.partnerRef, { periodKey: loaded.head.periodKey, periodStart: loaded.head.periodStart, periodEnd: loaded.head.periodEnd });

  return { ok: true, data: { reviewRef: loaded.head.reviewRef, periodKey: loaded.head.periodKey, freshness: freshnessFor(loaded.head, version, current, evaluatedAt) } };
}

// --- Needs Review (derived, never persisted) -------------------------------------------

const needsReviewInputSchema = z.object({ partnerRef: z.string().min(1), periodKey: z.string() }).strict();

// Derives whether a Partner + period needs review attention. Partner-scope
// gated exactly like every other read (a denied/missing Partner is one and
// the same safe outcome). Reasons:
//   no_review           no review exists yet but the period has evidence
//   no_evidence         no review and no in-period evidence (nothing to flag)
//   draft_open          an open Draft exists
//   in_review_open      an open In Review version exists
//   revision_available  the finalized evidence is behind upstream
//   up_to_date          finalized and matches upstream
export async function deriveNeedsReview(actor: ActorContext | null, rawInput: unknown): Promise<PartnerReviewsServiceResult<NeedsReviewResult>> {
  const gate = await requirePartnerReviewsFeatureAccess(actor);
  if (!gate.ok) return partnerReviewsUnauthorizedResult(gate.reason);

  const parsed = needsReviewInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnerReviewsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const period = derivePeriod(parsed.data.periodKey);
  if (!period) return partnerReviewsInvalidInputResult("periodKey must be a valid YYYY-MM month.");

  const loaded = await loadAuthorizedPartner(actor!, parsed.data.partnerRef);
  if (!loaded.ok) return loaded.kind === "missing" ? partnerReviewsInvalidInputResult("partnerRef does not resolve to a real Partner.") : loaded.error;

  const head = await getPartnerReviewHeadDoc(reviewRefFor(parsed.data.partnerRef, period.periodKey));

  if (!head) {
    const evidence = await collectPartnerEvidence(parsed.data.partnerRef, period);
    return snapshotHasEvidence(evidence.snapshot) ? { ok: true, data: { needsReview: true, reason: "no_review" } } : { ok: true, data: { needsReview: false, reason: "no_evidence" } };
  }

  if (head.openVersion !== null) {
    const open = await getPartnerReviewVersionDoc(head.reviewRef, head.openVersion);
    return { ok: true, data: { needsReview: true, reason: open?.status === "IN_REVIEW" ? "in_review_open" : "draft_open" } };
  }

  if (head.currentFinalizedVersion !== null) {
    const finalized = await getPartnerReviewVersionDoc(head.reviewRef, head.currentFinalizedVersion);
    if (!finalized) return { ok: true, data: { needsReview: true, reason: "revision_available" } };
    const current = await collectPartnerEvidence(parsed.data.partnerRef, period);
    return current.sourceFingerprint === finalized.sourceFingerprint ? { ok: true, data: { needsReview: false, reason: "up_to_date" } } : { ok: true, data: { needsReview: true, reason: "revision_available" } };
  }

  return { ok: true, data: { needsReview: true, reason: "no_review" } };
}

// --- Generate Draft ----------------------------------------------------------------------

const generateInputSchema = z.object({ partnerRef: z.string().min(1), periodKey: z.string() }).strict();

export type GeneratePartnerReviewOutcome = { outcome: "created" | "existing"; review: PartnerReviewDetailDto };

type GenerateTxResult = { kind: "created"; head: PartnerReviewHeadDoc; version: PartnerReviewVersionDoc } | { kind: "existing" };

// Generates version 1 (DRAFT) for one Partner + month. Idempotent by
// construction: the head document id IS the deterministic reviewRef, and
// creation happens inside a transaction that reads the head first - a
// retried or concurrent generate for the same Partner + period collapses
// onto the one head (the loser returns the existing review, never a
// second version 1).
export async function generatePartnerReviewDraft(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<PartnerReviewsServiceResult<GeneratePartnerReviewOutcome>> {
  const gate = await requirePartnerReviewsAccess(actor, "create");
  if (!gate.ok) return partnerReviewsUnauthorizedResult(gate.reason);

  const parsed = generateInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnerReviewsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const period = derivePeriod(parsed.data.periodKey);
  if (!period) return partnerReviewsInvalidInputResult("periodKey must be a valid YYYY-MM month.");
  if (isFuturePeriod(period, new Date())) return partnerReviewsInvalidInputResult("A review cannot be generated for a period that has not started yet.");

  const loaded = await loadAuthorizedPartner(actor!, parsed.data.partnerRef);
  if (!loaded.ok) return loaded.kind === "missing" ? partnerReviewsInvalidInputResult("partnerRef does not resolve to a real Partner.") : loaded.error;
  const partner = loaded.partner;

  const reviewRef = reviewRefFor(partner.partnerRef, period.periodKey);

  const returnExisting = async (): Promise<PartnerReviewsServiceResult<GeneratePartnerReviewOutcome>> => {
    const head = await getPartnerReviewHeadDoc(reviewRef);
    const version = head ? await getPartnerReviewVersionDoc(reviewRef, defaultVersionNumber(head)) : null;
    if (!head || !version) return partnerReviewsConflictResult("This review already exists but could not be resolved. Reload and try again.");
    return { ok: true, data: { outcome: "existing", review: await buildReviewDetail({ actor: actor!, head, partner, version, includeFreshness: true }) } };
  };

  // Fast path: a retry finds the head without collecting any evidence.
  if (await getPartnerReviewHeadDoc(reviewRef)) return returnExisting();

  const evidence = await collectPartnerEvidence(partner.partnerRef, period);
  const db = getAdminFirestore();
  const headRef = partnerReviewsCollection().doc(reviewRef);

  const txResult = await db.runTransaction<GenerateTxResult>(async (tx) => {
    const headSnap = await tx.get(headRef);
    if (headSnap.exists) return { kind: "existing" };

    const now = new Date().toISOString();
    const head: PartnerReviewHeadDoc = partnerReviewHeadDocSchema.parse({
      reviewRef,
      partnerRef: partner.partnerRef,
      ...scopeSnapshotOf(partner),
      periodKey: period.periodKey,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      latestVersion: 1,
      latestStatus: "DRAFT",
      currentFinalizedVersion: null,
      openVersion: 1,
      docVersion: 1,
      createdAt: now,
      createdByUserRef: actor!.userRef,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    const version: PartnerReviewVersionDoc = partnerReviewVersionDocSchema.parse({
      reviewRef,
      version: 1,
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
    });

    tx.create(headRef, head);
    tx.create(partnerReviewVersionsCollection(reviewRef).doc(versionDocId(1)), version);
    appendPartnerReviewEvent(tx, {
      reviewRef,
      kind: "generated",
      version: 1,
      actorUserRef: actor!.userRef,
      metadata: { periodKey: period.periodKey, sourceFingerprint: evidence.sourceFingerprint, sourceRefCount: evidence.sourceRefs.length },
      requestId,
      createdAt: now,
    });
    return { kind: "created", head, version };
  });

  if (txResult.kind === "existing") return returnExisting();

  return { ok: true, data: { outcome: "created", review: await buildReviewDetail({ actor: actor!, head: txResult.head, partner, version: txResult.version, evidence, includeFreshness: true }) } };
}

// --- Refresh Draft / In Review evidence ------------------------------------------------------

const refreshInputSchema = z
  .object({
    version: z.number().int().min(1).optional(),
    expectedDocVersion: z.number().int().min(1),
  })
  .strict();

type RefreshTxResult =
  | { kind: "ok"; head: PartnerReviewHeadDoc; version: PartnerReviewVersionDoc }
  | { kind: "stale" }
  | { kind: "not_found" }
  | { kind: "not_open" };

// Recomputes the evidence of the review's single OPEN (DRAFT/IN_REVIEW)
// version from current upstream truth and replaces that version's snapshot
// in place (same version number, same status, bumped docVersion). A
// FINALIZED/SUPERSEDED version can never be refreshed. The caller's
// expectedDocVersion (the version document's own docVersion) is verified
// inside the transaction - a stale request fails safely and changes
// nothing.
export async function refreshPartnerReviewEvidence(actor: ActorContext | null, reviewRef: unknown, rawInput: unknown, requestId: string): Promise<PartnerReviewsServiceResult<PartnerReviewDetailDto>> {
  const loaded = await loadAuthorizedReview(actor, reviewRef, "create");
  if (!loaded.ok) return loaded.error;

  const parsed = refreshInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnerReviewsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const { head, partner } = loaded;
  const targetVersion = parsed.data.version ?? head.openVersion;
  if (targetVersion === null) return partnerReviewsInvalidInputResult("This review has no open Draft or In Review version to refresh. Create a revision instead.");

  const target = await getPartnerReviewVersionDoc(head.reviewRef, targetVersion);
  if (!target) return partnerReviewsNotFoundResult("Partner review version not found.");
  if (!isOpenStatus(target.status)) return partnerReviewsInvalidInputResult(`Only a Draft or In Review version can be refreshed - version ${target.version} is ${target.status}.`);

  const evidence = await collectPartnerEvidence(head.partnerRef, { periodKey: head.periodKey, periodStart: head.periodStart, periodEnd: head.periodEnd });

  const db = getAdminFirestore();
  const headRef = partnerReviewsCollection().doc(head.reviewRef);
  const versionRef = partnerReviewVersionsCollection(head.reviewRef).doc(versionDocId(targetVersion));

  const txResult = await db.runTransaction<RefreshTxResult>(async (tx) => {
    const [headSnap, versionSnap] = await Promise.all([tx.get(headRef), tx.get(versionRef)]);
    const headParsed = headSnap.exists ? partnerReviewHeadDocSchema.safeParse(headSnap.data()) : null;
    const versionParsed = versionSnap.exists ? partnerReviewVersionDocSchema.safeParse(versionSnap.data()) : null;
    if (!headParsed?.success || !versionParsed?.success) return { kind: "not_found" };
    const freshHead = headParsed.data;
    const freshVersion = versionParsed.data;

    if (!isOpenStatus(freshVersion.status) || freshHead.openVersion !== freshVersion.version) return { kind: "not_open" };
    if (freshVersion.docVersion !== parsed.data.expectedDocVersion) return { kind: "stale" };

    const now = new Date().toISOString();
    const updatedVersion: PartnerReviewVersionDoc = {
      ...freshVersion,
      snapshot: evidence.snapshot,
      evidenceCutoff: evidence.snapshot.evidenceCutoff,
      sourceFingerprint: evidence.sourceFingerprint,
      sourceRefs: evidence.sourceRefs,
      lastRefreshedAt: now,
      lastRefreshedByUserRef: actor!.userRef,
      docVersion: freshVersion.docVersion + 1,
    };
    const updatedHead: PartnerReviewHeadDoc = { ...freshHead, ...scopeSnapshotOf(partner), docVersion: freshHead.docVersion + 1, updatedAt: now, updatedByUserRef: actor!.userRef };

    tx.set(versionRef, updatedVersion);
    tx.set(headRef, updatedHead);
    appendPartnerReviewEvent(tx, {
      reviewRef: head.reviewRef,
      kind: "refreshed",
      version: freshVersion.version,
      actorUserRef: actor!.userRef,
      metadata: { previousSourceFingerprint: freshVersion.sourceFingerprint, sourceFingerprint: evidence.sourceFingerprint, sourceRefCount: evidence.sourceRefs.length },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: updatedHead, version: updatedVersion };
  });

  if (txResult.kind === "not_found") return partnerReviewsNotFoundResult("Partner review version not found.");
  if (txResult.kind === "not_open") return partnerReviewsInvalidInputResult("Only a Draft or In Review version can be refreshed.");
  if (txResult.kind === "stale") return partnerReviewsStaleResult();

  return { ok: true, data: await buildReviewDetail({ actor: actor!, head: txResult.head, partner, version: txResult.version, evidence, includeFreshness: true }) };
}

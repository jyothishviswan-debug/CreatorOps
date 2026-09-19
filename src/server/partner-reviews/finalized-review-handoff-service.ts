import type { ActorContext } from "@/server/authz/types";

import { buildFinalizedReviewHandoff, evaluateReviewVersionCurrency, type FinalizedReviewHandoffDto, type ReviewVersionCurrency } from "./finalized-review-handoff";
import { getPartnerReviewVersionDoc } from "./firestore";
import { loadAuthorizedReview } from "./partner-review-service";
import { partnerReviewsInvalidInputResult, partnerReviewsNotFoundResult, type PartnerReviewsServiceResult, type PartnerReviewVersionDoc } from "./types";

// Step 13A.1 (revised): the READ-ONLY service behind the finalized-review
// handoff contract (see finalized-review-handoff.ts). Same authorization
// chain as every other Partner Reviews read: the `partner_reviews` feature
// (read) + the LIVE Partner's Record Scope, via loadAuthorizedReview - there
// is no new action and knowing a reviewRef grants nothing. Nothing here
// writes: it never mutates a version or the head, and never touches any
// downstream record.

function parseVersionInput(input: unknown): { ok: true; version: number | undefined } | { ok: false } {
  if (input === undefined || input === null) return { ok: true, version: undefined };
  const value = typeof input === "string" && /^\d+$/.test(input) ? Number(input) : input;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? { ok: true, version: value } : { ok: false };
}

function isHandoffable(version: PartnerReviewVersionDoc): boolean {
  return version.status === "FINALIZED" || version.status === "SUPERSEDED";
}

// The handoff of a finalized version (default: the current finalized
// version). A SUPERSEDED version stays addressable and reports
// `referenced_review_version_is_stale`. A DRAFT / IN_REVIEW version is not
// finalized -> invalid_input.
export async function getFinalizedReviewHandoff(actor: ActorContext | null, reviewRef: unknown, versionInput?: unknown): Promise<PartnerReviewsServiceResult<FinalizedReviewHandoffDto>> {
  const loaded = await loadAuthorizedReview(actor, reviewRef, null);
  if (!loaded.ok) return loaded.error;

  const parsed = parseVersionInput(versionInput);
  if (!parsed.ok) return partnerReviewsInvalidInputResult("version must be a positive integer.");

  const versionNumber = parsed.version ?? loaded.head.currentFinalizedVersion;
  if (versionNumber === null) return partnerReviewsInvalidInputResult("This review has no finalized version - it is not finalized.");

  const version = await getPartnerReviewVersionDoc(loaded.head.reviewRef, versionNumber);
  if (!version) return partnerReviewsNotFoundResult("Partner review version not found.");
  if (!isHandoffable(version)) return partnerReviewsInvalidInputResult(`Only a finalized version can be handed off - version ${version.version} is ${version.status} (not finalized).`);

  return { ok: true, data: buildFinalizedReviewHandoff({ head: loaded.head, version, partnerDisplayName: loaded.partner.displayName }) };
}

// Whether a referenced (reviewRef, version) is still the current finalized
// version. Same authorization chain; a not-yet-finalized version is
// invalid_input.
export async function getReviewVersionCurrency(actor: ActorContext | null, reviewRef: unknown, versionInput: unknown): Promise<PartnerReviewsServiceResult<ReviewVersionCurrency>> {
  const loaded = await loadAuthorizedReview(actor, reviewRef, null);
  if (!loaded.ok) return loaded.error;

  const parsed = parseVersionInput(versionInput);
  if (!parsed.ok || parsed.version === undefined) return partnerReviewsInvalidInputResult("version must be a positive integer.");

  const version = await getPartnerReviewVersionDoc(loaded.head.reviewRef, parsed.version);
  if (!version) return partnerReviewsNotFoundResult("Partner review version not found.");
  if (!isHandoffable(version)) return partnerReviewsInvalidInputResult(`Version ${version.version} is ${version.status} (not finalized).`);

  return { ok: true, data: evaluateReviewVersionCurrency(loaded.head, version) };
}

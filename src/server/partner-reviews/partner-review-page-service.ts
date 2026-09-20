import type { ActorContext } from "@/server/authz/types";

import type { PartnerReviewDetailDto } from "./client-dto";
import { getReviewActionPermissions } from "./partner-review-permissions";
import { getPartnerReview } from "./partner-review-service";
import type { PartnerReviewsServiceResult } from "./types";
import type { ReviewActionPermissions } from "./ui-dto";
import type { VersionParam } from "./ui-params";

// Step 13B: the read behind the Review Detail page. It is the ACCEPTED
// getPartnerReview (live Partner scope + actor-scoped redaction + one bounded
// freshness computation for THIS review) plus the actor's server-computed action
// booleans. Nothing about the review itself is re-derived or re-shaped here.
export type PartnerReviewPageDto = {
  detail: PartnerReviewDetailDto;
  permissions: ReviewActionPermissions;
  // `?version=` was not a positive integer -> the default version is shown.
  invalidVersionRequested: boolean;
  // `?version=N` named a version this review does not have -> the default version is shown.
  versionNotFound: boolean;
};

export async function getPartnerReviewPage(actor: ActorContext | null, reviewRef: unknown, version: VersionParam): Promise<PartnerReviewsServiceResult<PartnerReviewPageDto>> {
  let versionNotFound = false;
  let result = await getPartnerReview(actor, reviewRef, version.state === "valid" ? { version: version.version } : {});

  // An unknown VERSION is not an unknown REVIEW: fall back to the default version and say so.
  if (!result.ok && result.code === "not_found" && version.state === "valid") {
    const fallback = await getPartnerReview(actor, reviewRef, {});
    if (fallback.ok) {
      versionNotFound = true;
      result = fallback;
    }
  }
  if (!result.ok) return result;

  return { ok: true, data: { detail: result.data, permissions: await getReviewActionPermissions(actor), invalidVersionRequested: version.state === "invalid", versionNotFound } };
}

// Step 13B: the ONE server implementation of the Review Detail page. An unknown (or malformed) reviewRef
// is a not-found state; a review whose LIVE Partner is out of the actor's scope is the neutral
// access-denied frame. Everything else is the accepted getPartnerReview, read once.
import { EmptyState } from "@/ui/States";
import { resolveRequestActor } from "@/server/partner-reviews/http";
import { getPartnerReviewPage } from "@/server/partner-reviews/partner-review-page-service";
import type { DetailTab, VersionParam } from "@/server/partner-reviews/ui-params";

import { PartnerReviewsDetailFrame } from "./PartnerReviewsPageShell";
import { ReviewDetail } from "./ReviewDetail";

export async function PartnerReviewDetailPage({ reviewRef, tab, version }: { reviewRef: string; tab: DetailTab; version: VersionParam }) {
  const actor = await resolveRequestActor();
  const result = await getPartnerReviewPage(actor, reviewRef, version);

  if (!result.ok && (result.code === "not_found" || result.code === "invalid_input")) return "not_found" as const;

  if (!result.ok) {
    return (
      <PartnerReviewsDetailFrame>
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view this Partner Review." icon="lock" />
        </section>
      </PartnerReviewsDetailFrame>
    );
  }

  const notices: string[] = [];
  if (result.data.invalidVersionRequested) notices.push("The requested version is not a valid version number, so the default version is shown.");
  if (result.data.versionNotFound) notices.push("This review has no such version, so the default version is shown.");

  return (
    <PartnerReviewsDetailFrame>
      <ReviewDetail initialDetail={result.data.detail} permissions={result.data.permissions} initialTab={tab} notices={notices} />
    </PartnerReviewsDetailFrame>
  );
}

// Step 13B: the ONE server implementation of the Partner Reviews Workspace (/partner-reviews/workspace).
// URL state (filter / signal / month / Partner / region) is parsed and validated here, handed to the trusted
// service for the first bounded page, and the client component pages the rest through the load-more API.
import { resolveRequestActor } from "@/server/partner-reviews/http";
import { getPartnerReviewsWorkspace } from "@/server/partner-reviews/partner-review-workspace-service";
import { firstOf, parseFilterParam, parseMonthParam, parsePartnerRefParam, parseRegionParam, parseSignalParam, WORKSPACE_PAGE_SIZE, type RawParam } from "@/server/partner-reviews/ui-params";

import { PartnerReviewsAccessDenied, PartnerReviewsPageShell } from "./PartnerReviewsPageShell";
import { PartnerReviewsWorkspace } from "./PartnerReviewsWorkspace";
import type { WorkspaceQueryState } from "./workspace-query";

export type WorkspaceSearchParams = { filter?: RawParam; month?: RawParam; signal?: RawParam; partnerRef?: RawParam; region?: RawParam };

export async function PartnerReviewsWorkspacePage({ params }: { params: WorkspaceSearchParams }) {
  const actor = await resolveRequestActor();

  const month = parseMonthParam(params.month);
  const state: WorkspaceQueryState = {
    filter: parseFilterParam(params.filter),
    signal: parseSignalParam(params.signal),
    month: month.state === "valid" ? month.month : firstOf(params.month) ? (firstOf(params.month) as string) : null,
    partnerRef: parsePartnerRefParam(params.partnerRef) ?? null,
    region: parseRegionParam(params.region),
  };

  const result = await getPartnerReviewsWorkspace(actor, { month, filter: state.filter, signal: state.signal, partnerRef: state.partnerRef ?? undefined, region: state.region, limit: WORKSPACE_PAGE_SIZE });
  if (!result.ok) return <PartnerReviewsAccessDenied title="Partner Reviews workspace" />;

  return (
    <PartnerReviewsPageShell title="Partner Reviews workspace" description="Review queue, drafts and finalized history for every Partner-month you are authorized to see.">
      <PartnerReviewsWorkspace key={JSON.stringify(state)} initial={result.data} state={state} />
    </PartnerReviewsPageShell>
  );
}

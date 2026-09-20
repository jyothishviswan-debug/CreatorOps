// Step 13B: the ONE server implementation of the Partner Reviews Overview (/partner-reviews).
//
// The composition is the golden master's OV_DATA["creator-reviews"] (see overview-model.ts): the
// skeleton's structure is preserved exactly - `ov-page` > head > ModuleTabs > ContextBanner >
// OverviewKpiRow > OverviewPanels(top, 4/4/4) > OverviewRow secondary (bottom, 3/3/3/3). The bottom row
// is composed manually (same idiom as Campaigns / Analytics) only so the Needs Attention rows can be
// real links; its other panels use the very building blocks OverviewPanels itself dispatches to.
import { ActionGrid, ContextBanner, DonutRing, Events, OverviewKpiRow, OverviewPanel, OverviewPanels, OverviewRow } from "@/ui/Overview";
import { resolveRequestActor } from "@/server/partner-reviews/http";
import { getPartnerReviewsOverview } from "@/server/partner-reviews/partner-review-overview-service";
import { overviewHref, type MonthParam } from "@/server/partner-reviews/ui-params";

import { buildOverviewModel, OVERVIEW_DESCRIPTION, OVERVIEW_EYEBROW, OVERVIEW_TITLE } from "./overview-model";
import { PartnerReviewsAccessDenied, PartnerReviewsPageShell } from "./PartnerReviewsPageShell";
import { ReviewAttentionPanel } from "./ReviewAttentionPanel";
import { ReviewMonthSelect } from "./ReviewMonthSelect";

export async function PartnerReviewsOverviewPage({ month }: { month: MonthParam }) {
  const actor = await resolveRequestActor();
  const result = await getPartnerReviewsOverview(actor, month);
  if (!result.ok) return <PartnerReviewsAccessDenied />;

  const data = result.data;
  const model = buildOverviewModel(data);
  const [lifecycle, attention, activity, actions] = model.bottomPanels;

  const sourceLabel = data.month.resolved === null ? "No review months yet" : data.month.source === "explicit" ? "Selected month" : data.month.source === "latest_review" ? "Latest review month" : "Latest month with Assignments";

  return (
    <PartnerReviewsPageShell
      eyebrow={OVERVIEW_EYEBROW}
      title={OVERVIEW_TITLE}
      description={OVERVIEW_DESCRIPTION}
      actions={
        <ReviewMonthSelect
          options={data.month.options.map((option) => ({ ...option, href: overviewHref(option.month) }))}
          value={data.month.resolved}
          sourceLabel={sourceLabel}
          latestHref={data.month.source === "explicit" ? overviewHref(null) : null}
        />
      }
    >
      <ContextBanner icon="shield" title={model.banner.title} description={model.banner.description} chips={model.chips} />
      {data.month.invalidRequested && (
        <p className="foundationnote" style={{ margin: "0 0 8px" }}>
          The requested month is not a valid YYYY-MM month, so the latest review month is shown.
        </p>
      )}

      <OverviewKpiRow items={model.kpis} />
      <OverviewPanels panels={model.topPanels} />

      <OverviewRow secondary>
        {lifecycle && lifecycle.kind === "donut" && (
          <OverviewPanel span={lifecycle.span} icon={lifecycle.icon} tone={0} title={lifecycle.title} note={lifecycle.note} foot={lifecycle.foot} link>
            <DonutRing segments={lifecycle.segments} total={lifecycle.total} totalLabel={lifecycle.totalLabel} />
          </OverviewPanel>
        )}
        {attention && attention.kind === "attention" && <ReviewAttentionPanel span={attention.span} tone={1} title={attention.title} note={attention.note} foot={attention.foot} rows={attention.rows} links={model.attentionLinks} />}
        {activity && activity.kind === "activity" && (
          <OverviewPanel span={activity.span} icon={activity.icon} tone={2} title={activity.title} note={activity.note} foot={activity.foot} link>
            {activity.rows.length === 0 ? <p className="foundationnote">Review activity appears here once a review is generated.</p> : <Events items={activity.rows.map((row) => ({ icon: "clock", title: row.title, detail: row.detail, href: row.href }))} />}
          </OverviewPanel>
        )}
        {actions && actions.kind === "actions" && (
          <OverviewPanel span={actions.span} icon={actions.icon} tone={3} title={actions.title} note={actions.note} foot={actions.foot} link>
            <ActionGrid actions={actions.rows} />
          </OverviewPanel>
        )}
      </OverviewRow>
    </PartnerReviewsPageShell>
  );
}

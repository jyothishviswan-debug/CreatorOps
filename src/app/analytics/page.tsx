import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { ActionGrid, Checks, ContextBanner, OverviewKpiRow, OverviewPanel, OverviewPanels, OverviewRow, Rankings } from "@/ui/Overview";
import { IngestionExceptionsPanel } from "@/features/analytics/IngestionExceptionsPanel";
import { resolveRequestActor } from "@/server/analytics/http";
import { getAnalyticsOverview } from "@/server/analytics/overview-service";

const TABS = [
  { label: "Overview", href: "/analytics" },
  { label: "Explorer", href: "/analytics/explorer" },
  { label: "Import History", href: "/analytics/import-history" },
];

export default async function AnalyticsOverviewPage() {
  const actor = await resolveRequestActor();
  const result = await getAnalyticsOverview(actor);

  if (!result.ok) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">MEASURE &amp; REVIEW</div>
            <h1>Analytics</h1>
          </div>
        </div>
        <ModuleTabs tabs={TABS} />
        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panelbody">
            <EmptyState title="Access denied" description="You don't have permission to view Analytics data." icon="lock" />
          </div>
        </section>
      </AppShell>
    );
  }

  const { overview: o, canSeeImportCta, coverageNote, ingestionExceptionLinks } = result.data;
  const [rankPanel, attentionPanel, checksPanel, actionsPanel] = o.bottomPanels;

  const chips = ["Authorized scope preview"];
  if (coverageNote) chips.push(coverageNote);

  return (
    <AppShell>
      <div className="ov-page">
        <div className="head">
          <div>
            <div className="eyebrow">{o.eyebrow}</div>
            <h1>{o.title}</h1>
            <p>{o.description}</p>
          </div>
          {canSeeImportCta && (
            <div className="actions">
              <Link href="/imports?module=analytics" className="btn">
                Import data
              </Link>
            </div>
          )}
        </div>

        <ModuleTabs tabs={TABS} />

        <ContextBanner icon="chart" title={o.summary} description="What is happening, what needs attention, and where to act next." chips={chips} />

        <OverviewKpiRow items={o.kpis} />
        <OverviewPanels panels={o.topPanels} />

        {/* Bottom row is composed manually (not via OverviewPanels) so the
            "Ingestion Exceptions" panel can render real navigable rows -
            see IngestionExceptionsPanel.tsx's own comment. The other three
            panels reuse the exact same exported building blocks
            OverviewPanels itself dispatches to, so their chrome/behavior is
            unchanged. */}
        <OverviewRow secondary>
          {rankPanel && rankPanel.kind === "rank" && (
            <OverviewPanel span={rankPanel.span} icon={rankPanel.icon} tone={0} title={rankPanel.title} note={rankPanel.note} foot={rankPanel.foot} link>
              <Rankings rows={rankPanel.rows} />
            </OverviewPanel>
          )}
          {attentionPanel && attentionPanel.kind === "attention" && <IngestionExceptionsPanel span={attentionPanel.span} tone={1} note={attentionPanel.note} foot={attentionPanel.foot} rows={attentionPanel.rows} links={ingestionExceptionLinks} />}
          {checksPanel && checksPanel.kind === "checks" && (
            <OverviewPanel span={checksPanel.span} icon={checksPanel.icon} tone={2} title={checksPanel.title} note={checksPanel.note} foot={checksPanel.foot} link>
              <Checks rows={checksPanel.rows} />
            </OverviewPanel>
          )}
          {actionsPanel && actionsPanel.kind === "actions" && (
            <OverviewPanel span={actionsPanel.span} icon={actionsPanel.icon} tone={3} title={actionsPanel.title} note={actionsPanel.note} foot={actionsPanel.foot} link>
              <ActionGrid actions={actionsPanel.rows} />
            </OverviewPanel>
          )}
        </OverviewRow>
      </div>
    </AppShell>
  );
}

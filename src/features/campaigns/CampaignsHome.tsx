"use client";

import { useEffect, useState } from "react";

import { ActionGrid, Checks, ContextBanner, Events, OverviewKpiRow, OverviewPanel, OverviewPanels, OverviewRow } from "@/ui/Overview";
import type { OverviewPanelData } from "@/features/shared/types";
import type { CampaignDto } from "@/server/campaigns/client-dto";
import type { CampaignListCursor } from "@/server/campaigns/firestore";
import { CampaignsWorkspace } from "./CampaignsWorkspace";
import { ExecutionExceptionsPanel } from "./ExecutionExceptionsPanel";

type ViewKey = "overview" | "workspace";

// Step 9B: the frozen route model has no separate `/campaigns/workspace`
// URL (same as Vendors) - Overview and Workspace live on the SAME
// `/campaigns` route, switched by in-page tab state. Same `.tabsbar`/
// `.tab` visual weight as ModuleTabs, just onClick instead of routing -
// mirrors VendorsHome.tsx exactly, including its own scroll-reset fix
// (switching tabs here is not a real navigation, so scroll position
// would otherwise persist from the previous view without this).
export function CampaignsHome({
  kpis,
  topPanels,
  bottomPanels,
  executionExceptionLinks,
  summary,
  chips,
  initialCampaigns,
  initialNextCursor,
}: {
  kpis: { icon: "brief" | "check" | "link" | "flag" | "alert" | "users"; label: string; value: string; hint: string }[];
  topPanels: OverviewPanelData[];
  bottomPanels: OverviewPanelData[];
  // Step 12C: the "Execution Exceptions" attention panel's real deep-link
  // targets, keyed by its own row title - see this panel's own comment on
  // ExecutionExceptionsPanel.tsx (mirrors Analytics' own
  // ingestionExceptionLinks/IngestionExceptionsPanel.tsx idiom exactly).
  executionExceptionLinks: Record<string, string>;
  summary: string;
  chips: string[];
  initialCampaigns: CampaignDto[];
  initialNextCursor: CampaignListCursor | null;
}) {
  const [view, setView] = useState<ViewKey>("overview");

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);

  return (
    <>
      <div className="tabsbar">
        <div className="tabs">
          <button type="button" className={view === "overview" ? "tab active" : "tab"} aria-current={view === "overview" ? "page" : undefined} onClick={() => setView("overview")}>
            Overview
          </button>
          <button type="button" className={view === "workspace" ? "tab active" : "tab"} aria-current={view === "workspace" ? "page" : undefined} onClick={() => setView("workspace")}>
            Workspace
          </button>
        </div>
        <span className="scope">
          <i className="dot" />
          Authorized scope preview <span style={{ margin: "0 6px" }}>&middot;</span> September 2026
        </span>
      </div>

      {view === "overview" ? (
        <>
          <ContextBanner icon="flag" title="Campaign execution cockpit" description={summary} chips={chips} />
          <OverviewKpiRow items={kpis} />
          <OverviewPanels panels={topPanels} />

          {/* Bottom row is composed manually (not via the shared
              OverviewPanels dispatcher) so the "Execution Exceptions"
              panel can render real navigable rows - see
              ExecutionExceptionsPanel.tsx's own comment. The other three
              panels reuse the exact same exported building blocks
              OverviewPanels itself dispatches to (Checks/Events/
              ActionGrid), so their chrome/behavior is unchanged. Mirrors
              src/app/analytics/page.tsx's own identical composition for
              its "Ingestion Exceptions" panel. */}
          <OverviewRow secondary>
            {bottomPanels.map((panel, i) => {
              if (panel.kind === "checks") {
                return (
                  <OverviewPanel key={panel.title} span={panel.span} icon={panel.icon} tone={i} title={panel.title} note={panel.note} foot={panel.foot} link>
                    <Checks rows={panel.rows} />
                  </OverviewPanel>
                );
              }
              if (panel.kind === "attention") {
                return <ExecutionExceptionsPanel key={panel.title} span={panel.span} tone={i} note={panel.note} foot={panel.foot} rows={panel.rows} links={executionExceptionLinks} />;
              }
              if (panel.kind === "activity") {
                return (
                  <OverviewPanel key={panel.title} span={panel.span} icon={panel.icon} tone={i} title={panel.title} note={panel.note} foot={panel.foot} link>
                    <Events items={panel.rows.map((r) => ({ icon: "clock", title: r.title, detail: r.detail, href: r.href }))} />
                  </OverviewPanel>
                );
              }
              if (panel.kind === "actions") {
                return (
                  <OverviewPanel key={panel.title} span={panel.span} icon={panel.icon} tone={i} title={panel.title} note={panel.note} foot={panel.foot} link>
                    <ActionGrid actions={panel.rows} />
                  </OverviewPanel>
                );
              }
              return null;
            })}
          </OverviewRow>
        </>
      ) : (
        <CampaignsWorkspace initialCampaigns={initialCampaigns} initialNextCursor={initialNextCursor} />
      )}
    </>
  );
}

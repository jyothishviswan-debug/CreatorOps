"use client";

import { useEffect, useState } from "react";

import { ContextBanner, OverviewKpiRow, OverviewPanels } from "@/ui/Overview";
import type { OverviewPanelData } from "@/features/shared/types";
import type { CampaignDto } from "@/server/campaigns/client-dto";
import type { CampaignListCursor } from "@/server/campaigns/firestore";
import { CampaignsWorkspace } from "./CampaignsWorkspace";

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
  summary,
  chips,
  initialCampaigns,
  initialNextCursor,
}: {
  kpis: { icon: "brief" | "check" | "link" | "flag" | "alert" | "users"; label: string; value: string; hint: string }[];
  topPanels: OverviewPanelData[];
  bottomPanels: OverviewPanelData[];
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
          <OverviewPanels panels={bottomPanels} secondary />
        </>
      ) : (
        <CampaignsWorkspace initialCampaigns={initialCampaigns} initialNextCursor={initialNextCursor} />
      )}
    </>
  );
}

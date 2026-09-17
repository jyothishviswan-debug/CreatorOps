"use client";

import { useEffect, useState } from "react";

import { ContextBanner, OverviewKpiRow, OverviewPanels } from "@/ui/Overview";
import type { OverviewPanelData } from "@/features/shared/types";
import type { VendorDto } from "@/server/vendors/client-dto";
import type { VendorListCursor } from "@/server/vendors/firestore";
import { VendorsWorkspace } from "./VendorsWorkspace";

type ViewKey = "overview" | "workspace";

// Step 8B section 2: the frozen route model has no separate
// `/vendors/workspace` URL (unlike Discovery/Partners, which use two
// sibling routes) - Overview and Workspace live on the SAME `/vendors`
// route instead, switched by in-page tab state. Same `.tabsbar`/`.tab`
// visual weight as ModuleTabs (the module-level tab bar every other
// module shows), just onClick instead of routing - a client-state
// variant of the golden master's own original in-page tab design (see
// ModuleTabs.tsx's own comment on why every OTHER module uses real
// routes instead).
export function VendorsHome({
  kpis,
  topPanels,
  bottomPanels,
  summary,
  chips,
  initialVendors,
  initialNextCursor,
}: {
  kpis: { icon: "brief" | "check" | "link" | "flag" | "alert" | "users"; label: string; value: string; hint: string }[];
  topPanels: OverviewPanelData[];
  bottomPanels: OverviewPanelData[];
  summary: string;
  chips: string[];
  initialVendors: VendorDto[];
  initialNextCursor: VendorListCursor | null;
}) {
  const [view, setView] = useState<ViewKey>("overview");

  // Overview <-> Workspace is a client-state toggle, not a real
  // navigation - unlike Discovery's/Partners' own sibling-route tabs
  // (where a route change resets scroll automatically), switching `view`
  // here would otherwise leave the page wherever the visitor had
  // scrolled to on the PREVIOUS view, landing them mid-content instead
  // of at the newly-shown view's own top (its toolbar/filters, or its
  // KPI row). Restores the same "switching tabs starts you at the top"
  // behavior real navigation gives every other module for free.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);

  return (
    <div className="ov-page">
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
          <ContextBanner icon="brief" title="Vendor relationship cockpit" description={summary} chips={chips} />
          <OverviewKpiRow items={kpis} />
          <OverviewPanels panels={topPanels} />
          <OverviewPanels panels={bottomPanels} secondary />
        </>
      ) : (
        <VendorsWorkspace initialVendors={initialVendors} initialNextCursor={initialNextCursor} />
      )}
    </div>
  );
}

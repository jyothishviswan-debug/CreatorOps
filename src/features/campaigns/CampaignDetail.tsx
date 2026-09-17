"use client";

import { useState } from "react";
import Link from "next/link";

import { Panel, PanelBody, PanelGrid, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState } from "@/ui/States";
import type { CampaignDto } from "@/server/campaigns/client-dto";
import { absoluteTime, dateLabel, platformLabel, REVIEW_POLICY_LABELS, STATUS_LABELS, statusTone } from "./format";
import { CampaignHistoryPanel } from "./CampaignHistoryPanel";
import { CampaignLifecyclePanel } from "./CampaignLifecyclePanel";
import { CampaignOwnerTeamPanel } from "./CampaignOwnerTeamPanel";
import { CampaignPlanEditPanel } from "./CampaignPlanEditPanel";
import { CampaignReadinessPanel } from "./CampaignReadinessPanel";
import { CampaignResourcesPanel } from "./CampaignResourcesPanel";

type TabKey = "overview" | "plan" | "resources" | "history";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "plan", label: "Plan" },
  { key: "resources", label: "Resources" },
  { key: "history", label: "History" },
];

export function CampaignDetail({ initialCampaign }: { initialCampaign: CampaignDto }) {
  const [campaign, setCampaign] = useState(initialCampaign);
  const [selectedTab, setSelectedTab] = useState<TabKey>("overview");
  // Bumped on every successful mutation - campaignRef alone never changes
  // across those, so History/Readiness need their own explicit refresh
  // signal (see Vendors' own HistoryPanel comment for why).
  const [refreshKey, setRefreshKey] = useState(0);

  function handleCampaignUpdated(updated: CampaignDto) {
    setCampaign(updated);
    setRefreshKey((k) => k + 1);
  }

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">CAMPAIGNS / RECORD DETAIL</div>
          <h1>{campaign.name}</h1>
          <p>{REVIEW_POLICY_LABELS[campaign.defaultReviewPolicy]}</p>
        </div>
        <div className="actions">
          <Link href="/campaigns" className="btn">
            Back to campaigns
          </Link>
        </div>
      </div>

      <div className="detailcontext">
        <div>
          <small>Status</small>
          <Pill tone={statusTone(campaign.status)}>{STATUS_LABELS[campaign.status]}</Pill>
        </div>
        <div>
          <small>Owner</small>
          <b>{campaign.ownerDisplayName ?? "Unassigned"}</b>
        </div>
        <div>
          <small>Dates</small>
          <b>
            {dateLabel(campaign.startDate)} – {dateLabel(campaign.endDate)}
          </b>
        </div>
        <div>
          <small>Last updated</small>
          <b>{absoluteTime(campaign.updatedAt)}</b>
        </div>
      </div>

      <div className="workflow" role="tablist" aria-label="Campaign sections">
        {TABS.map((tab) => {
          const isCurrent = tab.key === selectedTab;
          return (
            <button key={tab.key} type="button" role="tab" aria-selected={isCurrent} className={`step ${isCurrent ? "current" : ""}`} onClick={() => setSelectedTab(tab.key)}>
              {tab.label}
            </button>
          );
        })}
      </div>

      {selectedTab === "overview" && (
        <>
          <PanelGrid>
            <Panel span={12}>
              <PanelHead title="Overview" description="Plan, ownership and targeting summary - lifecycle truth lives only in the Status pill above." />
              <PanelBody>
                <div className="kv">
                  <span>Objective</span>
                  <span>{campaign.objective}</span>
                </div>
                <div className="kv">
                  <span>Platforms</span>
                  <span>{campaign.platforms.length > 0 ? campaign.platforms.map(platformLabel).join(", ") : "—"}</span>
                </div>
                <div className="kv">
                  <span>Regions</span>
                  <span>{campaign.regionIds.length > 0 ? campaign.regionIds.join(", ") : "—"}</span>
                </div>
                <div className="kv">
                  <span>Target Audience</span>
                  <span>{campaign.criteria.targetAudience ?? "—"}</span>
                </div>
                <div className="kv">
                  <span>Default review policy</span>
                  <span>{REVIEW_POLICY_LABELS[campaign.defaultReviewPolicy]}</span>
                </div>
                <CampaignOwnerTeamPanel campaign={campaign} onSaved={handleCampaignUpdated} />
              </PanelBody>
            </Panel>
          </PanelGrid>
          <PanelGrid>
            <CampaignReadinessPanel campaignRef={campaign.campaignRef} refreshKey={refreshKey} />
          </PanelGrid>
          <PanelGrid>
            <CampaignLifecyclePanel campaign={campaign} onSaved={handleCampaignUpdated} />
          </PanelGrid>
          <PanelGrid>
            <Panel span={12}>
              <PanelHead title="Downstream availability" description="Truthful placeholders only - these domains are not built yet, so nothing here is fabricated." />
              <PanelBody>
                <div className="stategrid">
                  {(["Commercial Agreements", "Assignments", "Content", "Analytics"] as const).map((label) => (
                    <div className="statecard" key={label}>
                      <EmptyState title={label} description="Not yet built - no real trusted source is wired to this Campaign yet." icon="clock" />
                    </div>
                  ))}
                </div>
              </PanelBody>
            </Panel>
          </PanelGrid>
        </>
      )}

      {selectedTab === "plan" && (
        <PanelGrid>
          <Panel span={12}>
            <PanelHead title="Plan" description="Brief and targeting criteria, edited together. Target Audience is the audience-segmentation criterion - Partner tier is never part of Campaign targeting." />
            <PanelBody>
              <div className="kv">
                <span>Objective</span>
                <span>{campaign.objective}</span>
              </div>
              <div className="kv">
                <span>Dates</span>
                <span>
                  {dateLabel(campaign.startDate)} – {dateLabel(campaign.endDate)}
                </span>
              </div>
              <div className="kv">
                <span>Platforms</span>
                <span>{campaign.platforms.length > 0 ? campaign.platforms.map(platformLabel).join(", ") : "—"}</span>
              </div>
              <div className="kv">
                <span>Target Audience</span>
                <span>{campaign.criteria.targetAudience ?? "—"}</span>
              </div>
              <div className="kv">
                <span>Regions</span>
                <span>{campaign.regionIds.length > 0 ? campaign.regionIds.join(", ") : "—"}</span>
              </div>
              <div className="kv">
                <span>Languages</span>
                <span>{campaign.criteria.languageIds.length > 0 ? campaign.criteria.languageIds.join(", ") : "—"}</span>
              </div>
              <div className="kv">
                <span>Categories</span>
                <span>{campaign.criteria.categoryIds.length > 0 ? campaign.criteria.categoryIds.join(", ") : "—"}</span>
              </div>
              <div className="kv">
                <span>Targeting platforms</span>
                <span>{campaign.criteria.platforms.length > 0 ? campaign.criteria.platforms.map(platformLabel).join(", ") : "—"}</span>
              </div>
              <div className="kv">
                <span>Default review policy</span>
                <span>{REVIEW_POLICY_LABELS[campaign.defaultReviewPolicy]}</span>
              </div>
              <CampaignOwnerTeamPanel campaign={campaign} onSaved={handleCampaignUpdated} />
              <div style={{ marginTop: 14 }}>
                <CampaignPlanEditPanel campaign={campaign} onSaved={handleCampaignUpdated} />
              </div>
            </PanelBody>
          </Panel>
        </PanelGrid>
      )}

      {selectedTab === "resources" && (
        <PanelGrid>
          <CampaignResourcesPanel campaign={campaign} onSaved={handleCampaignUpdated} />
        </PanelGrid>
      )}

      {selectedTab === "history" && (
        <PanelGrid>
          <CampaignHistoryPanel campaignRef={campaign.campaignRef} refreshKey={refreshKey} />
        </PanelGrid>
      )}
    </>
  );
}

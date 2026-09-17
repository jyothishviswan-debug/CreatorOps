"use client";

import { useState } from "react";
import Link from "next/link";

import { Panel, PanelBody, PanelGrid, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState } from "@/ui/States";
import type { PartnerDto } from "@/server/partners/client-dto";
import { getPartner } from "./api-client";
import { absoluteTime, STATUS_LABELS, statusTone } from "./format";
import { HistoryPanel } from "./HistoryPanel";
import { PartnerAccountsPanel } from "./PartnerAccountsPanel";
import { PartnerLifecyclePanel } from "./PartnerLifecyclePanel";
import { PartnerOwnerTeamPanel } from "./PartnerOwnerTeamPanel";
import { PartnerRestrictedIdentityPanel } from "./PartnerRestrictedIdentityPanel";

type TabKey = "overview" | "accounts" | "relationships" | "activity" | "restricted" | "context";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "accounts", label: "Accounts" },
  { key: "relationships", label: "Relationships" },
  { key: "activity", label: "Activity" },
  { key: "restricted", label: "Restricted Identity" },
  { key: "context", label: "Context" },
];

export function PartnerDetail({ initialPartner }: { initialPartner: PartnerDto }) {
  const [partner, setPartner] = useState(initialPartner);
  const [selectedTab, setSelectedTab] = useState<TabKey>("overview");
  // Bumped on every successful mutation - partnerRef alone never changes
  // across those, so History needs its own explicit refresh signal (see
  // HistoryPanel's own comment).
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  function handlePartnerUpdated(updated: PartnerDto) {
    setPartner(updated);
    setHistoryRefreshKey((k) => k + 1);
  }

  // Creating/editing a Partner Account can resolve pendingPartnerAccountSetup
  // server-side (see createPartnerAccount) without returning a Partner DTO
  // at all - refetch the Partner itself so the "setup pending" banner
  // clears live, per Step 7B: "after successful real account creation,
  // refresh from server and show pending setup resolved."
  async function handleAccountsChanged() {
    setHistoryRefreshKey((k) => k + 1);
    const result = await getPartner(partner.partnerRef);
    if (result.ok) setPartner(result.data);
  }

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">PARTNERS / RECORD DETAIL</div>
          <h1>{partner.displayName}</h1>
          <p>{partner.targetAudience ?? "Target Audience not yet tagged"}</p>
        </div>
        <div className="actions">
          <Link href="/partners/workspace" className="btn">
            Back to workspace
          </Link>
          <Link href={`/partners/${partner.partnerRef}/edit`} className="btn primary">
            Edit partner
          </Link>
        </div>
      </div>

      <div className="detailcontext">
        <div>
          <small>Status</small>
          <Pill tone={statusTone(partner.status)}>{STATUS_LABELS[partner.status]}</Pill>
        </div>
        <div>
          <small>Owner</small>
          <b>{partner.ownerDisplayName ?? "Unassigned"}</b>
        </div>
        <div>
          <small>Region</small>
          <b>{partner.regionIds[0] ?? "—"}</b>
        </div>
        <div>
          <small>Last updated</small>
          <b>{absoluteTime(partner.updatedAt)}</b>
        </div>
      </div>

      <div className="workflow" role="tablist" aria-label="Partner sections">
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
              <PanelHead title="Overview" description="Profile, ownership and provenance - lifecycle truth lives only in the Status pill above." />
              <PanelBody>
                {partner.pendingPartnerAccountSetup && (
                  <div className="banner" role="status" style={{ marginBottom: 14 }}>
                    <b>Account setup pending.</b> Created by Discovery conversion with no account yet - open the Accounts tab to resolve it.
                  </div>
                )}
                <div className="kv">
                  <span>Target Audience</span>
                  <span>
                    <Pill tone={partner.targetAudience ? "default" : "red"}>{partner.targetAudience ?? "Not yet tagged"}</Pill>
                  </span>
                </div>
                <div className="kv">
                  <span>Legal name</span>
                  <span>{partner.legalName ?? "—"}</span>
                </div>
                <div className="kv">
                  <span>Email</span>
                  <span>{partner.email ?? "—"}</span>
                </div>
                <div className="kv">
                  <span>Phone</span>
                  <span>{partner.phone ?? "—"}</span>
                </div>
                <div className="kv">
                  <span>Regions</span>
                  <span>{partner.regionIds.length > 0 ? partner.regionIds.join(", ") : "—"}</span>
                </div>
                <div className="kv">
                  <span>Languages</span>
                  <span>{partner.languageIds.length > 0 ? partner.languageIds.join(", ") : "—"}</span>
                </div>
                <div className="kv">
                  <span>Categories</span>
                  <span>{partner.categoryIds.length > 0 ? partner.categoryIds.join(", ") : "—"}</span>
                </div>
                <div className="kv">
                  <span>Tier</span>
                  <span>{partner.tier ?? "—"}</span>
                </div>
                <div className="kv">
                  <span>Priority</span>
                  <span>{partner.priority ?? "—"}</span>
                </div>
                <PartnerOwnerTeamPanel partner={partner} onSaved={handlePartnerUpdated} />

                {partner.sourceDiscovery ? (
                  <div className="kv">
                    <span>Discovery provenance</span>
                    <span>
                      From Lead{" "}
                      <Link href={`/discovery/${partner.sourceDiscovery.leadRef}`} className="textlink">
                        {partner.sourceDiscovery.snapshot.displayName}
                      </Link>{" "}
                      · converted {absoluteTime(partner.sourceDiscovery.convertedAt)} · {partner.sourceDiscovery.snapshot.source.type}
                    </span>
                  </div>
                ) : (
                  <div className="kv">
                    <span>Discovery provenance</span>
                    <span>Created directly - no Discovery origin.</span>
                  </div>
                )}
              </PanelBody>
            </Panel>
          </PanelGrid>
          <PanelGrid>
            <PartnerLifecyclePanel partner={partner} onSaved={handlePartnerUpdated} />
          </PanelGrid>
        </>
      )}

      {selectedTab === "accounts" && (
        <PanelGrid>
          <PartnerAccountsPanel partnerRef={partner.partnerRef} pendingSetup={partner.pendingPartnerAccountSetup} onChanged={handleAccountsChanged} />
        </PanelGrid>
      )}

      {selectedTab === "relationships" && (
        <PanelGrid>
          <Panel span={12}>
            <PanelHead title="Relationships" description="Vendors are not implemented yet." />
            <PanelBody>
              <EmptyState title="Vendor relationships will be available in the Vendors phase" description="Nothing is fabricated here - no Vendor records can be created from Partners." icon="brief" />
            </PanelBody>
          </Panel>
        </PanelGrid>
      )}

      {selectedTab === "activity" && (
        <PanelGrid>
          <HistoryPanel partnerRef={partner.partnerRef} refreshKey={historyRefreshKey} />
        </PanelGrid>
      )}

      {selectedTab === "restricted" && (
        <PanelGrid>
          <PartnerRestrictedIdentityPanel partnerRef={partner.partnerRef} />
        </PanelGrid>
      )}

      {selectedTab === "context" && (
        <PanelGrid>
          {(["Campaigns", "Assignments", "Content", "Analytics", "Partner Reviews", "Finance"] as const).map((label) => (
            <Panel span={4} key={label}>
              <PanelHead title={label} />
              <PanelBody>
                <EmptyState title="Not yet available" description={`${label} has no real trusted source wired to Partners yet.`} icon="clock" />
              </PanelBody>
            </Panel>
          ))}
        </PanelGrid>
      )}
    </>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";

import { Panel, PanelBody, PanelGrid, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import type { VendorDto } from "@/server/vendors/client-dto";
import type { CounterpartyAgreementDocumentsDto } from "@/server/finance-agreements/client-dto";
import { absoluteTime, STATUS_LABELS, statusTone, VENDOR_TYPE_LABELS } from "./format";
import { VendorHistoryPanel } from "./VendorHistoryPanel";
import { VendorLifecyclePanel } from "./VendorLifecyclePanel";
import { VendorOwnerTeamPanel } from "./VendorOwnerTeamPanel";
import { VendorPayeeContextPanel } from "./VendorPayeeContextPanel";
import { VendorProfileEditPanel } from "./VendorProfileEditPanel";
import { VendorRelationshipsPanel } from "./VendorRelationshipsPanel";
import { VendorRestrictedIdentityPanel } from "./VendorRestrictedIdentityPanel";

type TabKey = "overview" | "relationships" | "payee" | "restricted" | "history";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "relationships", label: "Partner Relationships" },
  { key: "payee", label: "Payee / Commercial Context" },
  { key: "restricted", label: "Restricted Identity" },
  { key: "history", label: "History" },
];

// `canOpenFinance` is computed by the server page from the actor's own `finance` feature grant; it only decides whether
// the contextual Agreements link (Payee / Commercial Context tab) is RENDERED - the destination re-authorizes.
// `agreementDocuments` (Step 14B.1) is the server projection of this Vendor's signed Agreement documents, passed only to an actor with the Finance feature.
export function VendorDetail({ initialVendor, canOpenFinance = false, agreementDocuments = null }: { initialVendor: VendorDto; canOpenFinance?: boolean; agreementDocuments?: CounterpartyAgreementDocumentsDto | null }) {
  const [vendor, setVendor] = useState(initialVendor);
  const [selectedTab, setSelectedTab] = useState<TabKey>("overview");
  // Bumped on every successful mutation - vendorRef alone never changes
  // across those, so History needs its own explicit refresh signal (see
  // Partners' own HistoryPanel comment for why).
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  function handleVendorUpdated(updated: VendorDto) {
    setVendor(updated);
    setHistoryRefreshKey((k) => k + 1);
  }

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">VENDORS / RECORD DETAIL</div>
          <h1>{vendor.displayName}</h1>
          <p>{VENDOR_TYPE_LABELS[vendor.vendorType]}</p>
        </div>
        <div className="actions">
          <Link href="/vendors" className="btn">
            Back to vendors
          </Link>
        </div>
      </div>

      <div className="detailcontext">
        <div>
          <small>Status</small>
          <Pill tone={statusTone(vendor.status)}>{STATUS_LABELS[vendor.status]}</Pill>
        </div>
        <div>
          <small>Owner</small>
          <b>{vendor.ownerDisplayName ?? "Unassigned"}</b>
        </div>
        <div>
          <small>Region</small>
          <b>{vendor.regionIds[0] ?? "—"}</b>
        </div>
        <div>
          <small>Last updated</small>
          <b>{absoluteTime(vendor.updatedAt)}</b>
        </div>
      </div>

      <div className="workflow" role="tablist" aria-label="Vendor sections">
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
              <PanelHead title="Overview" description="Profile, ownership and relationship summary - lifecycle truth lives only in the Status pill above." />
              <PanelBody>
                <div className="kv">
                  <span>Legal name</span>
                  <span>{vendor.legalName ?? "—"}</span>
                </div>
                <div className="kv">
                  <span>Vendor type</span>
                  <span>{VENDOR_TYPE_LABELS[vendor.vendorType]}</span>
                </div>
                <div className="kv">
                  <span>Email</span>
                  <span>{vendor.email ?? "—"}</span>
                </div>
                <div className="kv">
                  <span>Phone</span>
                  <span>{vendor.phone ?? "—"}</span>
                </div>
                <div className="kv">
                  <span>Regions</span>
                  <span>{vendor.regionIds.length > 0 ? vendor.regionIds.join(", ") : "—"}</span>
                </div>
                <div className="kv">
                  <span>Business references</span>
                  <span>{vendor.businessReferences.length > 0 ? vendor.businessReferences.map((r) => `${r.label}: ${r.value}`).join(" · ") : "—"}</span>
                </div>
                <VendorOwnerTeamPanel vendor={vendor} onSaved={handleVendorUpdated} />
                <div style={{ marginTop: 14 }}>
                  <VendorProfileEditPanel vendor={vendor} onSaved={handleVendorUpdated} />
                </div>
              </PanelBody>
            </Panel>
          </PanelGrid>
          <PanelGrid>
            <VendorLifecyclePanel vendor={vendor} onSaved={handleVendorUpdated} />
          </PanelGrid>
        </>
      )}

      {selectedTab === "relationships" && (
        <PanelGrid>
          <VendorRelationshipsPanel vendorRef={vendor.vendorRef} />
        </PanelGrid>
      )}

      {selectedTab === "payee" && <VendorPayeeContextPanel vendorRef={vendor.vendorRef} canOpenFinance={canOpenFinance} agreementDocuments={agreementDocuments} />}

      {selectedTab === "restricted" && (
        <PanelGrid>
          <VendorRestrictedIdentityPanel vendorRef={vendor.vendorRef} />
        </PanelGrid>
      )}

      {selectedTab === "history" && (
        <PanelGrid>
          <VendorHistoryPanel vendorRef={vendor.vendorRef} refreshKey={historyRefreshKey} />
        </PanelGrid>
      )}
    </>
  );
}

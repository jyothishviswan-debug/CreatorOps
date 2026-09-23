"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { LocalTabs } from "@/ui/LocalTabs";
import type { PayableDetailDto, PayablePermissionsDto, PayableSourceRevisionDto } from "@/server/finance-payables/client-dto";

import { AmountBreakdownTab } from "./AmountBreakdownTab";
import { detailActionVisibility, detailHeaderView, DETAIL_TABS, type DetailTabKey } from "./detail-view";
import { HistoryTab } from "./HistoryTab";
import { LifecycleActions } from "./LifecycleActions";
import { SourceEvidenceTab } from "./SourceEvidenceTab";
import { SummaryTab } from "./SummaryTab";

// Step 15B: /finance/payables/[payableRef] - the main ongoing record screen. Never a wizard after
// creation: real compact tabs (Summary / Amount breakdown / Source evidence / History), not the
// lifecycle-step visual. Header actions (Edit / Ready for invoice / Void) follow the EXACT server-
// computed permission projection for the current lifecycle status - never a role-rank assumption.
export function PayableDetail({ initial, permissions, initialTab, revision }: { initial: PayableDetailDto; permissions: PayablePermissionsDto; initialTab: DetailTabKey; revision: PayableSourceRevisionDto | null }) {
  const router = useRouter();
  const [detail, setDetail] = useState(initial);
  const [tab, setTab] = useState<DetailTabKey>(initialTab);

  const header = detailHeaderView(detail.head);
  const visibility = detailActionVisibility(detail.head, permissions);

  function onUpdated(updated: PayableDetailDto) {
    setDetail(updated);
    router.refresh();
  }

  return (
    <div className="page">
      <div className="head">
        <div>
          <div className="eyebrow">FINANCE / PAYABLES / {detail.head.payableRef}</div>
          <h1>{header.title}</h1>
          <p>{header.secondary}</p>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <span className={header.statusChip.tone === "default" ? "pill" : `pill ${header.statusChip.tone}`}>{header.statusChip.label}</span>
            <span className={header.determinationChip.tone === "default" ? "pill" : `pill ${header.determinationChip.tone}`}>{header.determinationChip.label}</span>
          </div>
        </div>
        <div className="actions">
          <Link href="/finance/payables" className="btn">
            Back to Payables
          </Link>
          <LifecycleActions detail={detail} visibility={visibility} onUpdated={onUpdated} />
        </div>
      </div>

      {visibility.readOnly && (
        <p className="foundationnote" style={{ marginBottom: 14 }}>
          This Payable is void and read-only.
        </p>
      )}
      {detail.head.status === "READY_FOR_INVOICE" && (
        <p className="foundationnote" style={{ marginBottom: 14 }}>
          This version is pinned for invoicing. Invoicing is not yet implemented in CreatorOps.
        </p>
      )}

      <LocalTabs tabs={DETAIL_TABS.map((entry) => ({ key: entry.key, label: entry.label }))} active={tab} onChange={(key) => setTab(key as DetailTabKey)} />

      {tab === "summary" && <SummaryTab detail={detail} revision={revision} />}
      {tab === "breakdown" && <AmountBreakdownTab detail={detail} permissions={permissions} onUpdated={onUpdated} />}
      {tab === "source" && <SourceEvidenceTab detail={detail} />}
      {tab === "history" && <HistoryTab payableRef={detail.head.payableRef} />}
    </div>
  );
}

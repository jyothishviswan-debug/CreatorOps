"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Pill } from "@/ui/Badge";
import { LocalTabs } from "@/ui/LocalTabs";
import type { InvoiceDetailDto, InvoicePermissionsDto } from "@/server/finance-invoices/client-dto";
import type { InvoiceSourceRevisionDto } from "@/server/finance-invoices/invoice-lifecycle-service";

import { DocumentTab } from "./DocumentTab";
import { detailActionVisibility, detailHeaderView, DETAIL_TABS, type DetailTabKey } from "./detail-view";
import { EditDraftPanel } from "./EditDraftPanel";
import { HistoryTab } from "./HistoryTab";
import { LifecycleActions } from "./LifecycleActions";
import { ReconciliationTab } from "./ReconciliationTab";
import { SummaryTab } from "./SummaryTab";

// Step 16B: /finance/invoices/[invoiceRef] - the main ongoing record screen. Never the create
// wizard after creation: real compact tabs (Summary / Reconciliation / Document / History), not the
// lifecycle-step visual. Header actions (Edit / Submit / Approve / Reject / Reopen / Void) follow
// the EXACT server-computed permission projection for the current lifecycle status - never a
// role-rank assumption.
export function InvoiceDetail({ initial, permissions, initialTab, revision }: { initial: InvoiceDetailDto; permissions: InvoicePermissionsDto; initialTab: DetailTabKey; revision: InvoiceSourceRevisionDto | null }) {
  const router = useRouter();
  const [detail, setDetail] = useState(initial);
  const [tab, setTab] = useState<DetailTabKey>(initialTab);
  const [editing, setEditing] = useState(false);

  const header = detailHeaderView(detail.head);
  const visibility = detailActionVisibility(detail.head, permissions);

  function onUpdated(updated: InvoiceDetailDto) {
    setDetail(updated);
    router.refresh();
  }

  function onDraftSaved(updated: InvoiceDetailDto) {
    onUpdated(updated);
    setEditing(false);
  }

  return (
    <div className="page">
      <div className="head">
        <div>
          <div className="eyebrow">FINANCE / INVOICES / {detail.head.invoiceRef}</div>
          <h1>{header.title}</h1>
          <p>{header.secondary}</p>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <Pill tone={header.statusChip.tone}>{header.statusChip.label}</Pill>
            <Pill tone={header.reconciliationChip.tone}>{header.reconciliationChip.label}</Pill>
          </div>
        </div>
        <div className="actions">
          <Link href="/finance/invoices" className="btn">
            Back to Invoices
          </Link>
          {visibility.canEdit && !editing && (
            <button type="button" className="btn" onClick={() => setEditing(true)} data-testid="edit-action">
              Edit
            </button>
          )}
          <LifecycleActions detail={detail} visibility={visibility} onUpdated={onUpdated} />
        </div>
      </div>

      {visibility.readOnly && detail.head.status === "VOID" && (
        <p className="foundationnote" style={{ marginBottom: 14 }}>
          This Invoice is void and read-only.
        </p>
      )}
      {detail.head.status === "APPROVED" && (
        <p className="foundationnote" style={{ marginBottom: 14 }}>
          Approved Invoice is ready for the Payments module.
        </p>
      )}
      {detail.head.status === "SUBMITTED" && !visibility.canApprove && (
        <p className="foundationnote" style={{ marginBottom: 14 }}>
          This Invoice is submitted and awaiting approval. It is read-only until approved, rejected or reopened.
        </p>
      )}

      {editing ? (
        <EditDraftPanel detail={detail} onUpdated={onDraftSaved} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <LocalTabs tabs={DETAIL_TABS.map((entry) => ({ key: entry.key, label: entry.label }))} active={tab} onChange={(key) => setTab(key as DetailTabKey)} />

          {tab === "summary" && <SummaryTab detail={detail} revision={revision} />}
          {tab === "reconciliation" && <ReconciliationTab detail={detail} visibility={visibility} onUpdated={onUpdated} />}
          {tab === "document" && <DocumentTab detail={detail} visibility={visibility} onUpdated={onUpdated} />}
          {tab === "history" && <HistoryTab invoiceRef={detail.head.invoiceRef} />}
        </>
      )}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Pill } from "@/ui/Badge";
import { LocalTabs } from "@/ui/LocalTabs";
import type { PaymentDetailDto, PaymentPermissionsDto } from "@/server/finance-payments/client-dto";

import { getInvoiceForPayment } from "../api-client";
import { detailActionVisibility, detailHeaderView, paymentSourceRevisionState, DETAIL_TABS, type DetailTabKey } from "./detail-view";
import { HistoryTab } from "./HistoryTab";
import { LifecycleActions } from "./LifecycleActions";
import { SettlementTab } from "./SettlementTab";
import { SourceInvoiceTab } from "./SourceInvoiceTab";
import { SummaryTab } from "./SummaryTab";

// Step 17B: /finance/payments/[paymentRef] - the main ongoing record screen. Compact tabs (Summary /
// Settlement / Source Invoice / History), never the lifecycle-step visual. Header actions (Record /
// Confirm / Mark Failed / Reopen / Void) follow the EXACT server-computed permission projection for
// the current lifecycle status - never a role-rank assumption.
export function PaymentDetail({ initial, permissions, initialTab }: { initial: PaymentDetailDto; permissions: PaymentPermissionsDto; initialTab: DetailTabKey }) {
  const router = useRouter();
  const [detail, setDetail] = useState(initial);
  const [tab, setTab] = useState<DetailTabKey>(initialTab);
  const [revisionState, setRevisionState] = useState<string | null>(null);

  const header = detailHeaderView(detail.head);
  const visibility = detailActionVisibility(detail.head, permissions);

  useEffect(() => {
    const pinnedVersion = detail.selectedVersion?.invoicePin.invoiceVersion;
    if (pinnedVersion === undefined) return;
    const controller = new AbortController();
    void getInvoiceForPayment(detail.head.invoiceRef, { signal: controller.signal }).then((result) => {
      if (!result.ok) return;
      setRevisionState(paymentSourceRevisionState(pinnedVersion, result.data.head.latestVersion));
    });
    return () => controller.abort();
  }, [detail.head.invoiceRef, detail.selectedVersion?.invoicePin.invoiceVersion]);

  function onUpdated(updated: PaymentDetailDto) {
    setDetail(updated);
    router.refresh();
  }

  return (
    <div className="page">
      <div className="head">
        <div>
          <div className="eyebrow">FINANCE / PAYMENTS / {detail.head.paymentRef}</div>
          <h1>{header.title}</h1>
          <p>{header.secondary}</p>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <Pill tone={header.statusChip.tone}>{header.statusChip.label}</Pill>
          </div>
        </div>
        <div className="actions">
          <Link href="/finance/payments" className="btn">
            Back to Payments
          </Link>
          <LifecycleActions detail={detail} visibility={visibility} canOverrideOverage={permissions.canOverrideOverage} onUpdated={onUpdated} />
        </div>
      </div>

      {detail.head.status === "VOID" && (
        <p className="foundationnote" style={{ marginBottom: 14 }}>
          This Payment is void and read-only.
        </p>
      )}
      {detail.head.status === "RECORDED" && (
        <p className="foundationnote" style={{ marginBottom: 14 }}>
          This Payment is recorded but not yet confirmed. It is not counted as settled until confirmed.
        </p>
      )}

      <LocalTabs tabs={DETAIL_TABS.map((entry) => ({ key: entry.key, label: entry.label }))} active={tab} onChange={(key) => setTab(key as DetailTabKey)} />

      {tab === "summary" && <SummaryTab detail={detail} revisionState={revisionState} />}
      {tab === "settlement" && <SettlementTab detail={detail} />}
      {tab === "source" && <SourceInvoiceTab detail={detail} />}
      {tab === "history" && <HistoryTab paymentRef={detail.head.paymentRef} />}
    </div>
  );
}

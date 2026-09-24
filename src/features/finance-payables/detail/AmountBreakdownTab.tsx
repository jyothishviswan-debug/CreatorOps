"use client";

import { useState } from "react";

import type { PayableDetailDto, PayablePermissionsDto } from "@/server/finance-payables/client-dto";
import type { PayableReviewCode } from "@/server/finance-payables/types";

import { addPayableAdjustment, confirmPayableTax, removePayableAdjustment } from "../api-client";
import { lineSourceLabel } from "../format";
import { ConfirmGstDialog, type ConfirmGstInput } from "../create/ConfirmGstDialog";
import { ManualAdjustmentDialog, type ManualAdjustmentInput } from "../create/ManualAdjustmentDialog";
import { breakdownRows, breakdownTotalText, calculationSummaryRows } from "../create/create-view";

// Step 15B: Payable detail - Amount breakdown tab. Shows the FULL immutable current-version breakdown.
// If DRAFT and authorized (`canAdjust`), a controlled "Add manual adjustment" action and a per-manual-row
// "Remove" action are offered - never inline-editing an immutable historical version (this tab only ever
// shows the LATEST/selected version; a removed line just no longer appears on the NEXT version).
export function AmountBreakdownTab({ detail, permissions, onUpdated }: { detail: PayableDetailDto; permissions: PayablePermissionsDto; onUpdated: (updated: PayableDetailDto) => void }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busyLineRef, setBusyLineRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gstDialogOpen, setGstDialogOpen] = useState(false);
  const [gstBusy, setGstBusy] = useState(false);

  const version = detail.selectedVersion;
  const isDraft = detail.head.status === "DRAFT";
  const isLatest = version !== null && version.version === detail.head.latestVersion;
  const canEditBreakdown = isDraft && isLatest && permissions.canAdjust;
  const canConfirmGst = canEditBreakdown && version?.snapshot.sourceType === "PARTNER_REVIEW";

  const currency = detail.head.currency;
  const rows = version ? breakdownRows({ lines: version.lines, unresolved: version.unresolved, currency, amountsVisible: detail.amountsVisible }) : [];
  // GST_APPLICABILITY_UNCONFIRMED is resolved ONLY by the dedicated "Confirm GST" dialog below.
  const resolvableItems: Array<{ code: PayableReviewCode; message: string }> = version
    ? version.unresolved.filter((item) => item.code !== "GST_APPLICABILITY_UNCONFIRMED").map((item) => ({ code: item.code, message: item.message }))
    : [];
  // Step 15C section 17/22: service base / GST / gross Invoice / TDS / net payment, kept clearly
  // separate from the raw line list above - backend-authoritative, never recomputed here.
  const calculationRows = calculationSummaryRows({
    snapshot: version?.snapshot ?? null,
    totals: version
      ? { serviceBaseMinor: version.serviceBaseMinor, gstMinor: version.gstMinor, grossInvoiceExpectedMinor: version.grossInvoiceExpectedMinor, tdsMinor: version.tdsMinor, expectedNetPaymentMinor: version.expectedNetPaymentMinor }
      : { serviceBaseMinor: null, gstMinor: null, grossInvoiceExpectedMinor: null, tdsMinor: null, expectedNetPaymentMinor: null },
    currency,
    amountsVisible: detail.amountsVisible,
  });

  async function submitAdjustment(input: ManualAdjustmentInput): Promise<{ ok: boolean; message?: string }> {
    const result = await addPayableAdjustment(detail.head.payableRef, { expectedDocVersion: detail.head.docVersion, ...input });
    if (!result.ok) return { ok: false, message: result.message };
    onUpdated(result.data);
    return { ok: true };
  }

  async function submitGstConfirmation(input: ConfirmGstInput): Promise<{ ok: boolean; message?: string }> {
    setGstBusy(true);
    try {
      const result = await confirmPayableTax(detail.head.payableRef, { expectedDocVersion: detail.head.docVersion, ...input });
      if (!result.ok) return { ok: false, message: result.message };
      onUpdated(result.data);
      return { ok: true };
    } finally {
      setGstBusy(false);
    }
  }

  async function removeLine(lineRef: string) {
    const reason = window.prompt("Reason for removing this adjustment (required):");
    if (!reason || reason.trim().length < 3) return;
    setBusyLineRef(lineRef);
    setError(null);
    const result = await removePayableAdjustment(detail.head.payableRef, { expectedDocVersion: detail.head.docVersion, lineRef, reason: reason.trim() });
    setBusyLineRef(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onUpdated(result.data);
  }

  return (
    <section className="panel">
      <div className="panelhead">
        <div>
          <h2>Amount breakdown</h2>
          <p>Full current-version breakdown, version {version?.version ?? "—"}</p>
        </div>
      </div>
      <div className="panelbody">
        {error && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}

        <div className="tablewrap" style={{ marginBottom: 18 }}>
          <table className="compact" data-testid="calculation-summary">
            <tbody>
              {calculationRows.map((row) => (
                <tr key={row.label} data-testid="calculation-summary-row">
                  <th scope="row" style={{ fontWeight: 400, color: "var(--muted)" }}>
                    {row.label}
                  </th>
                  <td style={{ textAlign: "right" }}>
                    <b>{row.value}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="tablewrap">
          <table className="compact">
            <thead>
              <tr>
                <th scope="col">Component</th>
                <th scope="col">Category</th>
                <th scope="col">Basis / reason</th>
                <th scope="col">Amount</th>
                <th scope="col">Source</th>
                <th scope="col">Actor</th>
                <th scope="col">Status</th>
                {canEditBreakdown && (
                  <th scope="col">
                    <span className="sr">Action</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} data-testid={row.kind === "line" ? "breakdown-line" : "breakdown-unresolved"}>
                  <td>{row.component}</td>
                  <td>{row.kind === "line" && row.manual ? "Manual adjustment" : row.component}</td>
                  <td style={{ whiteSpace: "normal", maxWidth: 300 }}>{row.basis}</td>
                  <td>{row.amountText}</td>
                  <td style={{ whiteSpace: "normal" }}>{row.source}</td>
                  <td>{row.kind === "line" && row.manual ? lineSourceLabel("MANUAL") : "—"}</td>
                  <td>
                    <span className={row.status.tone === "default" ? "pill" : `pill ${row.status.tone}`}>{row.status.label}</span>
                  </td>
                  {canEditBreakdown && (
                    <td>
                      {row.kind === "line" && row.manual && (
                        <button type="button" className="btn ghost" disabled={busyLineRef === row.lineRef} onClick={() => void removeLine(row.lineRef)}>
                          Remove
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>
                  <b>Total</b>
                </td>
                <td colSpan={canEditBreakdown ? 6 : 5} />
                <td>
                  <b>{breakdownTotalText(version?.totalAmountMinorSigned ?? null, currency, detail.amountsVisible)}</b>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {(canEditBreakdown || canConfirmGst) && (
          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            {canEditBreakdown && (
              <button type="button" className="btn" onClick={() => setDialogOpen(true)}>
                Add manual adjustment
              </button>
            )}
            {canConfirmGst && (
              <button type="button" className="btn" onClick={() => setGstDialogOpen(true)}>
                Confirm GST
              </button>
            )}
          </div>
        )}
      </div>

      <ManualAdjustmentDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onSubmit={submitAdjustment} resolvableItems={resolvableItems} />
      <ConfirmGstDialog
        open={gstDialogOpen}
        onClose={() => setGstDialogOpen(false)}
        onSubmit={submitGstConfirmation}
        currentApplicable={version?.snapshot.tax.gstApplicable ?? null}
        currentRateBps={version?.snapshot.tax.gstRateBps ?? null}
        busy={gstBusy}
      />
    </section>
  );
}

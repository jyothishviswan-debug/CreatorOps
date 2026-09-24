"use client";

import { useState } from "react";

import type { PayableDetailDto, PayableSourcePreviewDto } from "@/server/finance-payables/client-dto";
import type { PayableReviewCode } from "@/server/finance-payables/types";

import { addPayableAdjustment, confirmPayableTax } from "../api-client";
import { commercialPeriodLabel, determinationChip } from "../format";
import { agreementEvidenceSection, breakdownRows, breakdownTotalText, calculationSummaryRows, performanceTargetsSection, reviewEvidenceSection, warningsList, type BreakdownRowView } from "./create-view";
import { ConfirmGstDialog, type ConfirmGstInput } from "./ConfirmGstDialog";
import { ManualAdjustmentDialog, type ManualAdjustmentInput } from "./ManualAdjustmentDialog";

// Step 15B: Create Payable - Stage 2 (Review amount), the primary operational screen. 8/12 left (amount
// breakdown), 4/12 right (source evidence). Before any manual adjustment is added the breakdown is the
// live PREVIEW (read-only, nothing persisted yet); once a Payable exists (because an adjustment was
// added) the breakdown reflects that Payable's actual latest immutable version instead.
export function ReviewAmountStep({
  preview,
  payable,
  onEnsurePayable,
  onAdjustmentApplied,
  creating,
  createError,
  canAdjust,
  amountsVisible,
}: {
  preview: PayableSourcePreviewDto;
  payable: PayableDetailDto | null;
  onEnsurePayable: () => Promise<PayableDetailDto | null>;
  onAdjustmentApplied: (updated: PayableDetailDto) => void;
  creating: boolean;
  createError: string | null;
  canAdjust: boolean;
  amountsVisible: boolean;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [adjustBusy, setAdjustBusy] = useState(false);
  const [gstDialogOpen, setGstDialogOpen] = useState(false);
  const [gstBusy, setGstBusy] = useState(false);

  const currency = preview.currency ?? payable?.head.currency ?? "INR";
  const selectedVersion = payable?.selectedVersion ?? null;
  const rows: BreakdownRowView[] = selectedVersion
    ? breakdownRows({ lines: selectedVersion.lines, unresolved: selectedVersion.unresolved, currency, amountsVisible })
    : breakdownRows({ lines: preview.lines, unresolved: preview.unresolved, currency, amountsVisible });
  const total = selectedVersion ? selectedVersion.totalAmountMinorSigned : preview.totalAmountMinorSigned;
  const determinationState = selectedVersion ? selectedVersion.determinationState : preview.determinationState;
  // GST_APPLICABILITY_UNCONFIRMED is resolved ONLY by the dedicated "Confirm GST" dialog below (it
  // writes the typed tax fields, not an arbitrary line) - never offered as a generic manual-adjustment
  // resolution target.
  const resolvableItems: Array<{ code: PayableReviewCode; message: string }> = (selectedVersion ? selectedVersion.unresolved : preview.unresolved)
    .filter((item) => item.code !== "GST_APPLICABILITY_UNCONFIRMED")
    .map((item) => ({ code: item.code, message: item.message }));
  const snapshotForTax = selectedVersion?.snapshot ?? preview.snapshot;
  const canConfirmGst = canAdjust && snapshotForTax?.sourceType === "PARTNER_REVIEW";

  // Step 15C: the calculation chain, backend-authoritative - every figure comes straight from the
  // selected version (once one exists) or the live preview, never recomputed here.
  const calculationRows = calculationSummaryRows({
    snapshot: preview.snapshot,
    totals: selectedVersion
      ? {
          serviceBaseMinor: selectedVersion.serviceBaseMinor,
          gstMinor: selectedVersion.gstMinor,
          grossInvoiceExpectedMinor: selectedVersion.grossInvoiceExpectedMinor,
          tdsMinor: selectedVersion.tdsMinor,
          expectedNetPaymentMinor: selectedVersion.expectedNetPaymentMinor,
        }
      : { serviceBaseMinor: preview.serviceBaseMinor, gstMinor: preview.gstMinor, grossInvoiceExpectedMinor: preview.grossInvoiceExpectedMinor, tdsMinor: preview.tdsMinor, expectedNetPaymentMinor: preview.expectedNetPaymentMinor },
    currency,
    amountsVisible,
  });

  async function submitAdjustment(input: ManualAdjustmentInput): Promise<{ ok: boolean; message?: string }> {
    setAdjustBusy(true);
    try {
      const target = await onEnsurePayable();
      if (!target) return { ok: false, message: createError ?? "Could not create the Payable yet." };
      const result = await addPayableAdjustment(target.head.payableRef, { expectedDocVersion: target.head.docVersion, ...input });
      if (!result.ok) return { ok: false, message: result.message };
      onAdjustmentApplied(result.data);
      return { ok: true };
    } finally {
      setAdjustBusy(false);
    }
  }

  async function submitGstConfirmation(input: ConfirmGstInput): Promise<{ ok: boolean; message?: string }> {
    setGstBusy(true);
    try {
      const target = await onEnsurePayable();
      if (!target) return { ok: false, message: createError ?? "Could not create the Payable yet." };
      const result = await confirmPayableTax(target.head.payableRef, { expectedDocVersion: target.head.docVersion, ...input });
      if (!result.ok) return { ok: false, message: result.message };
      onAdjustmentApplied(result.data);
      return { ok: true };
    } finally {
      setGstBusy(false);
    }
  }

  const agreementSection = preview.snapshot ? agreementEvidenceSection(preview.snapshot) : null;
  const reviewSection = preview.snapshot ? reviewEvidenceSection(preview.snapshot) : null;
  const targetsSection = preview.snapshot ? performanceTargetsSection(preview.snapshot) : null;
  const warnings = preview.snapshot ? warningsList(preview.snapshot) : [];

  return (
    <div className="grid">
      <section className="panel s8">
        <div className="panelhead">
          <div>
            <h2>Amount breakdown</h2>
            <p>Determination and Finance review decisions</p>
          </div>
        </div>
        <div className="panelbody">
          <div className="detailcontext" style={{ marginBottom: 18 }}>
            <div>
              <small>Counterparty</small>
              <b>{preview.counterparty.displayName ?? preview.counterparty.ref}</b>
            </div>
            <div>
              <small>Commercial period</small>
              <b>{commercialPeriodLabel(preview.commercialPeriod.periodKey)}</b>
            </div>
            <div>
              <small>Determination</small>
              <b>{determinationChip(determinationState).label}</b>
            </div>
            <div>
              <small>Current total</small>
              <b>{breakdownTotalText(total, currency, amountsVisible)}</b>
            </div>
          </div>

          {payable && (
            <p className="foundationnote" style={{ marginBottom: 12 }}>
              Payable {payable.head.payableRef} created as Draft (version {payable.head.latestVersion}).
            </p>
          )}
          {createError && (
            <div className="banner" role="alert" style={{ marginBottom: 12 }}>
              {createError}
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
                  <th scope="col">Basis</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Source</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} data-testid={row.kind === "line" ? "breakdown-line" : "breakdown-unresolved"}>
                    <td>{row.component}</td>
                    <td style={{ whiteSpace: "normal", maxWidth: 320 }}>{row.basis}</td>
                    <td>{row.amountText}</td>
                    <td style={{ whiteSpace: "normal" }}>{row.source}</td>
                    <td>
                      <span className={row.status.tone === "default" ? "pill" : `pill ${row.status.tone}`}>{row.status.label}</span>
                    </td>
                    <td />
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No breakdown lines yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {(canAdjust || canConfirmGst) && (
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              {canAdjust && (
                <button type="button" className="btn" onClick={() => setDialogOpen(true)} disabled={creating}>
                  Add manual adjustment
                </button>
              )}
              {canConfirmGst && (
                <button type="button" className="btn" onClick={() => setGstDialogOpen(true)} disabled={creating}>
                  Confirm GST
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="panel s4">
        <div className="panelhead">
          <div>
            <h2>Source evidence</h2>
            <p>Agreement · Review · obligations</p>
          </div>
        </div>
        <div className="panelbody">
          {agreementSection && (
            <>
              <h3 style={{ marginBottom: 8 }}>{agreementSection.title}</h3>
              {agreementSection.rows.map((row) => (
                <div className="kv" key={row.label}>
                  <span>{row.label}</span>
                  <b>{row.value}</b>
                </div>
              ))}
            </>
          )}
          {reviewSection && (
            <>
              <h3 style={{ margin: "16px 0 8px" }}>{reviewSection.title}</h3>
              {reviewSection.rows.map((row) => (
                <div className="kv" key={row.label}>
                  <span>{row.label}</span>
                  <b>{row.value}</b>
                </div>
              ))}
            </>
          )}
          {targetsSection && (
            <>
              <h3 style={{ margin: "16px 0 8px" }}>{targetsSection.title}</h3>
              {targetsSection.rows.map((row) => (
                <div className="kv" key={row.label}>
                  <span>{row.label}</span>
                  <b>{row.value}</b>
                </div>
              ))}
            </>
          )}
          {warnings.length > 0 && (
            <>
              <h3 style={{ margin: "16px 0 8px" }}>Warnings</h3>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: "var(--muted)" }}>
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>

      <ManualAdjustmentDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onSubmit={submitAdjustment} resolvableItems={resolvableItems} busy={adjustBusy} />
      <ConfirmGstDialog
        open={gstDialogOpen}
        onClose={() => setGstDialogOpen(false)}
        onSubmit={submitGstConfirmation}
        currentApplicable={snapshotForTax?.tax.gstApplicable ?? null}
        currentRateBps={snapshotForTax?.tax.gstRateBps ?? null}
        busy={gstBusy}
      />
    </div>
  );
}

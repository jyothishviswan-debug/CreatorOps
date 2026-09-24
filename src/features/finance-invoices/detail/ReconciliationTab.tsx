"use client";

import { useState } from "react";

import { Pill } from "@/ui/Badge";
import { DialogShell } from "@/ui/Dialog";
import type { InvoiceDetailDto } from "@/server/finance-invoices/client-dto";

import { acceptInvoiceMismatch, resolveInvoicePayeeMismatch } from "../api-client";
import { formatSignedMoneyMinor } from "../format";
import { arithmeticWarning, hasMismatchFinding, payeeIdentityNeedsResolution, payeeIdentityOverallRow, payeeIdentityRows, reconciliationComparisonRows, reconciliationReadinessRows } from "../reconciliation-view";
import type { DetailActionVisibility } from "./detail-view";

const READINESS_LABEL: Record<"ready" | "needs_review" | "blocked", string> = { ready: "Ready", needs_review: "Needs review", blocked: "Blocked" };
const READINESS_TONE: Record<"ready" | "needs_review" | "blocked", "default" | "orange" | "red"> = { ready: "default", needs_review: "orange", blocked: "red" };

// Step 16B section 13/16: the full reconciliation comparison, plus (SUBMITTED + authorized only)
// the "Accept mismatch" action - the only place in the whole Invoice UI a mismatch override can be
// applied (never during Create, since the backend only accepts one on a SUBMITTED Invoice). Both
// figures stay visible before and after acceptance; nothing here rewrites either amount.
export function ReconciliationTab({ detail, visibility, onUpdated }: { detail: InvoiceDetailDto; visibility: DetailActionVisibility; onUpdated: (updated: InvoiceDetailDto) => void }) {
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [payeeOverrideOpen, setPayeeOverrideOpen] = useState(false);
  const { head, selectedVersion } = detail;
  if (!selectedVersion) return null;

  const declaredTaxTotal = selectedVersion.taxLines.reduce<number | null>((sum, line) => (sum === null || line.amountMinor === null ? null : sum + line.amountMinor), selectedVersion.taxLines.length > 0 ? 0 : null);
  const rows = reconciliationComparisonRows({
    pin: selectedVersion.payablePin,
    declared: {
      currency: selectedVersion.currency,
      declaredTotalMinor: selectedVersion.declaredTotalMinor,
      externalInvoiceNumber: selectedVersion.externalInvoiceNumber,
      subtotalMinor: selectedVersion.subtotalMinor,
      taxTotalMinor: declaredTaxTotal,
    },
    reconciliation: selectedVersion.reconciliation,
    documentPresent: selectedVersion.document !== null,
    amountsVisible: detail.amountsVisible,
  });
  const mismatchAcceptedForThisVersion = head.mismatchOverride?.forVersion === selectedVersion.version;
  const readiness = reconciliationReadinessRows({
    declared: { currency: selectedVersion.currency, declaredTotalMinor: selectedVersion.declaredTotalMinor, externalInvoiceNumber: selectedVersion.externalInvoiceNumber },
    documentPresent: selectedVersion.document !== null,
    reconciliation: selectedVersion.reconciliation,
    mismatchAcceptedForThisVersion,
  });
  const warning = arithmeticWarning(selectedVersion.reconciliation);
  const mismatchPresent = hasMismatchFinding(selectedVersion.reconciliation);
  const canOfferOverride = visibility.canOverrideMismatch && head.status === "SUBMITTED" && mismatchPresent && !mismatchAcceptedForThisVersion;

  // Step 16C section 14/16: compact "Payee identity" section - the full field-by-field comparison,
  // never a redesign of this screen. Only offered for resolution on a SUBMITTED invoice, mirroring
  // the amount mismatch override's own lifecycle gate.
  const payeeIdentity = selectedVersion.payeeIdentity;
  const payeeRows = payeeIdentity ? payeeIdentityRows(payeeIdentity) : [];
  const payeeOverall = payeeIdentity ? payeeIdentityOverallRow(payeeIdentity) : null;
  const payeeNeedsResolution = payeeIdentity ? payeeIdentityNeedsResolution(payeeIdentity) : false;
  const canOfferPayeeResolution = visibility.canResolvePayeeMismatch && head.status === "SUBMITTED" && payeeNeedsResolution;

  return (
    <div className="grid">
      <section className="panel s8">
        <div className="panelhead">
          <div>
            <h2>Reconciliation</h2>
          </div>
        </div>
        <div className="panelbody">
          {warning && (
            <div className="banner" role="alert" style={{ marginBottom: 14 }} data-testid="arithmetic-warning">
              <b>Arithmetic inconsistency:</b> {warning}
            </div>
          )}

          {mismatchPresent && (
            <div className="banner" role={mismatchAcceptedForThisVersion ? "status" : "alert"} style={{ marginBottom: 14 }} data-testid="mismatch-banner">
              {mismatchAcceptedForThisVersion ? (
                <span>
                  <b>Accepted with reason.</b> {head.mismatchOverride?.reason}
                </span>
              ) : canOfferOverride ? (
                <span>
                  <b>Amount mismatch.</b> This Invoice&apos;s declared total does not match the pinned Payable&apos;s gross expected Invoice total.{" "}
                  <button type="button" className="btn" onClick={() => setOverrideOpen(true)} data-testid="accept-mismatch-action">
                    Accept mismatch
                  </button>
                </span>
              ) : head.status === "SUBMITTED" ? (
                <b>Requires Partnership Head or Super Admin review.</b>
              ) : (
                <span>
                  <b>Amount mismatch</b> against the pinned Payable. Both figures are preserved.
                </span>
              )}
            </div>
          )}

          <div className="tablewrap">
            <table className="compact">
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Payable</th>
                  <th scope="col">Invoice</th>
                  <th scope="col">Result</th>
                  <th scope="col">Resolution</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} data-testid={`reconciliation-row-${row.key}`}>
                    <td>{row.field}</td>
                    <td>{row.payableValue}</td>
                    <td>{row.invoiceValue}</td>
                    <td>
                      <Pill tone={row.result.tone}>{row.result.label}</Pill>
                    </td>
                    <td style={{ whiteSpace: "normal" }}>{row.resolution}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="panel s4">
        <div className="panelhead">
          <div>
            <h2>Readiness</h2>
          </div>
        </div>
        <div className="panelbody">
          <ul className="checklist">
            {readiness.map((item) => (
              <li key={item.label}>
                <Pill tone={READINESS_TONE[item.state]}>{READINESS_LABEL[item.state]}</Pill>
                <span>{item.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {payeeIdentity && payeeOverall && (
        <section className="panel s12" data-testid="payee-identity-section">
          <div className="panelhead">
            <div>
              <h2>Payee identity</h2>
            </div>
          </div>
          <div className="panelbody">
            {payeeOverall.accepted ? (
              <div className="banner" role="status" style={{ marginBottom: 14 }} data-testid="payee-mismatch-accepted-banner">
                <span>
                  <b>Accepted with reason.</b> {payeeOverall.accepted.reason}
                </span>
              </div>
            ) : payeeNeedsResolution ? (
              <div className="banner" role="alert" style={{ marginBottom: 14 }} data-testid="payee-mismatch-banner">
                {canOfferPayeeResolution ? (
                  <span>
                    <b>Payee identity needs review.</b> This Invoice&apos;s payee evidence does not clearly match the expected counterparty.{" "}
                    <button type="button" className="btn" onClick={() => setPayeeOverrideOpen(true)} data-testid="resolve-payee-mismatch-action">
                      Resolve payee mismatch
                    </button>
                  </span>
                ) : (
                  <b>Requires Partnership Head or Super Admin review.</b>
                )}
              </div>
            ) : null}

            <div className="tablewrap">
              <table className="compact">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Expected</th>
                    <th scope="col">Invoice</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {payeeRows.map((row) => (
                    <tr key={row.key} data-testid={`payee-identity-row-${row.key}`}>
                      <td>{row.field}</td>
                      <td>{row.expected}</td>
                      <td>{row.extracted}</td>
                      <td>
                        <Pill tone={row.result.tone}>{row.result.label}</Pill>
                      </td>
                    </tr>
                  ))}
                  <tr data-testid="payee-identity-row-overall">
                    <td>
                      <b>Overall</b>
                    </td>
                    <td>—</td>
                    <td>—</td>
                    <td>
                      <Pill tone={payeeOverall.result.tone}>{payeeOverall.result.label}</Pill>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      <MismatchOverrideDialog open={overrideOpen} detail={detail} onClose={() => setOverrideOpen(false)} onUpdated={onUpdated} />
      <PayeeMismatchResolveDialog open={payeeOverrideOpen} detail={detail} onClose={() => setPayeeOverrideOpen(false)} onUpdated={onUpdated} />
    </div>
  );
}

function PayeeMismatchResolveDialog({ open, detail, onClose, onUpdated }: { open: boolean; detail: InvoiceDetailDto; onClose: () => void; onUpdated: (updated: InvoiceDetailDto) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { head, selectedVersion } = detail;
  if (!selectedVersion || !selectedVersion.payeeIdentity) return null;
  const rows = payeeIdentityRows(selectedVersion.payeeIdentity);

  async function confirm() {
    if (reason.trim().length < 3) {
      setError("Enter a reason (at least 3 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await resolveInvoicePayeeMismatch(head.invoiceRef, { expectedDocVersion: head.docVersion, reason: reason.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReason("");
    onClose();
    onUpdated(result.data);
  }

  return (
    <DialogShell
      open={open}
      title="Resolve payee mismatch"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void confirm()} disabled={busy} data-testid="confirm-resolve-payee-mismatch">
            {busy ? "Resolving…" : "Accept as expected counterparty"}
          </button>
        </>
      }
    >
      {error && (
        <div className="banner" role="alert" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}
      <p className="muted" style={{ marginTop: 0 }}>
        This records that Finance accepts this Invoice as belonging to the expected Payable counterparty. It never changes the Payable&apos;s counterparty, and never edits Partner/Vendor master data.
      </p>
      {rows.map((row) => (
        <div className="kv" key={row.key}>
          <span>{row.field}</span>
          <b>
            {row.expected} → {row.extracted} ({row.result.label})
          </b>
        </div>
      ))}
      <div className="field full" style={{ marginTop: 12 }}>
        <label htmlFor="payee-mismatch-reason">Reason</label>
        <textarea id="payee-mismatch-reason" maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required" data-testid="payee-mismatch-reason-input" />
      </div>
    </DialogShell>
  );
}

function MismatchOverrideDialog({ open, detail, onClose, onUpdated }: { open: boolean; detail: InvoiceDetailDto; onClose: () => void; onUpdated: (updated: InvoiceDetailDto) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { head, selectedVersion } = detail;
  if (!selectedVersion) return null;

  // Step 15C: the mismatch is against the Payable's gross expected Invoice total, never the
  // after-TDS expected net payment.
  const expected = selectedVersion.payablePin.payableGrossInvoiceExpectedMinor;
  const declared = selectedVersion.declaredTotalMinor;
  const variance = expected !== null && declared !== null ? declared - expected : null;

  async function confirm() {
    if (reason.trim().length < 3) {
      setError("Enter a reason (at least 3 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await acceptInvoiceMismatch(head.invoiceRef, { expectedDocVersion: head.docVersion, reason: reason.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReason("");
    onClose();
    onUpdated(result.data);
  }

  return (
    <DialogShell
      open={open}
      title="Accept amount mismatch"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void confirm()} disabled={busy} data-testid="confirm-accept-mismatch">
            {busy ? "Accepting…" : "Accept mismatch"}
          </button>
        </>
      }
    >
      {error && (
        <div className="banner" role="alert" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}
      <div className="kv">
        <span>Payable gross expected Invoice total</span>
        <b>{formatSignedMoneyMinor(expected, selectedVersion.payablePin.payableCurrency, { amountsVisible: detail.amountsVisible })}</b>
      </div>
      <div className="kv">
        <span>Invoice declared amount</span>
        <b>{formatSignedMoneyMinor(declared, selectedVersion.currency, { amountsVisible: detail.amountsVisible })}</b>
      </div>
      <div className="kv">
        <span>Variance</span>
        <b>{formatSignedMoneyMinor(variance, selectedVersion.currency, { amountsVisible: detail.amountsVisible })}</b>
      </div>
      <div className="field full" style={{ marginTop: 12 }}>
        <label htmlFor="mismatch-reason">Reason</label>
        <textarea id="mismatch-reason" maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required" />
      </div>
    </DialogShell>
  );
}

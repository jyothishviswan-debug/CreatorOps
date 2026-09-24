"use client";

import { useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import type { InvoicePaymentSettlementDto, PaymentDetailDto } from "@/server/finance-payments/client-dto";

import { confirmPayment, failPayment, getInvoicePaymentSettlement, recordPayment, reopenPayment, voidPayment } from "../api-client";
import { formatMoneyMinor, paymentMethodLabel, payeeIdentityStatusLabel } from "../format";
import type { DetailActionVisibility } from "./detail-view";

// Step 17B section 15/16: the lifecycle actions rendered in the detail header (Record / Confirm /
// Mark Failed / Reopen / Void). Every action is exact server-permission-and-lifecycle-gated (never a
// role-rank assumption) and goes through a confirming dialog; Mark Failed/Reopen/Void require a
// reason (the backend requires one too, except Record which needs none). Confirm additionally
// fetches the live Invoice settlement so the dialog can show expected/confirmed/remaining BEFORE the
// mutation, and surfaces the server's own would-overpay blocker rather than inventing a client-side
// cap (section 8/16: "Do not silently cap overpayment").
export function LifecycleActions({ detail, visibility, canOverrideOverage, onUpdated }: { detail: PaymentDetailDto; visibility: DetailActionVisibility; canOverrideOverage: boolean; onUpdated: (updated: PaymentDetailDto) => void }) {
  const [recordOpen, setRecordOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmSettlement, setConfirmSettlement] = useState<InvoicePaymentSettlementDto | null>(null);
  const [overageBlocked, setOverageBlocked] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [failOpen, setFailOpen] = useState(false);
  const [failReason, setFailReason] = useState("");
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recordBlockers, setRecordBlockers] = useState<string[] | null>(null);

  const { head, selectedVersion } = detail;
  const opts = { amountsVisible: detail.amountsVisible };

  async function openConfirmDialog() {
    setConfirmOpen(true);
    setOverageBlocked(false);
    setOverrideReason("");
    setError(null);
    const result = await getInvoicePaymentSettlement(head.invoiceRef);
    if (result.ok) setConfirmSettlement(result.data);
  }

  async function doRecord() {
    setBusy(true);
    setError(null);
    setRecordBlockers(null);
    const result = await recordPayment(head.paymentRef, { expectedDocVersion: head.docVersion });
    setBusy(false);
    if (!result.ok) {
      if (result.kind === "not_ready" && result.blockers) setRecordBlockers(result.blockers.map((blocker) => blocker.message));
      else setError(result.message);
      return;
    }
    setRecordOpen(false);
    onUpdated(result.data);
  }

  async function doConfirm(withOverride: boolean) {
    setBusy(true);
    setError(null);
    const result = await confirmPayment(head.paymentRef, { expectedDocVersion: head.docVersion, ...(withOverride ? { overrideOverageReason: overrideReason.trim() } : {}) });
    setBusy(false);
    if (!result.ok) {
      if (result.kind === "not_ready") {
        setOverageBlocked(true);
        return;
      }
      setError(result.message);
      return;
    }
    setConfirmOpen(false);
    setOverageBlocked(false);
    onUpdated(result.data);
  }

  async function doFail() {
    if (failReason.trim().length < 3) {
      setError("Enter a reason (at least 3 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await failPayment(head.paymentRef, { expectedDocVersion: head.docVersion, reason: failReason.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setFailOpen(false);
    setFailReason("");
    onUpdated(result.data);
  }

  async function doReopen() {
    if (reopenReason.trim().length < 3) {
      setError("Enter a reason (at least 3 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await reopenPayment(head.paymentRef, { expectedDocVersion: head.docVersion, reason: reopenReason.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReopenOpen(false);
    setReopenReason("");
    onUpdated(result.data);
  }

  async function doVoid() {
    if (voidReason.trim().length < 3) {
      setError("Enter a reason (at least 3 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await voidPayment(head.paymentRef, { expectedDocVersion: head.docVersion, reason: voidReason.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setVoidOpen(false);
    setVoidReason("");
    onUpdated(result.data);
  }

  const isCorrectionVoid = head.status === "CONFIRMED";

  return (
    <>
      {visibility.canRecord && (
        <button type="button" className="btn primary" onClick={() => { setRecordOpen(true); setError(null); }} data-testid="record-action">
          Record
        </button>
      )}
      {visibility.canConfirm && (
        <button type="button" className="btn primary" onClick={() => void openConfirmDialog()} data-testid="confirm-action">
          Confirm
        </button>
      )}
      {visibility.canMarkFailed && (
        <button type="button" className="btn" onClick={() => { setFailOpen(true); setError(null); }} data-testid="fail-action">
          Mark Failed
        </button>
      )}
      {visibility.canReopen && (
        <button type="button" className="btn primary" onClick={() => { setReopenOpen(true); setError(null); }} data-testid="reopen-action">
          Revise / Retry
        </button>
      )}
      {visibility.canVoid && (
        <div className="segment" role="group" aria-label="More actions">
          <button type="button" onClick={() => { setVoidOpen(true); setError(null); }} data-testid="void-action">
            Void
          </button>
        </div>
      )}
      {head.status === "CONFIRMED" && !visibility.canVoid && <p className="foundationnote">Confirmed payments are immutable.</p>}

      {/* Record dialog (section 16) */}
      <DialogShell
        open={recordOpen}
        title="Record Payment"
        onClose={() => {
          setRecordOpen(false);
          setRecordBlockers(null);
          setError(null);
        }}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setRecordOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={() => void doRecord()} disabled={busy}>
              {busy ? "Recording…" : "Record"}
            </button>
          </>
        }
      >
        {error && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}
        {recordBlockers && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }} data-testid="record-blockers">
            <b>This Payment is not ready to be recorded:</b>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {recordBlockers.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="kv">
          <span>Amount</span>
          <b>{formatMoneyMinor(head.amountMinor, head.currency, opts)}</b>
        </div>
        <div className="kv">
          <span>Payment date</span>
          <b>{selectedVersion?.paymentDate ?? "Not set"}</b>
        </div>
        <div className="kv">
          <span>Method</span>
          <b>{paymentMethodLabel(selectedVersion?.method ?? null)}</b>
        </div>
        <div className="kv">
          <span>External reference</span>
          <b>{selectedVersion?.externalReference ?? "Not set"}</b>
        </div>
        <div className="kv">
          <span>Invoice</span>
          <b>{head.invoiceRef}</b>
        </div>
        <p className="foundationnote" style={{ marginTop: 12 }}>
          Recorded payments are not counted as settled until confirmed.
        </p>
      </DialogShell>

      {/* Confirm dialog (section 16) */}
      <DialogShell
        open={confirmOpen}
        title="Confirm Payment"
        onClose={() => {
          setConfirmOpen(false);
          setOverageBlocked(false);
          setError(null);
        }}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirmOpen(false)} disabled={busy}>
              Cancel
            </button>
            {overageBlocked && canOverrideOverage ? (
              <button type="button" className="btn primary" onClick={() => void doConfirm(true)} disabled={busy || overrideReason.trim().length < 3} data-testid="confirm-override-action">
                {busy ? "Confirming…" : "Confirm with override"}
              </button>
            ) : (
              <button type="button" className="btn primary" onClick={() => void doConfirm(false)} disabled={busy || overageBlocked} data-testid="confirm-submit-action">
                {busy ? "Confirming…" : "Confirm"}
              </button>
            )}
          </>
        }
      >
        {error && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}
        {overageBlocked && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }} data-testid="confirm-overpayment-blocker">
            <b>Confirming this Payment would exceed the Invoice&apos;s expected net payment.</b>
            {canOverrideOverage ? (
              <div className="field full" style={{ marginTop: 10 }}>
                <label htmlFor="override-reason">Override reason</label>
                <textarea id="override-reason" maxLength={1000} value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} placeholder="Required to override" />
              </div>
            ) : (
              <p style={{ marginTop: 6 }}>You do not hold the permission to accept an overpayment override.</p>
            )}
          </div>
        )}
        <div className="kv">
          <span>Counterparty</span>
          <b>{head.counterparty.displayName ?? head.counterparty.ref}</b>
        </div>
        <div className="kv">
          <span>Invoice</span>
          <b>{head.invoiceRef}</b>
        </div>
        <div className="kv">
          <span>This Payment</span>
          <b>{formatMoneyMinor(head.amountMinor, head.currency, opts)}</b>
        </div>
        <div className="kv">
          <span>Expected net payment</span>
          <b>{formatMoneyMinor(confirmSettlement?.summary.expectedNetPaymentMinor ?? null, head.currency, opts)}</b>
        </div>
        <div className="kv">
          <span>Confirmed before</span>
          <b>{formatMoneyMinor(confirmSettlement?.summary.confirmedPaidMinor ?? null, head.currency, opts)}</b>
        </div>
        <div className="kv">
          <span>External reference</span>
          <b>{selectedVersion?.externalReference ?? "Not set"}</b>
        </div>
        <div className="kv">
          <span>Payee identity status</span>
          <b>{payeeIdentityStatusLabel(selectedVersion?.payeeIdentity.overallStatusAtApproval ?? null)}</b>
        </div>
      </DialogShell>

      {/* Mark Failed dialog */}
      <DialogShell
        open={failOpen}
        title="Mark Payment Failed"
        onClose={() => {
          setFailOpen(false);
          setError(null);
        }}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setFailOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={() => void doFail()} disabled={busy}>
              {busy ? "Marking failed…" : "Mark Failed"}
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
          <span>Amount</span>
          <b>{formatMoneyMinor(head.amountMinor, head.currency, opts)}</b>
        </div>
        <div className="kv">
          <span>External reference</span>
          <b>{selectedVersion?.externalReference ?? "Not set"}</b>
        </div>
        <p className="foundationnote" style={{ margin: "10px 0" }}>
          A failed Payment never counts toward settlement.
        </p>
        <div className="field full">
          <label htmlFor="fail-reason">Reason</label>
          <textarea id="fail-reason" maxLength={1000} value={failReason} onChange={(event) => setFailReason(event.target.value)} placeholder="Required" />
        </div>
      </DialogShell>

      {/* Reopen dialog */}
      <DialogShell
        open={reopenOpen}
        title="Reopen Payment"
        onClose={() => {
          setReopenOpen(false);
          setError(null);
        }}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setReopenOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={() => void doReopen()} disabled={busy}>
              {busy ? "Reopening…" : "Reopen"}
            </button>
          </>
        }
      >
        {error && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}
        <p>Reopening creates a new Draft version, starting from the failed version&apos;s content. The failed version is retained in History.</p>
        <div className="field full">
          <label htmlFor="reopen-reason">Reason</label>
          <textarea id="reopen-reason" maxLength={1000} value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} placeholder="Required" />
        </div>
      </DialogShell>

      {/* Void dialog (section 16/20) */}
      <DialogShell
        open={voidOpen}
        title="Void this Payment"
        onClose={() => {
          setVoidOpen(false);
          setError(null);
        }}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setVoidOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={() => void doVoid()} disabled={busy}>
              {busy ? "Voiding…" : "Void Payment"}
            </button>
          </>
        }
      >
        {error && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}
        {isCorrectionVoid ? (
          <p>
            This Payment is currently Confirmed. Voiding it is a correction/reversal: the Invoice&apos;s settlement figures recalculate immediately, but CreatorOps is not claiming that the underlying bank transfer itself was reversed - that must be
            verified and actioned outside CreatorOps.
          </p>
        ) : (
          <p>Voiding is terminal: this Payment can never proceed further, and every historical version and event is retained. There is no delete.</p>
        )}
        <div className="field full">
          <label htmlFor="void-reason">Reason</label>
          <textarea id="void-reason" maxLength={1000} value={voidReason} onChange={(event) => setVoidReason(event.target.value)} placeholder="Required" />
        </div>
      </DialogShell>
    </>
  );
}

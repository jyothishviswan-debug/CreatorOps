"use client";

import { useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import type { InvoiceDetailDto } from "@/server/finance-invoices/client-dto";

import { formatMoneyMinor, formatSignedMoneyMinor } from "../format";
import { rejectInvoice, reopenInvoice, submitInvoice, voidInvoice } from "../api-client";
import type { DetailActionVisibility } from "./detail-view";
import { ApproveDialog } from "./ApproveDialog";

// Step 16B: the lifecycle actions rendered in the detail header (Submit / Approve / Reject / Reopen
// / Void). Every action is exact server-permission-and-lifecycle-gated (never a role-rank
// assumption) and goes through a confirming dialog; Reject/Reopen/Void additionally require a
// reason (the backend requires one too). Submit shows the server's own blocker reasons in plain
// language before the mutation, never invents its own client-side readiness check.
export function LifecycleActions({ detail, visibility, onUpdated }: { detail: InvoiceDetailDto; visibility: DetailActionVisibility; onUpdated: (updated: InvoiceDetailDto) => void }) {
  const [submitOpen, setSubmitOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitBlockers, setSubmitBlockers] = useState<string[] | null>(null);

  async function confirmSubmit() {
    setBusy(true);
    setError(null);
    setSubmitBlockers(null);
    const result = await submitInvoice(detail.head.invoiceRef, { expectedDocVersion: detail.head.docVersion });
    setBusy(false);
    if (!result.ok) {
      if (result.kind === "not_ready" && result.blockers) setSubmitBlockers(result.blockers.map((blocker) => blocker.message));
      else setError(result.message);
      return;
    }
    setSubmitOpen(false);
    onUpdated(result.data);
  }

  async function confirmReject() {
    if (rejectReason.trim().length < 3) {
      setError("Enter a reason (at least 3 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await rejectInvoice(detail.head.invoiceRef, { expectedDocVersion: detail.head.docVersion, reason: rejectReason.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setRejectOpen(false);
    setRejectReason("");
    onUpdated(result.data);
  }

  async function confirmReopen() {
    if (reopenReason.trim().length < 3) {
      setError("Enter a reason (at least 3 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await reopenInvoice(detail.head.invoiceRef, { expectedDocVersion: detail.head.docVersion, reason: reopenReason.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReopenOpen(false);
    setReopenReason("");
    onUpdated(result.data);
  }

  async function confirmVoid() {
    if (voidReason.trim().length < 3) {
      setError("Enter a reason (at least 3 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await voidInvoice(detail.head.invoiceRef, { expectedDocVersion: detail.head.docVersion, reason: voidReason.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setVoidOpen(false);
    setVoidReason("");
    onUpdated(result.data);
  }

  return (
    <>
      {visibility.canSubmit && (
        <button type="button" className="btn primary" onClick={() => setSubmitOpen(true)} data-testid="submit-action">
          Submit
        </button>
      )}
      {visibility.canApprove && (
        <button type="button" className="btn primary" onClick={() => setApproveOpen(true)} data-testid="approve-action">
          Approve
        </button>
      )}
      {visibility.canReject && (
        <button type="button" className="btn" onClick={() => setRejectOpen(true)} data-testid="reject-action">
          Reject
        </button>
      )}
      {visibility.canReopen && (
        <button type="button" className="btn primary" onClick={() => setReopenOpen(true)} data-testid="reopen-action">
          Revise / Reopen
        </button>
      )}
      {visibility.canVoid && (
        <div className="segment" role="group" aria-label="More actions">
          <button type="button" onClick={() => setVoidOpen(true)} data-testid="void-action">
            Void
          </button>
        </div>
      )}

      <DialogShell
        open={submitOpen}
        title="Submit Invoice"
        onClose={() => {
          setSubmitOpen(false);
          setSubmitBlockers(null);
          setError(null);
        }}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setSubmitOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={() => void confirmSubmit()} disabled={busy}>
              {busy ? "Submitting…" : "Submit"}
            </button>
          </>
        }
      >
        {error && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}
        {submitBlockers && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }} data-testid="submit-blockers">
            <b>This Invoice is not ready for submission:</b>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {submitBlockers.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        )}
        <p>Submitting sends this Invoice for approval. Ordinary edits will be blocked until it is approved, rejected or reopened.</p>
      </DialogShell>

      <ApproveDialog open={approveOpen} detail={detail} onClose={() => setApproveOpen(false)} onUpdated={onUpdated} />

      <DialogShell open={rejectOpen} title="Reject Invoice" onClose={() => setRejectOpen(false)} footer={<><button type="button" className="btn" onClick={() => setRejectOpen(false)} disabled={busy}>Cancel</button><button type="button" className="btn primary" onClick={() => void confirmReject()} disabled={busy}>{busy ? "Rejecting…" : "Reject Invoice"}</button></>}>
        {error && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}
        <div className="kv">
          <span>Invoice number</span>
          <b>{detail.head.externalInvoiceNumber ?? "Not set"}</b>
        </div>
        <div className="kv">
          <span>Counterparty</span>
          <b>{detail.head.counterparty.displayName ?? detail.head.counterparty.ref}</b>
        </div>
        <div className="field full" style={{ marginTop: 12 }}>
          <label htmlFor="reject-reason">Reason</label>
          <textarea id="reject-reason" maxLength={1000} value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} placeholder="Required" />
        </div>
      </DialogShell>

      <DialogShell open={reopenOpen} title="Reopen Invoice" onClose={() => setReopenOpen(false)} footer={<><button type="button" className="btn" onClick={() => setReopenOpen(false)} disabled={busy}>Cancel</button><button type="button" className="btn primary" onClick={() => void confirmReopen()} disabled={busy}>{busy ? "Reopening…" : "Reopen"}</button></>}>
        {error && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}
        <p>Reopening creates a new Draft version, starting from the rejected version&apos;s content. The rejected version is retained in History.</p>
        <div className="field full">
          <label htmlFor="reopen-reason">Reason</label>
          <textarea id="reopen-reason" maxLength={1000} value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} placeholder="Required" />
        </div>
      </DialogShell>

      <DialogShell open={voidOpen} title="Void this Invoice" onClose={() => setVoidOpen(false)} footer={<><button type="button" className="btn" onClick={() => setVoidOpen(false)} disabled={busy}>Cancel</button><button type="button" className="btn primary" onClick={() => void confirmVoid()} disabled={busy}>{busy ? "Voiding…" : "Void Invoice"}</button></>}>
        {error && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}
        <p>Voiding is terminal: this Invoice can never proceed to Payment, and every historical version and event is retained. There is no delete.</p>
        <div className="field full">
          <label htmlFor="void-reason">Reason</label>
          <textarea id="void-reason" maxLength={1000} value={voidReason} onChange={(event) => setVoidReason(event.target.value)} placeholder="Required" />
        </div>
      </DialogShell>
    </>
  );
}

export { formatMoneyMinor, formatSignedMoneyMinor };

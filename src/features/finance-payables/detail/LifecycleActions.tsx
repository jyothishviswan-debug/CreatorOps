"use client";

import { useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import type { PayableDetailDto } from "@/server/finance-payables/client-dto";

import { markPayableReadyForInvoice, voidPayable } from "../api-client";
import type { DetailActionVisibility } from "./detail-view";

// Step 15B: the DRAFT/READY_FOR_INVOICE lifecycle actions (Ready for invoice, Void). Both are exact
// server-permission-gated (never a role-rank assumption) and both go through a confirming dialog - Void
// additionally requires a reason (the backend requires one too).
export function LifecycleActions({ detail, visibility, onUpdated }: { detail: PayableDetailDto; visibility: DetailActionVisibility; onUpdated: (updated: PayableDetailDto) => void }) {
  const [readyOpen, setReadyOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmReady() {
    setBusy(true);
    setError(null);
    const result = await markPayableReadyForInvoice(detail.head.payableRef, { expectedDocVersion: detail.head.docVersion });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReadyOpen(false);
    onUpdated(result.data);
  }

  async function confirmVoid() {
    if (voidReason.trim().length < 3) {
      setError("Enter a reason (at least 3 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await voidPayable(detail.head.payableRef, { expectedDocVersion: detail.head.docVersion, reason: voidReason.trim() });
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
      {visibility.canMarkReady && (
        <button type="button" className="btn primary" onClick={() => setReadyOpen(true)}>
          Ready for invoice
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
        open={readyOpen}
        title="Mark ready for invoice"
        onClose={() => setReadyOpen(false)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setReadyOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={() => void confirmReady()} disabled={busy}>
              {busy ? "Confirming…" : "Confirm"}
            </button>
          </>
        }
      >
        {error && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}
        <p>This pins the current version (v{detail.head.latestVersion}) as the exact version a future Invoice will consume. This is not an approval step.</p>
      </DialogShell>

      <DialogShell
        open={voidOpen}
        title="Void this Payable"
        onClose={() => setVoidOpen(false)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setVoidOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={() => void confirmVoid()} disabled={busy}>
              {busy ? "Voiding…" : "Void Payable"}
            </button>
          </>
        }
      >
        {error && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}
        <p>Voiding is terminal: this Payable can never be invoiced, and every historical version and event is retained. There is no delete.</p>
        <div className="field full">
          <label htmlFor="void-reason">Reason</label>
          <textarea id="void-reason" maxLength={1000} value={voidReason} onChange={(event) => setVoidReason(event.target.value)} placeholder="Required" />
        </div>
      </DialogShell>
    </>
  );
}

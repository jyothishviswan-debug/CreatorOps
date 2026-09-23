"use client";

import { useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import type { InvoiceDetailDto } from "@/server/finance-invoices/client-dto";

import { formatMoneyMinor, formatSignedMoneyMinor, reconciliationChip } from "../format";
import { approveInvoice } from "../api-client";

// Step 16B section 18: Approval is high-signal - an explicit confirmation dialog showing exactly
// what is being approved (Invoice number, counterparty, declared total/currency, the pinned
// Payable's expected total, reconciliation state, mismatch acceptance state, pinned Payable
// version). No extra legal checkbox: the server remains authoritative and re-checks every
// precondition itself.
export function ApproveDialog({ open, detail, onClose, onUpdated }: { open: boolean; detail: InvoiceDetailDto; onClose: () => void; onUpdated: (updated: InvoiceDetailDto) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { head, selectedVersion } = detail;

  async function confirmApprove() {
    setBusy(true);
    setError(null);
    const result = await approveInvoice(head.invoiceRef, { expectedDocVersion: head.docVersion });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onClose();
    onUpdated(result.data);
  }

  return (
    <DialogShell
      open={open}
      title="Approve Invoice"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void confirmApprove()} disabled={busy} data-testid="confirm-approve">
            {busy ? "Approving…" : "Approve Invoice"}
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
        <span>Invoice number</span>
        <b>{head.externalInvoiceNumber ?? "Not set"}</b>
      </div>
      <div className="kv">
        <span>Counterparty</span>
        <b>{head.counterparty.displayName ?? head.counterparty.ref}</b>
      </div>
      <div className="kv">
        <span>Declared total</span>
        <b>{formatMoneyMinor(head.declaredTotalMinor, head.currency, { amountsVisible: detail.amountsVisible })}</b>
      </div>
      {selectedVersion && (
        <div className="kv">
          <span>Payable expected total</span>
          <b>{formatSignedMoneyMinor(selectedVersion.payablePin.payableExpectedTotalMinorSigned, selectedVersion.payablePin.payableCurrency, { amountsVisible: detail.amountsVisible })}</b>
        </div>
      )}
      <div className="kv">
        <span>Reconciliation</span>
        <b>{reconciliationChip(head.reconciliationState).label}</b>
      </div>
      {head.mismatchOverride && (
        <div className="kv">
          <span>Mismatch acceptance</span>
          <b>Accepted with reason</b>
        </div>
      )}
      {selectedVersion && (
        <div className="kv">
          <span>Pinned Payable version</span>
          <b>
            {selectedVersion.payablePin.payableRef} · v{selectedVersion.payablePin.payableVersion}
          </b>
        </div>
      )}
    </DialogShell>
  );
}

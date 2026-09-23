"use client";

import { useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import type { PayableReviewCode } from "@/server/finance-payables/types";

import { minorToInputText, parseSignedMoneyInputToMinor } from "../format";

export type ManualAdjustmentInput = { label: string; amountMinorSigned: number; reason: string; resolvesCode?: PayableReviewCode };

// Step 15B: the one compact "Add manual adjustment" dialog, shared by Create (Stage 2) and Detail
// (Amount breakdown tab, DRAFT only). Reason is required; the amount field is SIGNED (a negative deducts,
// 0 records a no-financial-effect Finance confirmation). Never shown to an unauthorized user - the caller
// decides visibility of the triggering action, this dialog only renders while `open`.
export function ManualAdjustmentDialog({
  open,
  onClose,
  onSubmit,
  resolvableItems,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: ManualAdjustmentInput) => Promise<{ ok: boolean; message?: string }>;
  resolvableItems: Array<{ code: PayableReviewCode; message: string }>;
  busy?: boolean;
}) {
  const [label, setLabel] = useState("");
  const [amountText, setAmountText] = useState("");
  const [reason, setReason] = useState("");
  const [resolvesCode, setResolvesCode] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setLabel("");
    setAmountText("");
    setReason("");
    setResolvesCode("");
    setError(null);
  }

  async function submit() {
    setError(null);
    if (!label.trim()) return setError("Enter a label for this adjustment.");
    const parsed = parseSignedMoneyInputToMinor(amountText || "0");
    if (!parsed.ok) return setError(parsed.message);
    if (!reason.trim() || reason.trim().length < 3) return setError("Enter a reason (at least 3 characters).");

    const result = await onSubmit({ label: label.trim(), amountMinorSigned: parsed.amountMinorSigned, reason: reason.trim(), ...(resolvesCode ? { resolvesCode: resolvesCode as PayableReviewCode } : {}) });
    if (!result.ok) {
      setError(result.message ?? "Could not add the adjustment.");
      return;
    }
    reset();
    onClose();
  }

  return (
    <DialogShell
      open={open}
      title="Add manual adjustment"
      onClose={() => {
        reset();
        onClose();
      }}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "Adding…" : "Add adjustment"}
          </button>
        </>
      }
    >
      {error && (
        <div className="banner" role="alert" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}
      <div className="fields">
        <div className="field full">
          <label htmlFor="adjustment-label">Label</label>
          <input id="adjustment-label" type="text" maxLength={200} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Advance recovery for March" />
        </div>
        <div className="field">
          <label htmlFor="adjustment-amount">Amount</label>
          <input id="adjustment-amount" type="text" inputMode="decimal" value={amountText} onChange={(event) => setAmountText(event.target.value)} placeholder="e.g. -5000 or 2500" />
          <small>A negative amount deducts; 0 records a Finance confirmation with no financial effect.</small>
        </div>
        {resolvableItems.length > 0 && (
          <div className="field">
            <label htmlFor="adjustment-resolves">Resolves review item</label>
            <select id="adjustment-resolves" value={resolvesCode} onChange={(event) => setResolvesCode(event.target.value)}>
              <option value="">None</option>
              {resolvableItems.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.message}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field full">
          <label htmlFor="adjustment-reason">Reason</label>
          <textarea id="adjustment-reason" maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required — explain the commercial basis for this adjustment." />
        </div>
      </div>
    </DialogShell>
  );
}

// Prefills the amount field from an existing signed minor-unit value (used when editing is added later;
// kept here so the input-format concern lives in one place).
export function adjustmentAmountPrefill(amountMinorSigned: number | null): string {
  return minorToInputText(amountMinorSigned);
}

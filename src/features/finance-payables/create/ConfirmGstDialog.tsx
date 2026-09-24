"use client";

import { useState } from "react";

import { DialogShell } from "@/ui/Dialog";

export type ConfirmGstInput = { gstApplicable: boolean; gstRateBps: number | null };

// Step 15C.1 section 10: the one small "Confirm GST" dialog, shared by Create (Stage 2) and Detail
// (Amount breakdown tab, DRAFT only). GST has no canonical source in this codebase, so it is never
// guessed - Finance states Yes/No explicitly, and a rate only when Yes. This is deliberately NOT the
// generic "Add manual adjustment" dialog: the answer is written onto the Payable's own typed tax
// fields (so the gross expected Invoice / expected net payment totals stay correct), not folded into
// an arbitrary breakdown line.
export function ConfirmGstDialog({
  open,
  onClose,
  onSubmit,
  currentApplicable,
  currentRateBps,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: ConfirmGstInput) => Promise<{ ok: boolean; message?: string }>;
  currentApplicable: boolean | null;
  currentRateBps: number | null;
  busy?: boolean;
}) {
  const [applicable, setApplicable] = useState<"yes" | "no">(currentApplicable === true ? "yes" : "no");
  const [rateText, setRateText] = useState(currentRateBps !== null ? (currentRateBps / 100).toString() : "");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setApplicable(currentApplicable === true ? "yes" : "no");
    setRateText(currentRateBps !== null ? (currentRateBps / 100).toString() : "");
    setError(null);
  }

  async function submit() {
    setError(null);
    let gstRateBps: number | null = null;
    if (applicable === "yes") {
      const parsedRate = Number(rateText.trim());
      if (rateText.trim() === "" || !Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 100) {
        setError("Enter a GST rate between 0 and 100.");
        return;
      }
      gstRateBps = Math.round(parsedRate * 100);
    }

    const result = await onSubmit({ gstApplicable: applicable === "yes", gstRateBps });
    if (!result.ok) {
      setError(result.message ?? "Could not confirm GST.");
      return;
    }
    reset();
    onClose();
  }

  return (
    <DialogShell
      open={open}
      title="Confirm GST"
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
      <div className="fields">
        <div className="field full">
          <label htmlFor="gst-applicable">Is GST applicable?</label>
          <select id="gst-applicable" value={applicable} onChange={(event) => setApplicable(event.target.value === "yes" ? "yes" : "no")}>
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
          <small>No canonical GST source exists for this Payable - Finance states this explicitly. This is never inferred from geography or name.</small>
        </div>
        {applicable === "yes" && (
          <div className="field">
            <label htmlFor="gst-rate">GST rate (%)</label>
            <input id="gst-rate" type="text" inputMode="decimal" value={rateText} onChange={(event) => setRateText(event.target.value)} placeholder="e.g. 18" />
          </div>
        )}
      </div>
    </DialogShell>
  );
}

"use client";

import { useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import type { ContentDto } from "@/server/content/client-dto";
import { approveContentThread, requestContentRevision } from "./api-client";
import { platformLabel } from "./format";

type Decision = "APPROVED" | "REVISION_REQUESTED";

// Step 11A.1: repurposed from the retired review dialog - only the two
// real Manager decisions exist now (never "Reject" - section 9's own
// explicit "do not keep REJECTED"). Shows the current revision's own
// links directly (currentLinks is already denormalized onto the loaded
// ContentDto, no extra fetch needed) so the Manager can actually see what
// they're deciding on.
export function ContentReviewDialog({ content, open, onClose, onSaved }: { content: ContentDto; open: boolean; onClose: () => void; onSaved: (content: ContentDto) => void }) {
  const [decision, setDecision] = useState<Decision>("APPROVED");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setDecision("APPROVED");
    setReason("");
    setError(null);
  }

  function close() {
    reset();
    onClose();
  }

  const reasonRequired = decision === "REVISION_REQUESTED";
  const canSubmit = !reasonRequired || reason.trim().length > 0;

  async function submit() {
    if (!content.reviewedRevisionNumber) return;
    setBusy(true);
    setError(null);

    const result =
      decision === "APPROVED"
        ? await approveContentThread(content.contentRef, { reviewedRevisionNumber: content.reviewedRevisionNumber, expectedVersion: content.version })
        : await requestContentRevision(content.contentRef, { reason: reason.trim(), reviewedRevisionNumber: content.reviewedRevisionNumber, expectedVersion: content.version });

    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    reset();
    onSaved(result.data);
    onClose();
  }

  return (
    <DialogShell
      open={open}
      title="Review submission"
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={busy || !canSubmit}>
            {busy ? "Saving…" : "Record decision"}
          </button>
        </>
      }
    >
      <div className="kv">
        <span>Partner</span>
        <b>{content.partnerDisplayName ?? "Unknown Partner"}</b>
      </div>
      <div className="kv">
        <span>Campaign</span>
        <b>{content.campaignName ?? "Unknown Campaign"}</b>
      </div>
      <div className="kv">
        <span>Revision</span>
        <b>{content.currentRevisionNumber || "—"}</b>
      </div>

      <div style={{ marginTop: 14 }}>
        <p className="foundationnote" style={{ marginBottom: 8 }}>
          Submitted links
        </p>
        {content.currentLinks.length === 0 ? (
          <p className="detailcopy">No links submitted yet.</p>
        ) : (
          content.currentLinks.map((link) => (
            <div className="kv" key={link.normalizedUrl}>
              <span>{platformLabel(link.platform)}</span>
              <b>
                <a href={link.originalUrl} target="_blank" rel="noreferrer noopener">
                  {link.originalUrl}
                </a>
              </b>
            </div>
          ))
        )}
      </div>

      <fieldset style={{ marginTop: 14, border: "none", padding: 0 }}>
        <legend className="foundationnote" style={{ marginBottom: 8 }}>
          Decision
        </legend>
        <div className="actions" role="radiogroup" aria-label="Review decision">
          {(["APPROVED", "REVISION_REQUESTED"] as Decision[]).map((value) => (
            <label key={value} className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="radio" name="content-review-decision" value={value} checked={decision === value} onChange={() => setDecision(value)} />
              {value === "APPROVED" ? "Approve" : "Request changes"}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="field full" style={{ marginTop: 14 }}>
        <label htmlFor="content-review-reason">Reason{reasonRequired ? " (required)" : " (not needed to approve)"}</label>
        <textarea id="content-review-reason" value={reason} onChange={(e) => setReason(e.target.value)} required={reasonRequired} disabled={decision === "APPROVED"} />
      </div>

      {error && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </DialogShell>
  );
}

"use client";

import { useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import type { ContentDto } from "@/server/content/client-dto";
import { approveContentThread, requestContentRevision } from "./api-client";
import { platformLabel } from "./format";

type Decision = "APPROVED" | "REVISION_REQUESTED";

// Finding #45: the decision IS the action - clicking "Approve" or "Request
// changes" executes that outcome directly (after validation), instead of
// picking a radio option and then pressing a separate generic confirm
// button. Reason stays required only for Request changes (server-enforced
// too - content-lifecycle-service.ts's own reasonRequired check is
// unchanged, this is UI-only). `pending` (not just a boolean `busy`) tracks
// WHICH action is in flight so the other button can be disabled without
// losing its own label, and both are disabled the instant either is
// clicked so a double click can never fire two requests (the server's own
// expectedVersion/reviewedRevisionNumber staleness check is a second,
// independent guard against this - see content-lifecycle-service.ts).
export function ContentReviewDialog({ content, open, onClose, onSaved }: { content: ContentDto; open: boolean; onClose: () => void; onSaved: (content: ContentDto) => void }) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasonMissing, setReasonMissing] = useState(false);

  function reset() {
    setReason("");
    setError(null);
    setReasonMissing(false);
  }

  function close() {
    reset();
    onClose();
  }

  async function act(decision: Decision) {
    if (pending || !content.reviewedRevisionNumber) return;
    if (decision === "REVISION_REQUESTED" && reason.trim().length === 0) {
      setReasonMissing(true);
      return;
    }
    setReasonMissing(false);
    setPending(decision);
    setError(null);

    const result =
      decision === "APPROVED"
        ? await approveContentThread(content.contentRef, { reviewedRevisionNumber: content.reviewedRevisionNumber, expectedVersion: content.version })
        : await requestContentRevision(content.contentRef, { reason: reason.trim(), reviewedRevisionNumber: content.reviewedRevisionNumber, expectedVersion: content.version });

    setPending(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    reset();
    onSaved(result.data);
    onClose();
  }

  const busy = pending !== null;

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
          <button type="button" className="btn" onClick={() => act("REVISION_REQUESTED")} disabled={busy} data-testid="review-request-changes">
            {pending === "REVISION_REQUESTED" ? "Requesting changes…" : "Request changes"}
          </button>
          <button type="button" className="btn primary" onClick={() => act("APPROVED")} disabled={busy} data-testid="review-approve">
            {pending === "APPROVED" ? "Approving…" : "Approve"}
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

      <div className="field full" style={{ marginTop: 14 }}>
        <label htmlFor="content-review-reason">Reason (required for Request changes; not needed to approve)</label>
        <textarea
          id="content-review-reason"
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            if (e.target.value.trim().length > 0) setReasonMissing(false);
          }}
          disabled={busy}
        />
        {reasonMissing && (
          <small className="fielderror" role="alert">
            Add a reason before requesting changes.
          </small>
        )}
      </div>

      {error && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </DialogShell>
  );
}

"use client";

import { useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import type { ContentDto } from "@/server/content/client-dto";
import { reviewContentDecision } from "./api-client";
import { absoluteTime } from "./format";

type Decision = "APPROVED" | "CHANGES_REQUIRED" | "REJECTED";

const REASON_REQUIRED: Decision[] = ["CHANGES_REQUIRED", "REJECTED"];

// Step 11B: REVIEW_REQUIRED only - this component must never be mounted
// at all when reviewPolicy !== "REVIEW_REQUIRED" (the caller is
// responsible for that, not this component). Shows safe context
// (content label, Partner/Campaign, lastSubmittedVersion, submitted
// timestamp) - the submitted version's own caption/URL/notes body text is
// NOT shown here: no existing API route exposes a version's content by
// number (only the version's existence/number is knowable from
// ContentDto/history), and inventing a new backend read path is out of
// scope for this UI-only step. This is a known, honest limitation - see
// the completion report.
export function ContentReviewDialog({
  content,
  open,
  onClose,
  onSaved,
}: {
  content: ContentDto;
  open: boolean;
  onClose: () => void;
  onSaved: (content: ContentDto) => void;
}) {
  const [decision, setDecision] = useState<Decision>("APPROVED");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setDecision("APPROVED");
    setComment("");
    setError(null);
  }

  function close() {
    reset();
    onClose();
  }

  const reasonRequired = REASON_REQUIRED.includes(decision);
  const canSubmit = !reasonRequired || comment.trim().length > 0;

  async function submit() {
    if (!content.lastSubmittedVersion) return;
    setBusy(true);
    setError(null);
    const result = await reviewContentDecision(content.contentRef, {
      decision,
      reviewedVersion: content.lastSubmittedVersion,
      comment: comment.trim() ? comment.trim() : undefined,
      expectedVersion: content.version,
    });
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
        <span>Submitted version</span>
        <b>{content.lastSubmittedVersion ?? "—"}</b>
      </div>
      <div className="kv">
        <span>Submitted</span>
        <b>{content.submittedAt ? absoluteTime(content.submittedAt) : "—"}</b>
      </div>

      <fieldset style={{ marginTop: 14, border: "none", padding: 0 }}>
        <legend className="foundationnote" style={{ marginBottom: 8 }}>
          Decision
        </legend>
        <div className="actions" role="radiogroup" aria-label="Review decision">
          {(["APPROVED", "CHANGES_REQUIRED", "REJECTED"] as Decision[]).map((value) => (
            <label key={value} className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="radio" name="content-review-decision" value={value} checked={decision === value} onChange={() => setDecision(value)} />
              {value === "APPROVED" ? "Approve" : value === "CHANGES_REQUIRED" ? "Request changes" : "Reject"}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="field full" style={{ marginTop: 14 }}>
        <label htmlFor="content-review-comment">Comment{reasonRequired ? " (required)" : " (optional)"}</label>
        <textarea id="content-review-comment" value={comment} onChange={(e) => setComment(e.target.value)} required={reasonRequired} />
      </div>

      {error && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </DialogShell>
  );
}

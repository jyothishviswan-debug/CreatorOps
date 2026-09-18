"use client";

import { useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import type { ContentDto } from "@/server/content/client-dto";
import { saveContentVersion } from "./api-client";

// Step 11B: "Save production version" (or "Save revised version" when
// opened while CHANGES_REQUIRED - see `title` prop). Fields match the
// real saveContentVersion contract exactly (captionText/sourceUrl/
// submissionNotes, all optional) - no attachment upload UI is built here
// (attachmentRefs is deliberately omitted; building a new file-upload
// subsystem is out of scope for this UI step).
export function ContentVersionDialog({
  content,
  title,
  open,
  onClose,
  onSaved,
}: {
  content: ContentDto;
  title: string;
  open: boolean;
  onClose: () => void;
  onSaved: (content: ContentDto) => void;
}) {
  const [captionText, setCaptionText] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [submissionNotes, setSubmissionNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setCaptionText("");
    setSourceUrl("");
    setSubmissionNotes("");
    setError(null);
  }

  function close() {
    reset();
    onClose();
  }

  async function save() {
    setBusy(true);
    setError(null);
    const result = await saveContentVersion(content.contentRef, {
      captionText: captionText.trim() ? captionText.trim() : undefined,
      sourceUrl: sourceUrl.trim() ? sourceUrl.trim() : undefined,
      submissionNotes: submissionNotes.trim() ? submissionNotes.trim() : undefined,
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
      title={title}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save version"}
          </button>
        </>
      }
    >
      {content.status === "CHANGES_REQUIRED" && (
        <div className="banner" role="status" style={{ marginBottom: 14 }}>
          <b>Reviewer feedback.</b> {content.statusReason ?? "No reason recorded."}
        </div>
      )}
      <div className="field full">
        <label htmlFor="content-version-caption">Caption</label>
        <textarea id="content-version-caption" value={captionText} onChange={(e) => setCaptionText(e.target.value)} />
      </div>
      <div className="field full">
        <label htmlFor="content-version-source-url">Source URL</label>
        <input id="content-version-source-url" type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
      </div>
      <div className="field full">
        <label htmlFor="content-version-notes">Submission notes</label>
        <textarea id="content-version-notes" value={submissionNotes} onChange={(e) => setSubmissionNotes(e.target.value)} />
      </div>
      {error && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </DialogShell>
  );
}

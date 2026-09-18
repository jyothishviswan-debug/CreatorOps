"use client";

import { useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import type { ContentDto } from "@/server/content/client-dto";
import { addPublicationEvidence } from "./api-client";
import { platformLabel } from "./format";

// Step 11B: fields per the real addPublicationEvidence contract. Platform
// is a fixed, non-editable display value derived from content.platform -
// this Content record's own platform - never a free-choice field, to
// avoid inviting an evidence item that contradicts its own record.
// partnerAccountRef is only shown (as a fixed label, never a picker) when
// content.partnerAccountRef is already set - no new "choose eligible
// account" picker UI is built here. The 409 collision case (URL or
// platform content ID already claimed by another Content record) is
// handled via the server's own real message text, shown verbatim in the
// inline banner.
export function ContentPublicationDialog({
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
  const [url, setUrl] = useState("");
  const [platformContentId, setPlatformContentId] = useState("");
  const [publishedAt, setPublishedAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setUrl("");
    setPlatformContentId("");
    setPublishedAt("");
    setError(null);
  }

  function close() {
    reset();
    onClose();
  }

  const canSubmit = /^https:\/\//i.test(url.trim());

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await addPublicationEvidence(content.contentRef, {
      platform: content.platform,
      url: url.trim(),
      platformContentId: platformContentId.trim() ? platformContentId.trim() : undefined,
      partnerAccountRef: content.partnerAccountRef ?? undefined,
      publishedAt: publishedAt.trim() ? publishedAt.trim() : undefined,
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
      title="Record publication"
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={busy || !canSubmit}>
            {busy ? "Saving…" : "Record publication"}
          </button>
        </>
      }
    >
      <div className="kv">
        <span>Platform</span>
        <b>{platformLabel(content.platform)}</b>
      </div>
      {content.partnerAccountRef && content.partnerAccountLabel && (
        <div className="kv">
          <span>Account</span>
          <b>{content.partnerAccountLabel}</b>
        </div>
      )}
      <div className="field full" style={{ marginTop: 12 }}>
        <label htmlFor="content-publication-url">Published URL (required)</label>
        <input id="content-publication-url" type="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} required />
      </div>
      <div className="field full">
        <label htmlFor="content-publication-platform-id">Platform content ID</label>
        <input id="content-publication-platform-id" type="text" value={platformContentId} onChange={(e) => setPlatformContentId(e.target.value)} />
      </div>
      <div className="field full">
        <label htmlFor="content-publication-published-at">Published at</label>
        <input id="content-publication-published-at" type="date" value={publishedAt} onChange={(e) => setPublishedAt(e.target.value)} />
      </div>
      {error && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </DialogShell>
  );
}

"use client";

import { useRef, useState } from "react";

import { EmptyState } from "@/ui/States";
import type { InvoiceDetailDto } from "@/server/finance-invoices/client-dto";

import { attachInvoiceDocument } from "../api-client";
import { documentView } from "./detail-view";
import type { DetailActionVisibility } from "./detail-view";

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = reader.result as string;
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

// Step 16B section 14: the Document tab - exact original filename, MIME/type, size, content hash
// (present but not visually dominant), attached version/timestamp/uploader, and a contained local
// preview via "View document". Never a raw storage locator or signed URL - Step 16A's document
// port exposes only metadata plus a store()/get() pair with no URL surface at all, and there is no
// HTTP route yet that streams the bytes back, so "View document" only ever opens the exact bytes
// just staged in THIS browser session (an object URL of the File the person picked), not a
// server-retrieved copy. Replace is offered only on a Draft the actor may manage.
export function DocumentTab({ detail, visibility, onUpdated }: { detail: InvoiceDetailDto; visibility: DetailActionVisibility; onUpdated: (updated: InvoiceDetailDto) => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const view = documentView(detail);

  async function onFilePicked(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("Only a PDF file can be attached as the original Invoice document.");
      return;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      setError("The document is larger than 10 MB.");
      return;
    }
    setBusy(true);
    const contentBase64 = await fileToBase64(file);
    const result = await attachInvoiceDocument(detail.head.invoiceRef, { expectedDocVersion: detail.head.docVersion, fileName: file.name, contentBase64 });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setLocalPreviewUrl(URL.createObjectURL(file));
    onUpdated(result.data);
  }

  return (
    <section className="panel">
      <div className="panelhead">
        <div>
          <h2>Invoice Document</h2>
        </div>
      </div>
      <div className="panelbody">
        {error && (
          <div className="banner" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}
        {view ? (
          <>
            <div className="kv">
              <span>File name</span>
              <b>{view.fileName}</b>
            </div>
            <div className="kv">
              <span>Type</span>
              <b>{view.mimeType}</b>
            </div>
            <div className="kv">
              <span>Size</span>
              <b>{view.sizeText}</b>
            </div>
            <div className="kv">
              <span>Attached version</span>
              <b>v{view.version}</b>
            </div>
            <div className="kv">
              <span>Attached</span>
              <b>{view.storedAt}</b>
            </div>
            <div className="kv">
              <span>Uploader</span>
              <b>{view.storedBy}</b>
            </div>
            <div className="kv" style={{ opacity: 0.7 }}>
              <span>Content hash</span>
              <small style={{ fontFamily: "monospace" }}>{view.sha256.slice(0, 16)}…</small>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              {localPreviewUrl && (
                <a className="btn" href={localPreviewUrl} target="_blank" rel="noreferrer" data-testid="view-document">
                  View document
                </a>
              )}
              {visibility.canEdit && (
                <button type="button" className="btn ghost" onClick={() => fileInputRef.current?.click()} disabled={busy} data-testid="replace-document">
                  {busy ? "Replacing…" : "Replace document"}
                </button>
              )}
            </div>
            {!localPreviewUrl && <p className="foundationnote" style={{ marginTop: 10 }}>A live preview is available right after you upload or replace the file in this session.</p>}
          </>
        ) : (
          <EmptyState
            title="No document attached"
            description={visibility.canEdit ? "Attach the exact original Invoice PDF." : "No original Invoice document has been attached yet."}
            icon="file"
            action={
              visibility.canEdit ? (
                <button type="button" className="btn primary" onClick={() => fileInputRef.current?.click()} disabled={busy}>
                  {busy ? "Uploading…" : "Upload PDF"}
                </button>
              ) : undefined
            }
          />
        )}
        <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" style={{ display: "none" }} onChange={(event) => void onFilePicked(event.target.files?.[0])} aria-label="Invoice document file" />
      </div>
    </section>
  );
}

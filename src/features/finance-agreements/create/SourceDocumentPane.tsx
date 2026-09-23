"use client";

// EXECUTE_HARD_RESET Section 7: the left pane - Agreement Document. The exact uploaded source PDF only (never a
// generated replacement). A freshly-picked browser File previews via a local object URL (revoked on
// replacement/unmount); a resumed draft with no File object in memory and no authorized byte-streaming endpoint
// (confirmed not to exist in this repo) shows the file card without a live preview rather than fabricate one or
// add new backend surface to this UI-only rebuild.
import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@/ui/icons";

import { pickContractFile } from "../agreement-intake-logic/contract-source-logic";
import { formatFileSize } from "../format";

import type { AgreementDocumentView } from "./agreement-create-view";
import styles from "./AgreementCreatePage.module.css";

const STORAGE_LABEL: Record<AgreementDocumentView["storageState"], string> = {
  LOCAL_ONLY: "Uploaded",
  PENDING_DURABLE_STORAGE: "Pending durable storage",
  STORED: "Stored",
  FAILED: "Storage failed - retriable",
  NOT_CONFIGURED: "Drive storage not configured",
  NO_NEW_SIGNED_DOCUMENT: "No new signed document for this version",
};

export function SourceDocumentPane({
  document,
  canReplace,
  busy,
  onPick,
}: {
  document: AgreementDocumentView | null;
  canReplace: boolean;
  busy: boolean;
  onPick: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  return (
    <section className="panel">
      <div className="panelhead">
        <h2>Agreement Document</h2>
      </div>
      <div className="panelbody">
        {document ? (
          <div className={styles.fileRow}>
            <Icon name="file" />
            <div style={{ minWidth: 0 }}>
              <b style={{ display: "block", overflowWrap: "anywhere" }}>{document.originalFileName}</b>
              <small className="muted">
                PDF · {document.pageCount !== null ? `${document.pageCount} pages · ` : ""}
                {formatFileSize(document.sizeBytes)}
              </small>
              <div style={{ marginTop: 4 }}>
                <span className={`pill${document.storageState === "STORED" ? "" : document.storageState === "FAILED" ? " red" : " orange"}`}>{STORAGE_LABEL[document.storageState]}</span>
              </div>
            </div>
            {canReplace && (
              <button type="button" className="btn" disabled={busy} onClick={() => inputRef.current?.click()}>
                Replace
              </button>
            )}
          </div>
        ) : (
          <div className={styles.fileRow}>
            <Icon name="file" />
            <div>
              <b>No Agreement uploaded yet</b>
              <div className="muted" style={{ fontSize: 11 }}>
                Upload the signed PDF to extract its details.
              </div>
            </div>
            <button type="button" className="btn primary" disabled={busy} onClick={() => inputRef.current?.click()}>
              Upload
            </button>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          aria-label="Upload the signed Agreement PDF"
          style={{ display: "none" }}
          onChange={(event) => {
            const picked = pickContractFile(event.target.files?.[0] ?? null);
            if (picked.error) setPickError(picked.error);
            else if (picked.file) {
              setPickError(null);
              onPick(picked.file);
            }
            event.target.value = "";
          }}
        />
        {pickError && (
          <p style={{ color: "var(--red)", fontSize: 11, marginTop: 8 }}>{pickError}</p>
        )}
      </div>
      <div className={styles.preview}>
        {document?.previewUrl ? (
          <iframe title={`Preview of ${document.originalFileName}`} src={document.previewUrl} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: 24, textAlign: "center" }}>
            <span className="alerttile" style={{ width: 44, height: 44 }}>
              <Icon name="file" />
            </span>
            <b style={{ fontSize: 13 }}>{document ? "Preview unavailable in this session" : "No document yet"}</b>
            <p className="muted" style={{ fontSize: 12, maxWidth: 280 }}>
              {document ? "The signed PDF is on file, but this browser session no longer holds it in memory. Replace the file to preview it again." : "Upload the signed PDF to extract its details."}
            </p>
            {document && canReplace && (
              <button type="button" className="btn" disabled={busy} onClick={() => inputRef.current?.click()}>
                Replace file
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// Manages the local object URL lifecycle for a freshly-picked File - revoked on replacement/unmount, never leaked.
export function useLocalPreviewUrl(file: File | null): string | null {
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);
  return url;
}

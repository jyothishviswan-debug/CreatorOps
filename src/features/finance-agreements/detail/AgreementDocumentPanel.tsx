"use client";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";

import { KeyValueRow, StatusChip } from "../components";
import { buildDocumentView, STORING_TEXT, type DocumentNotice, type DocumentPanelRow } from "../document-view";
import { AGREEMENT_DOCUMENT_LABEL, DISABLED_BUTTON_STYLE, OPEN_AGREEMENT_DOCUMENT_LABEL } from "../format";

export type AgreementDocumentPanelProps = {
  rows: DocumentPanelRow[];
  // The server-computed manage permission (the store / retry button exists only with it AND the server's `canStore`).
  canManage: boolean;
  // The version whose store call is in flight (null = none). ANY lifecycle action in flight also disables the button.
  busyVersion: number | null;
  anyBusy: boolean;
  // The result of the last store / retry, announced politely.
  notice: (DocumentNotice & { version: number }) | null;
  onStore: (version: number) => void;
};

// The Overview's `Agreement document` panel: the ORIGINAL signed PDF kept once in Drive after the version is confirmed. It shows the original file name,
// the storage status and date, the `Open Agreement document` link ONLY when the server DTO carries one (a holder of the contract-detail category), and a
// `Store Agreement document` / `Retry` button only when the server says a store is meaningful (confirmed, has its own signed file, not stored) and this
// person may manage Agreements. It never presents an earlier version's file as this version's.
export function AgreementDocumentPanel({ rows, canManage, busyVersion, anyBusy, notice, onStore }: AgreementDocumentPanelProps) {
  if (rows.length === 0) return null;
  return (
    <Panel span={12}>
      <PanelHead title={AGREEMENT_DOCUMENT_LABEL} description="The original signed Agreement, kept once in Drive" />
      <PanelBody>
        <div style={{ display: "grid", gap: 14 }}>
          {rows.map((row, index) => {
            const view = buildDocumentView({ document: row.document, canManage });
            const storing = busyVersion === row.version;
            const rowNotice = notice && notice.version === row.version ? notice : null;
            return (
              <section key={row.version} aria-label={`Agreement document, version ${row.version}`} data-testid={`document-row-${row.version}`} data-document-status={view.status} style={{ minWidth: 0, ...(index > 0 ? { borderTop: "1px solid #edf0f3", paddingTop: 12 } : {}) }}>
                <KeyValueRow label={`Version ${row.version} · ${row.roleText}`}>
                  <StatusChip chip={view.chip} status={view.status} />
                </KeyValueRow>
                {view.fileName && <KeyValueRow label="Original file name">{view.fileName}</KeyValueRow>}
                {view.storedAtText && <KeyValueRow label="Stored">{view.storedAtText.replace(/^Stored /, "")}</KeyValueRow>}
                <p className="detailcopy" style={{ margin: "8px 0 0", overflowWrap: "anywhere" }}>
                  {view.headline}
                  {view.note ? ` ${view.note}` : ""}
                </p>
                {view.onFileText && <p className="foundationnote" style={{ margin: "6px 0 0" }}>{`${view.onFileText}. The link is shown to people with contract access.`}</p>}
                {(view.link || view.action) && (
                  <div className="actions" style={{ marginTop: 10, alignItems: "center" }}>
                    {view.link && (
                      <a className="btn" href={view.link} target="_blank" rel="noopener noreferrer">
                        {OPEN_AGREEMENT_DOCUMENT_LABEL}
                        <span className="sr"> (opens in a new tab)</span>
                      </a>
                    )}
                    {view.action && (
                      <button
                        type="button"
                        className={view.action.kind === "store" ? "btn primary" : "btn"}
                        disabled={anyBusy}
                        aria-disabled={anyBusy}
                        aria-label={`${view.action.label}, version ${row.version}`}
                        style={anyBusy ? DISABLED_BUTTON_STYLE : undefined}
                        onClick={() => onStore(row.version)}
                        data-testid={`document-store-${row.version}`}
                      >
                        {storing ? view.action.busyLabel : view.action.label}
                      </button>
                    )}
                  </div>
                )}
                <div role="status" aria-live="polite" style={{ marginTop: rowNotice || storing ? 8 : 0 }}>
                  {storing && <span className="foundationnote">{STORING_TEXT}</span>}
                  {!storing && rowNotice && (
                    <div className="banner" style={{ margin: 0 }} data-tone={rowNotice.tone}>
                      {rowNotice.text}
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </PanelBody>
    </Panel>
  );
}

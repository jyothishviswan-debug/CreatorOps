import type { CounterpartyAgreementDocumentsDto } from "@/server/finance-agreements/client-dto";

import { buildCounterpartyDocumentRows } from "../document-view";
import { AGREEMENT_DOCUMENT_LABEL, OPEN_AGREEMENT_DOCUMENT_LABEL } from "../format";
import { StatusChip } from "./StatusChip";

// Step 14B.1: the signed Agreement documents of ONE Partner / Vendor, listed inside the accepted contextual areas of the Partner detail (Context tab,
// Finance tile) and the Vendor detail (Agreements panel). It renders the server projection AS IT IS: the same stored file the Finance detail shows (one
// physical file, several controlled references) - never a copy.
//   - `Open Agreement document` appears ONLY on a row whose projection carries the link (a holder of the contract-detail category); everyone else the
//     server let this far sees a neutral `Agreement document on file` with no link;
//   - a version without a signed file of its own says `No new signed document for this version`, never the prior file;
//   - the page passes this data only to an actor who holds the Finance feature (profile access alone never reaches it), so nothing is exposed otherwise.
// Presentational and server-renderable: no state, no fetch.
export function AgreementDocumentList({ documents }: { documents: CounterpartyAgreementDocumentsDto }) {
  const rows = buildCounterpartyDocumentRows(documents.documents);
  return (
    <div data-testid="agreement-documents" style={{ marginTop: 12, minWidth: 0 }}>
      <b style={{ fontSize: 12 }}>{AGREEMENT_DOCUMENT_LABEL}</b>
      {rows.length === 0 ? (
        <p className="detailcopy" style={{ margin: "6px 0 0" }}>
          No Agreement document yet.
        </p>
      ) : (
        <ul aria-label="Agreement documents" style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "grid", gap: 10 }}>
          {rows.map((row) => (
            <li key={row.key} data-testid="agreement-document-row" style={{ minWidth: 0, overflowWrap: "anywhere", borderTop: "1px solid #edf0f3", paddingTop: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 12 }}>{row.title}</div>
              <small style={{ display: "block", color: "var(--muted)" }}>{row.metaText}</small>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 4 }}>
                {row.chip && <StatusChip chip={row.chip} />}
                {row.note && <small>{row.note}</small>}
                {row.link && (
                  <a className="textlink" href={row.link} target="_blank" rel="noopener noreferrer">
                    {OPEN_AGREEMENT_DOCUMENT_LABEL}
                    <span className="sr"> (opens in a new tab)</span>
                  </a>
                )}
                {row.onFileText && <small>{row.onFileText}</small>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {documents.hasMore && (
        <p className="foundationnote" style={{ margin: "8px 0 0" }}>
          Showing the most recent documents only. Open Finance Agreements for the full list.
        </p>
      )}
    </div>
  );
}

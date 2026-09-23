import type { PayableDetailDto } from "@/server/finance-payables/client-dto";

import { agreementEvidenceSection, performanceTargetsSection, reviewEvidenceSection, warningsList } from "../create/create-view";

// Step 15B: Payable detail - Source evidence tab. Compact provenance sections: Agreement evidence,
// Partner Review evidence when applicable, performance targets (monitoring only), warnings. No raw
// contract text dump, no KYC/bank/PAN/Aadhaar - the snapshot itself never carries them (see
// src/server/finance-payables/types.ts's own guarantee).
export function SourceEvidenceTab({ detail }: { detail: PayableDetailDto }) {
  const snapshot = detail.selectedVersion?.snapshot ?? null;
  if (!snapshot) {
    return (
      <section className="panel">
        <div className="panelbody">
          <p className="foundationnote">No source evidence available for this version.</p>
        </div>
      </section>
    );
  }

  const agreementSection = agreementEvidenceSection(snapshot);
  const reviewSection = reviewEvidenceSection(snapshot);
  const targetsSection = performanceTargetsSection(snapshot);
  const warnings = warningsList(snapshot);

  return (
    <div className="grid">
      <section className="panel s6">
        <div className="panelhead">
          <div>
            <h2>{agreementSection.title}</h2>
          </div>
        </div>
        <div className="panelbody">
          {agreementSection.rows.map((row) => (
            <div className="kv" key={row.label}>
              <span>{row.label}</span>
              <b>{row.value}</b>
            </div>
          ))}
        </div>
      </section>

      {reviewSection && (
        <section className="panel s6">
          <div className="panelhead">
            <div>
              <h2>{reviewSection.title}</h2>
            </div>
          </div>
          <div className="panelbody">
            {reviewSection.rows.map((row) => (
              <div className="kv" key={row.label}>
                <span>{row.label}</span>
                <b>{row.value}</b>
              </div>
            ))}
          </div>
        </section>
      )}

      {targetsSection && (
        <section className="panel s6">
          <div className="panelhead">
            <div>
              <h2>{targetsSection.title}</h2>
            </div>
          </div>
          <div className="panelbody">
            {targetsSection.rows.map((row) => (
              <div className="kv" key={row.label}>
                <span>{row.label}</span>
                <b>{row.value}</b>
              </div>
            ))}
          </div>
        </section>
      )}

      {warnings.length > 0 && (
        <section className="panel s6">
          <div className="panelhead">
            <div>
              <h2>Warnings</h2>
            </div>
          </div>
          <div className="panelbody">
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: "var(--muted)" }}>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}

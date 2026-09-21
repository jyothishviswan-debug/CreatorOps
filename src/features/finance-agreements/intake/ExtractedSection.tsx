"use client";

// Step 14B intake, section 4 `Extracted from Agreement`: the extractor's PROPOSALS, kept visibly apart from anything decided.
// Every row says `Needs confirmation`; nothing here is accepted, nothing is styled as accepted, and this section has no action that
// accepts a value (a value becomes part of the Agreement only through the decision controls of the sections below). Identity values the
// actor may not see are masked; raw contract text appears only when the server allowed it.
import { ConfidenceBadge } from "../components/ConfidenceBadge";
import { MaskedValue } from "../components/MaskedValue";
import { StatusChip } from "../components/StatusChip";
import { buildExtractionRows } from "../field-view-model";
import { NEEDS_CONFIRMATION_LABEL, NO_VALUE_TEXT } from "../format";
import { useIntake } from "./intake-context";
import { SectionCard } from "./SectionCard";

const WRAP = { whiteSpace: "normal", overflowWrap: "anywhere", minWidth: 0 } as const;

export function ExtractedSection() {
  const { extraction, extractionAttached, flags } = useIntake();
  const rows = extraction ? buildExtractionRows(extraction) : [];

  return (
    <SectionCard sectionKey="extracted" description="Values the reader found in the Agreement. They are proposals only - none of them is accepted until you decide it.">
      {!extraction && <p className="foundationnote">Nothing has been extracted yet. Use Extract from Agreement above to see proposed values here.</p>}
      {extraction && rows.length === 0 && <p className="foundationnote">No values could be proposed from this Agreement. Enter the terms in the sections below.</p>}

      {rows.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
            <StatusChip label={NEEDS_CONFIRMATION_LABEL} tone="orange" />
            <small className="muted">
              {rows.length} proposed {rows.length === 1 ? "value" : "values"}
              {extractionAttached ? " · added to the draft as pending" : flags.canExtract ? " · not yet added to the draft" : ""}
            </small>
          </div>
          <div className="tablewrap" style={{ border: "1px solid var(--line)", borderRadius: 8 }} data-testid="extraction-grid">
            <table className="compact">
              <caption className="sr">Values proposed from the Agreement. Each needs your confirmation.</caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Proposed value</th>
                  <th scope="col">Confidence</th>
                  <th scope="col">Page</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.fieldKey} data-field={row.fieldKey}>
                    <th scope="row" style={{ ...WRAP, background: "transparent", border: 0, borderBottom: "1px solid #edf0f3", color: "var(--ink)", fontWeight: 550, fontSize: 11, padding: "8px 18px", textAlign: "left" }}>
                      {row.label}
                    </th>
                    <td style={{ ...WRAP, maxWidth: 360 }}>
                      <MaskedValue restricted={row.restricted} value={row.valueText} />
                      {row.needsMappingLabel && (
                        <div style={{ marginTop: 4 }}>
                          <StatusChip label={row.needsMappingLabel} tone="orange" />
                        </div>
                      )}
                      {row.snippet && (
                        <details style={{ marginTop: 4 }}>
                          <summary style={{ fontSize: 10, cursor: "pointer" }}>Contract text</summary>
                          <p className="foundationnote" style={{ margin: "4px 0 0", overflowWrap: "anywhere" }}>
                            {row.snippet}
                          </p>
                        </details>
                      )}
                    </td>
                    <td>
                      <ConfidenceBadge confidence={row.confidence} />
                    </td>
                    <td>{row.page ?? NO_VALUE_TEXT}</td>
                    <td style={WRAP}>
                      <StatusChip label={row.needsConfirmationLabel} tone="orange" />
                      {row.hasWarnings && (
                        <div style={{ marginTop: 4, fontSize: 10, color: "#80623f" }}>
                          <span aria-hidden="true">⚠ </span>
                          <span className="sr">Warning: </span>
                          {row.warnings.join(" ")}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  );
}

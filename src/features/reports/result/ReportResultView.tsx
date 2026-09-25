import Link from "next/link";

import { Icon } from "@/ui/icons";
import type { ReportDefinitionDto } from "@/server/reports";
import type { ReportProvenanceEntry, ReportScopeSummary } from "@/server/reports/types";

import { cellDrilldownHref, formatCellValue, formatDateTime, formatMetricValue, humanizeKey } from "../copy";

export type ReportResultLike = {
  generatedAt: string;
  evidenceCutoff: string;
  appliedFilters: Record<string, string>;
  scopeSummary: ReportScopeSummary;
  metrics: Record<string, number | string | null>;
  sections: Record<string, unknown>;
  limitations: string[];
  truncated: boolean;
  rowCount: number;
  maxRows: number;
  provenance?: ReportProvenanceEntry[];
};

export type ReportResultViewProps = {
  definition: ReportDefinitionDto;
  result: ReportResultLike;
  viewerSafe: boolean;
};

// Step 19B: the ONE honest renderer for a governed ReportResult - live full run, live viewer-safe
// run, and a re-opened finalized snapshot all pass through this exact component (see
// src/app/reports/snapshots/[snapshotRef]/page.tsx). Every value shown is read straight off the
// server's own result; nothing here recomputes, sums, or substitutes a value the server did not
// already provide - see AGENTS/spec section "Semantics that must remain visible and honest".
export function ReportResultView({ definition, result, viewerSafe }: ReportResultViewProps) {
  const evidenceDiffers = result.generatedAt !== result.evidenceCutoff;

  return (
    <div data-testid="report-result">
      <div className="detailcontext" data-testid="report-result-freshness">
        <div>
          <small>Generated</small>
          <b>{formatDateTime(result.generatedAt)}</b>
        </div>
        <div>
          <small>Evidence cutoff{evidenceDiffers ? " (older than the read)" : ""}</small>
          <b>{formatDateTime(result.evidenceCutoff)}</b>
        </div>
        <div>
          <small>Rows returned</small>
          <b>
            {result.rowCount} of max {result.maxRows}
          </b>
        </div>
        <div>
          <small>Scope</small>
          <b>{result.scopeSummary.basis}</b>
        </div>
      </div>

      {result.truncated && (
        <div className="banner" role="status" data-testid="report-truncated-banner">
          <Icon name="alert" />
          <span>
            <b>This result was truncated.</b> {result.rowCount} row(s) of at most {result.maxRows} are shown - a larger scope exists than this bounded run can return in one pass.
          </span>
        </div>
      )}

      <section className="panel" style={{ marginBottom: 18 }}>
        <div className="panelhead">
          <div>
            <h2>Scope</h2>
            <p>{result.scopeSummary.note}</p>
          </div>
        </div>
        <div className="panelbody">
          <div className="kv">
            <span>Applied filters</span>
            <b>
              {definition.supportedFilters.length === 0
                ? "None (no filters supported)"
                : definition.supportedFilters
                    .map((f) => `${f.label.replace(/\s*\(required\)\s*/i, "")}: ${result.appliedFilters[f.id] ?? "not set"}`)
                    .join(" · ")}
            </b>
          </div>
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 18 }} data-testid="report-metrics-panel">
        <div className="panelhead">
          <div>
            <h2>Metrics</h2>
            <p>Every figure is exactly what the server computed - a missing value is shown as &quot;Not available&quot;, never 0.</p>
          </div>
        </div>
        <div className="panelbody">
          <div className="kpis" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))" }}>
            {definition.metrics.map((metric) => {
              const raw = result.metrics[metric.id];
              const isMissing = raw === undefined || raw === null;
              return (
                <div className="kpi" key={metric.id} data-testid="report-metric" data-metric-id={metric.id} title={metric.meaning}>
                  <div className="kpi-top">{metric.label}</div>
                  <div className="value" style={isMissing ? { fontSize: 16, color: "var(--muted)" } : undefined}>
                    {raw === undefined ? "Not available" : formatMetricValue(raw)}
                  </div>
                  {isMissing && metric.unavailableMeaning && (
                    <div className="trend" style={{ color: "var(--muted)" }}>
                      {metric.unavailableMeaning}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {definition.sections.map((sectionDef) => {
        const raw = result.sections[sectionDef.id];
        // A section's value is genuinely `unknown` server-side (ReportResult.sections is
        // Record<string, unknown>) - most families project a flat, scalar-only ReportRow[], but at
        // least one (operations_attention) passes its raw source DTOs straight through instead. Only
        // an array of plain objects is ever rendered as a table; anything else (or a malformed shape)
        // shows the same honest "no rows" note rather than guessing at a layout.
        const rows: Record<string, unknown>[] = Array.isArray(raw) ? raw.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r)) : [];
        return (
          <section className="panel" style={{ marginBottom: 18 }} key={sectionDef.id} data-testid="report-section" data-section-id={sectionDef.id}>
            <div className="panelhead">
              <div>
                <h2>{sectionDef.title}</h2>
              </div>
            </div>
            {rows.length === 0 ? (
              <div className="panelbody">
                <p className="foundationnote">No rows for this section in this run.</p>
              </div>
            ) : (
              <ReportSectionTable rows={rows} />
            )}
          </section>
        );
      })}

      <section className="panel" style={{ marginBottom: 18 }} data-testid="report-limitations-panel">
        <div className="panelhead">
          <div>
            <h2>Limitations</h2>
            <p>Always shown - never buried, never silently dropped.</p>
          </div>
        </div>
        <div className="panelbody">
          <ul className="checklist">
            {result.limitations.map((limitation, i) => (
              <li key={i}>
                <Icon name="alert" />
                <span>{limitation}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="panel" data-testid="report-provenance-panel">
        <div className="panelhead">
          <div>
            <h2>Provenance</h2>
            {viewerSafe && <p>Hidden on the viewer-safe view - provenance detail is only included on a full run.</p>}
          </div>
        </div>
        <div className="panelbody">
          {viewerSafe ? (
            <p className="foundationnote">Not shown for a viewer-safe run.</p>
          ) : !result.provenance || result.provenance.length === 0 ? (
            <p className="foundationnote">No source reads recorded for this run.</p>
          ) : (
            <div className="tablewrap">
              <table className="compact">
                <caption className="sr">Provenance</caption>
                <thead>
                  <tr>
                    <th scope="col">Source module</th>
                    <th scope="col">Function</th>
                    <th scope="col">Records</th>
                  </tr>
                </thead>
                <tbody>
                  {result.provenance.map((p, i) => (
                    <tr key={i}>
                      <td>{p.sourceModule}</td>
                      <td>{p.sourceFunction}</td>
                      <td>
                        {p.recordCount}
                        {p.scanned !== undefined ? ` (of ${p.scanned} scanned)` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ReportSectionTable({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  return (
    <div className="tablewrap">
      <table className="compact">
        <caption className="sr">Report section rows</caption>
        <thead>
          <tr>
            {columns.map((col) => (
              <th scope="col" key={col}>
                {humanizeKey(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((col) => {
                const value = row[col] ?? null;
                const href = cellDrilldownHref(col, value);
                return (
                  <td key={col}>
                    {href ? (
                      <Link href={href} data-testid="report-row-drilldown">
                        {formatCellValue(value)}
                      </Link>
                    ) : (
                      formatCellValue(value)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";

import { Pill } from "@/ui/Badge";

import { classificationLabel, outcomeLabel, outcomeTone } from "./copy";
import type { ImportRunResult } from "./types";

// Finding #59: the ONE row-level outcome/detail table, shared by the
// wizard's Review/Results steps AND the History detail panel
// (ImportHistoryPanel.tsx) - previously defined only inside
// ImportCenterWizard.tsx, so History could never show it at all. Reusing
// this component (not reimplementing it) is what keeps the "why did this
// row end up this way" explanation identical everywhere it's shown.

export function CountsSummary({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  if (entries.length === 0) return <p className="foundationnote">No rows counted.</p>;
  return (
    <div className="fields">
      {entries.map(([key, count]) => (
        <div className="field" key={key}>
          <Pill tone={outcomeTone(key)}>
            {outcomeLabel(key) !== key ? outcomeLabel(key) : classificationLabel(key)}: {count}
          </Pill>
        </div>
      ))}
    </div>
  );
}

export function RowsTable({ rows, rowsTruncated }: { rows: NonNullable<ImportRunResult["rows"]>; rowsTruncated?: boolean }) {
  const [filter, setFilter] = useState<string | null>(null);
  const outcomes = useMemo(() => [...new Set(rows.map((r) => r.outcome))], [rows]);
  const visible = filter ? rows.filter((r) => r.outcome === filter) : rows;

  if (rows.length === 0) return <p className="foundationnote">No row-level detail to show.</p>;

  return (
    <div>
      <div className="toolbar" role="group" aria-label="Filter rows by outcome">
        <button type="button" className={filter === null ? "btn primary" : "btn"} onClick={() => setFilter(null)}>
          All ({rows.length})
        </button>
        {outcomes.map((outcome) => (
          <button key={outcome} type="button" className={filter === outcome ? "btn primary" : "btn"} onClick={() => setFilter(outcome)}>
            {outcomeLabel(outcome) !== outcome ? outcomeLabel(outcome) : classificationLabel(outcome)} ({rows.filter((r) => r.outcome === outcome).length})
          </button>
        ))}
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Sheet</th>
              <th>Row</th>
              <th>Outcome</th>
              <th>Identity</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => (
              <tr key={`${row.sheetName}-${row.sourceRowNumber}-${i}`}>
                <td>{row.sheetName}</td>
                <td>{row.sourceRowNumber}</td>
                <td>
                  <Pill tone={outcomeTone(row.outcome)}>{outcomeLabel(row.outcome) !== row.outcome ? outcomeLabel(row.outcome) : classificationLabel(row.outcome)}</Pill>
                </td>
                <td>{row.identityLabel ?? "—"}</td>
                <td>{row.detail ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rowsTruncated && <p className="foundationnote">Showing a bounded sample of rows - the counts above cover every row in the file.</p>}
    </div>
  );
}

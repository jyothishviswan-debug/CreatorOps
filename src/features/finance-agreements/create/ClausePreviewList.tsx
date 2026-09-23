"use client";

// EXECUTE_HARD_RESET Section 11: key clauses as Label | concise summary rows - never full contract prose in a
// narrow cell. A long clause shows a wrapped 2-4 line preview with "View full clause", not a clipped string.
import { useState } from "react";

import type { KeyClauseView } from "./agreement-create-view";
import styles from "./AgreementCreatePage.module.css";

export function ClausePreviewList({ clauses, onEdit }: { clauses: readonly KeyClauseView[]; onEdit: (key: string) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (clauses.length === 0) return null;

  return (
    <section className="panel">
      <div className="panelhead">
        <h2>Key clauses</h2>
      </div>
      <div className="panelbody" style={{ paddingTop: 0 }}>
        {clauses.map((clause) => {
          const isOpen = expanded.has(clause.key);
          return (
            <div key={clause.key} className={styles.clauseRow}>
              <div>
                <b style={{ fontSize: 12 }}>{clause.label}</b>
              </div>
              <div className={styles.clauseValue}>
                <p style={{ fontSize: 12, margin: 0, display: "-webkit-box", WebkitLineClamp: isOpen ? "unset" : 4, WebkitBoxOrient: "vertical", overflow: isOpen ? "visible" : "hidden" }}>{clause.summary}</p>
                {clause.sourcePage !== null && (
                  <small className="muted" style={{ display: "block", marginTop: 4 }}>
                    Source page {clause.sourcePage}
                  </small>
                )}
                <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
                  {clause.fullText && (
                    <button
                      type="button"
                      className={styles.optOutBtn}
                      onClick={() => setExpanded((prev) => (prev.has(clause.key) ? new Set([...prev].filter((k) => k !== clause.key)) : new Set([...prev, clause.key])))}
                    >
                      {isOpen ? "Show less" : "View full clause"}
                    </button>
                  )}
                  <button type="button" className={styles.optOutBtn} onClick={() => onEdit(clause.key)}>
                    Edit
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

"use client";

// EXECUTE_HARD_RESET Section 9: the same compact tab treatment already accepted elsewhere in CreatorOps
// (`.tabsbar`/`.tabs`/`.tab` in foundation.css) - never a nested sidebar. Proper tablist/tabpanel semantics
// (Section 24).
import { useId, useState } from "react";

import { reviewTabOf } from "./agreement-create-adapter";
import type { ExtractedFieldView, ReviewTabKey } from "./agreement-create-view";
import { ClausePreviewList } from "./ClausePreviewList";
import { KeyInformationGrid } from "./KeyInformationGrid";
import type { AgreementPartyView, KeyClauseView } from "./agreement-create-view";

const TABS: Array<{ key: ReviewTabKey; label: string }> = [
  { key: "summary", label: "Summary" },
  { key: "parties", label: "Parties" },
  { key: "commercial", label: "Commercial" },
  { key: "content", label: "Content & Platforms" },
  { key: "targets", label: "Targets" },
  { key: "other", label: "Other" },
];

export function ReviewTabs({
  fields,
  keyClauses,
  primaryParty,
  platforms,
  onEditField,
}: {
  fields: readonly ExtractedFieldView[];
  keyClauses: readonly KeyClauseView[];
  primaryParty: AgreementPartyView | null;
  platforms: string[];
  onEditField: (key: string) => void;
}) {
  const [active, setActive] = useState<ReviewTabKey>("summary");
  const baseId = useId();
  const grouped = new Map<ReviewTabKey, ExtractedFieldView[]>();
  for (const field of fields) {
    const tab = reviewTabOf(field.key);
    if (!grouped.has(tab)) grouped.set(tab, []);
    grouped.get(tab)!.push(field);
  }
  const countFor = (key: ReviewTabKey) => (key === "summary" ? null : (grouped.get(key)?.length ?? 0));

  return (
    <div>
      <div className="tabsbar">
        <div className="tabs" role="tablist" aria-label="Extraction review">
          {TABS.map((tab) => {
            const count = countFor(tab.key);
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                id={`${baseId}-tab-${tab.key}`}
                aria-selected={active === tab.key}
                aria-controls={`${baseId}-panel-${tab.key}`}
                className={`tab${active === tab.key ? " active" : ""}`}
                onClick={() => setActive(tab.key)}
              >
                {tab.label}
                {count !== null && count > 0 ? ` (${count})` : ""}
              </button>
            );
          })}
        </div>
      </div>

      <div id={`${baseId}-panel-${active}`} role="tabpanel" aria-labelledby={`${baseId}-tab-${active}`}>
        {active === "summary" && (
          <>
            <KeyInformationGrid fields={fields} primaryParty={primaryParty} platforms={platforms} onEditAll={() => setActive("commercial")} />
            <ClausePreviewList clauses={keyClauses} onEdit={onEditField} />
          </>
        )}
        {active !== "summary" && (
          <section className="panel">
            <div className="panelbody">
              {(grouped.get(active) ?? []).length === 0 ? (
                <p className="muted">Nothing extracted for this tab yet.</p>
              ) : (
                <div className="recordgrid" style={{ padding: 0 }}>
                  {(grouped.get(active) ?? []).map((field) => (
                    <div key={field.key} className="record">
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <b style={{ fontSize: 12 }}>{field.label}</b>
                        {field.requiresDecision && <span className="pill orange">Needs decision</span>}
                      </div>
                      <p style={{ fontSize: 12, margin: "6px 0 0" }}>{field.displayValue ?? "—"}</p>
                      {field.warning && (
                        <small style={{ color: "var(--orange)", display: "block", marginTop: 4 }}>{field.warning}</small>
                      )}
                      {field.sourcePage !== null && (
                        <small className="muted" style={{ display: "block", marginTop: 4 }}>
                          Source page {field.sourcePage}
                          {field.confidence !== "HIGH" && field.confidence !== "UNKNOWN" ? ` · Confidence: ${field.confidence.charAt(0)}${field.confidence.slice(1).toLowerCase()}` : ""}
                        </small>
                      )}
                      <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => onEditField(field.key)}>
                        Edit
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

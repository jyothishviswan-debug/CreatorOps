"use client";

import { useState } from "react";

import { Pill } from "@/ui/Badge";
import { EmptyState } from "@/ui/States";
import type { ReportSectionModel } from "@/server/reports/report-sections/types";
import type { ReportNarrativeSectionKey, ReportTemplateDefinition } from "@/server/reports";

import {
  artifactDownloadUrl,
  createDraftRun,
  finalizeRun,
  getRunDetail,
  listRunArtifacts,
  listRunVersions,
  runDraftEvidence,
  saveRunNarrative,
  submitRunForReview,
  supersedeRun,
  type ReportsApiResult,
} from "../api-client";
import { NARRATIVE_SECTION_LABELS } from "@/server/reports/report-templates";
import type { ReportRunDetailDto } from "@/server/reports";
import type { ReportArtifactDoc, ReportVersionSummary } from "@/server/reports";

export type PublishWorkspaceProps = { templates: ReportTemplateDefinition[] };

function errorText(result: Extract<ReportsApiResult<unknown>, { ok: false }>): string {
  return result.message;
}

function SectionView({ section }: { section: ReportSectionModel }) {
  if (section.kind === "cover") {
    return (
      <div className="panel" data-testid="section-cover" style={{ background: "var(--ink, #0f1728)", color: "#fff" }}>
        <div className="eyebrow" style={{ color: "var(--orange, #d96b14)" }}>
          CREATOROPS
        </div>
        <h2 style={{ color: "#fff" }}>{section.title}</h2>
        <p>{section.subtitle}</p>
        <p>{section.scopeLine}</p>
        <p>{section.periodLine}</p>
        <p>{section.generatedAtLine}</p>
        <p>{section.evidenceCutoffLine}</p>
      </div>
    );
  }
  if (section.kind === "kpi_summary" || section.kind === "kpi_cards") {
    const items = section.kind === "kpi_summary" ? section.items : section.cards;
    return (
      <section className="panel" data-testid="section-kpi">
        <h3>{section.title}</h3>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {items.map((item, i) => (
            <div key={`${i}-${item.label}`} style={{ padding: 10, background: "#fdf1e4", borderRadius: 6, minWidth: 160 }}>
              <div style={{ fontSize: 12, color: "#666" }}>{item.label}</div>
              <div style={{ fontWeight: 700 }}>{item.unavailable ? "Not available" : item.value}</div>
            </div>
          ))}
        </div>
      </section>
    );
  }
  if (section.kind === "table") {
    return (
      <section className="panel" data-testid="section-table">
        <h3>{section.title}</h3>
        {section.note && <p className="foundationnote">{section.note}</p>}
        {section.unavailableReason ? (
          <EmptyState title="Not available" description={section.unavailableReason} icon="table" />
        ) : section.rows.length === 0 ? (
          <EmptyState title="No rows" description={section.emptyMessage ?? "No rows in this run."} icon="table" />
        ) : (
          <table>
            <thead>
              <tr>
                {section.columns.map((c) => (
                  <th key={c.id}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row, i) => (
                <tr key={i}>
                  {section.columns.map((c) => (
                    <td key={c.id}>{String(row[c.id] ?? "Not available")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    );
  }
  if (section.kind === "data_quality") {
    return (
      <section className="panel" data-testid="section-data-quality">
        <h3>{section.title}</h3>
        <ul>
          {section.items.map((item, i) => (
            <li key={`${i}-${item.label}`}>
              <b>{item.label}:</b> {item.unavailable ? "Not available" : item.value}
            </li>
          ))}
        </ul>
        {section.warnings.length > 0 && (
          <>
            <b>Limitations & disclosures</b>
            <ul>
              {section.warnings.map((w, i) => (
                <li key={`${i}-${w}`}>{w}</li>
              ))}
            </ul>
          </>
        )}
      </section>
    );
  }
  // narrative
  return (
    <section className="panel" data-testid="section-narrative">
      <h3>
        {section.title} {section.reviewStatus && <Pill tone="gray">{section.reviewStatus}</Pill>}
      </h3>
      <p style={{ whiteSpace: "pre-wrap" }}>{section.body || "(No narrative written yet.)"}</p>
    </section>
  );
}

export function PublishWorkspace({ templates }: PublishWorkspaceProps) {
  const [templateId, setTemplateId] = useState<string>(templates[0]?.templateId ?? "");
  const [run, setRun] = useState<ReportRunDetailDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [narrativeDrafts, setNarrativeDrafts] = useState<Record<string, string>>({});
  const [artifacts, setArtifacts] = useState<ReportArtifactDoc[] | null>(null);
  const [versions, setVersions] = useState<ReportVersionSummary[] | null>(null);

  async function refresh(runRef: string, version?: number) {
    const result = await getRunDetail(runRef, version);
    if (result.ok) setRun(result.data);
    else setError(errorText(result));
  }

  async function handleCreateDraft() {
    setBusy(true);
    setError(null);
    const result = await createDraftRun(templateId, {});
    if (result.ok) {
      setRun(result.data);
      setArtifacts(null);
      setVersions(null);
      setNarrativeDrafts({});
    } else setError(errorText(result));
    setBusy(false);
  }

  async function handleRunEvidence() {
    if (!run) return;
    setBusy(true);
    setError(null);
    const result = await runDraftEvidence(run.runRef, run.headDocVersion);
    if (result.ok) setRun(result.data);
    else setError(errorText(result));
    setBusy(false);
  }

  async function handleSaveNarrative(sectionKey: ReportNarrativeSectionKey) {
    if (!run) return;
    setBusy(true);
    setError(null);
    const existing = run.version.narrativePointers[sectionKey];
    const body = narrativeDrafts[sectionKey] ?? existing?.body ?? "";
    const result = await saveRunNarrative(run.runRef, { version: run.version.version, sectionKey, body, expectedRevision: existing?.revision ?? 0 });
    if (result.ok) setRun(result.data);
    else setError(errorText(result));
    setBusy(false);
  }

  async function handleSubmitForReview() {
    if (!run) return;
    setBusy(true);
    setError(null);
    const result = await submitRunForReview(run.runRef, run.headDocVersion);
    if (result.ok) setRun(result.data);
    else setError(errorText(result));
    setBusy(false);
  }

  async function handleFinalize() {
    if (!run) return;
    setBusy(true);
    setError(null);
    const result = await finalizeRun(run.runRef, run.headDocVersion);
    if (result.ok) {
      setRun(result.data);
      const artifactsResult = await listRunArtifacts(result.data.runRef, result.data.version.version);
      if (artifactsResult.ok) setArtifacts(artifactsResult.data);
    } else setError(errorText(result));
    setBusy(false);
  }

  async function handleLoadVersionHistory() {
    if (!run) return;
    const result = await listRunVersions(run.runRef);
    if (result.ok) setVersions(result.data);
    else setError(errorText(result));
  }

  async function handleSupersede() {
    if (!run) return;
    setBusy(true);
    setError(null);
    const result = await supersedeRun(run.runRef, run.headDocVersion);
    if (result.ok) {
      setRun(result.data);
      setArtifacts(null);
    } else setError(errorText(result));
    setBusy(false);
  }

  const template = templates.find((t) => t.templateId === templateId);

  return (
    <div data-testid="publish-workspace">
      {!run && (
        <section className="panel">
          <h2>1. Choose a report template</h2>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} data-testid="template-select">
            {templates.map((t) => (
              <option key={t.templateId} value={t.templateId}>
                {t.title} ({t.treatment})
              </option>
            ))}
          </select>
          {template && <p className="foundationnote">{template.referencePattern}</p>}
          <button className="btn" disabled={busy} onClick={handleCreateDraft} data-testid="create-draft-button">
            Create draft
          </button>
        </section>
      )}

      {error && (
        <section className="panel" data-testid="publish-error">
          <EmptyState title="Something went wrong" description={error} icon="alert" />
        </section>
      )}

      {run && (
        <>
          <section className="panel" data-testid="run-status">
            <h2>
              {run.templateTitle} - Version {run.version.version} <Pill tone={run.version.status === "FINALIZED" ? "blue" : run.version.status === "IN_REVIEW" ? "orange" : "gray"}>{run.version.status}</Pill>
            </h2>
            <p className="foundationnote">Run ref: {run.runRef}</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {(run.version.status === "DRAFT" || run.version.status === "IN_REVIEW") && (
                <button className="btn" disabled={busy} onClick={handleRunEvidence} data-testid="run-evidence-button">
                  {run.version.hasEvidence ? "Re-run evidence" : "Run evidence"}
                </button>
              )}
              {run.version.status === "DRAFT" && run.version.hasEvidence && (
                <button className="btn" disabled={busy} onClick={handleSubmitForReview} data-testid="submit-review-button">
                  Submit for review
                </button>
              )}
              {run.version.status === "IN_REVIEW" && (
                <button className="btn" disabled={busy} onClick={handleFinalize} data-testid="finalize-button">
                  Finalize
                </button>
              )}
              {run.currentFinalizedVersion !== null && run.openVersion === null && (
                <button className="btn" disabled={busy} onClick={handleSupersede} data-testid="supersede-button">
                  Create correcting version
                </button>
              )}
              <button className="btn" disabled={busy} onClick={handleLoadVersionHistory} data-testid="version-history-button">
                Version history
              </button>
            </div>
          </section>

          {run.version.requiredNarrativeSectionKeys.length > 0 && run.version.status !== "FINALIZED" && run.version.status !== "SUPERSEDED" && (
            <section className="panel" data-testid="narrative-editor">
              <h3>Narrative</h3>
              {run.version.requiredNarrativeSectionKeys.map((key) => {
                const sectionKey = key as ReportNarrativeSectionKey;
                const pointer = run.version.narrativePointers[sectionKey];
                return (
                  <div key={key} style={{ marginBottom: 14 }}>
                    <label>
                      {NARRATIVE_SECTION_LABELS[sectionKey] ?? key} {pointer && <Pill tone="gray">rev {pointer.revision}</Pill>}
                    </label>
                    <textarea
                      style={{ width: "100%", minHeight: 80 }}
                      defaultValue={pointer?.body ?? ""}
                      onChange={(e) => setNarrativeDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
                      data-testid={`narrative-textarea-${key}`}
                    />
                    <button className="btn" disabled={busy} onClick={() => handleSaveNarrative(sectionKey)} data-testid={`narrative-save-${key}`}>
                      Save
                    </button>
                  </div>
                );
              })}
            </section>
          )}

          <h3>Evidence Preview</h3>
          {run.version.sections.map((section, i) => (
            <SectionView key={i} section={section} />
          ))}

          {artifacts && artifacts.length > 0 && (
            <section className="panel" data-testid="artifacts-list">
              <h3>Artifacts</h3>
              <ul>
                {artifacts.map((a) => (
                  <li key={a.artifactRef}>
                    <a href={artifactDownloadUrl(a.artifactRef)} data-testid={`artifact-download-${a.format}`}>
                      {a.safeFilename}
                    </a>{" "}
                    ({a.format.toUpperCase()}, {a.byteSize} bytes)
                  </li>
                ))}
              </ul>
            </section>
          )}

          {versions && (
            <section className="panel" data-testid="version-history-list">
              <h3>Version History</h3>
              <ul>
                {versions.map((v) => (
                  <li key={v.version}>
                    <button className="btn" onClick={() => refresh(run.runRef, v.version)}>
                      Version {v.version} - {v.status}
                    </button>
                    {v.supersededByVersion !== null && ` (superseded by version ${v.supersededByVersion})`}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

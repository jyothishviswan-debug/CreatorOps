"use client";

import { useMemo, useState } from "react";

import { Pill } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Icon } from "@/ui/icons";
import { EmptyState, Skeleton } from "@/ui/States";
import type { ExportJobDto, ExportPreviewDto, ExportTargetDto } from "@/server/exports";
import { useMounted } from "@/features/shared/use-mounted";

import { createExportJob, exportArtifactDownloadUrl, listExportJobs, previewExportJob, retryExportJob, type ExportsApiResult } from "../api-client";

// serverNowIso: production-hardening fix (base spec section 26) - see TasksWorkspace.tsx's own
// comment on this exact prop for the full rationale (a server-computed, hydration-safe "now" for
// isPastExpiry below, refreshed to the live client clock only after mount).
export type ExportsWorkspaceProps = {
  targets: ExportTargetDto[];
  canCreateExports: boolean;
  initialJobs: ExportJobDto[];
  serverNowIso: string;
};

type CreateState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "done"; job: ExportJobDto };
type PreviewState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "done"; preview: ExportPreviewDto };
type RetryState = { status: "idle" } | { status: "loading"; jobRef: string } | { status: "error"; jobRef: string; message: string };

const FILTER_TYPE_HINT: Record<string, string> = {
  text: "Exact or partial value",
  status: "e.g. ACTIVE",
  region: "e.g. Kerala",
  platform: "e.g. instagram or youtube",
};

// A FIXED locale (never the runtime default) - matches src/features/reports/copy.ts's own
// formatDateTime exactly. Node's SSR pass and the browser's hydration pass can otherwise resolve
// different default locales/time formats for the same Date, which produces a real React hydration
// mismatch (found and fixed during Export Center's own live-browser verification).
const DATE_LOCALE = "en-GB";

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(DATE_LOCALE, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function isPastExpiry(expiresAt: string | null, nowIso: string): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  const now = Date.parse(nowIso);
  return Number.isFinite(t) && Number.isFinite(now) && t < now;
}

function statusTone(status: ExportJobDto["status"]): "default" | "orange" | "blue" | "purple" | "red" | "gray" {
  if (status === "COMPLETED") return "default";
  if (status === "FAILED") return "red";
  return "blue";
}

// A job may be retried/regenerated once it has reached a terminal state - never while it is still
// PENDING/GENERATING (section 14).
function canRetry(job: ExportJobDto): boolean {
  return job.status === "COMPLETED" || job.status === "FAILED";
}

// The governed export-generation surface: choose a target from the server's own catalog, configure
// filters/columns/format (all validated again server-side - this form is only a convenience, never the
// authority), preview real bounded sample rows, generate a job, and review/download/retry from history.
// Every number/state here comes straight from the server; this component computes nothing about scope,
// authorization, or row counts of its own.
export function ExportsWorkspace({ targets, canCreateExports, initialJobs, serverNowIso }: ExportsWorkspaceProps) {
  const mounted = useMounted();
  const nowIso = mounted ? new Date().toISOString() : serverNowIso;
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [format, setFormat] = useState<string>("");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(new Set());
  const [previewState, setPreviewState] = useState<PreviewState>({ status: "idle" });
  const [createState, setCreateState] = useState<CreateState>({ status: "idle" });

  const [jobs, setJobs] = useState<ExportJobDto[]>(initialJobs);
  const [jobsRefreshing, setJobsRefreshing] = useState(false);
  const [retryState, setRetryState] = useState<RetryState>({ status: "idle" });
  const [historyTargetFilter, setHistoryTargetFilter] = useState<string>("");
  const [historyStatusFilter, setHistoryStatusFilter] = useState<string>("");

  const selectedTarget = targets.find((t) => t.targetId === selectedTargetId) ?? null;

  // Section 4/16's target-switch clearing discipline (the exact bug class fixed in Import Center's own
  // History panel - see ImportHistoryPanel.tsx): every piece of state that describes the PREVIOUS
  // target's configuration/preview/result is cleared SYNCHRONOUSLY, in the same tick as the selection
  // change - never left rendered underneath the new target's panel while anything async resolves.
  function selectTarget(target: ExportTargetDto) {
    setSelectedTargetId(target.targetId);
    setFormat(target.allowedFormats[0] ?? "csv");
    setFilterValues({});
    setSelectedColumns(new Set(target.defaultColumnIds));
    setPreviewState({ status: "idle" });
    setCreateState({ status: "idle" });
  }

  function toggleColumn(id: string) {
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllColumns() {
    if (!selectedTarget) return;
    setSelectedColumns(new Set(selectedTarget.columns.map((c) => c.id)));
  }

  function resetToRecommendedColumns() {
    if (!selectedTarget) return;
    setSelectedColumns(new Set(selectedTarget.defaultColumnIds));
  }

  async function refreshJobs() {
    setJobsRefreshing(true);
    const result = await listExportJobs(undefined);
    if (result.ok) setJobs(result.data);
    setJobsRefreshing(false);
  }

  function buildRequest() {
    if (!selectedTarget) return null;
    const filters = Object.fromEntries(Object.entries(filterValues).filter(([, v]) => v.trim().length > 0));
    const columns = selectedTarget.columns.map((c) => c.id).filter((id) => selectedColumns.has(id));
    return { targetId: selectedTarget.targetId, format, columns, filters };
  }

  async function handlePreview() {
    const request = buildRequest();
    if (!request) return;
    if (selectedColumns.size === 0) {
      setPreviewState({ status: "error", message: "Select at least one column." });
      return;
    }
    setPreviewState({ status: "loading" });
    const result = await previewExportJob(request);
    if (!result.ok) {
      setPreviewState({ status: "error", message: result.message });
      return;
    }
    setPreviewState({ status: "done", preview: result.data });
  }

  async function handleCreate() {
    const request = buildRequest();
    if (!request) return;
    if (selectedColumns.size === 0) {
      setCreateState({ status: "error", message: "Select at least one column." });
      return;
    }
    setCreateState({ status: "loading" });
    const result: ExportsApiResult<ExportJobDto> = await createExportJob(request);
    if (!result.ok) {
      setCreateState({ status: "error", message: result.message });
      return;
    }
    setCreateState({ status: "done", job: result.data });
    setJobs((prev) => [result.data, ...prev]);
  }

  async function handleRetry(jobRef: string) {
    setRetryState({ status: "loading", jobRef });
    const result = await retryExportJob(jobRef);
    if (!result.ok) {
      setRetryState({ status: "error", jobRef, message: result.message });
      return;
    }
    setRetryState({ status: "idle" });
    setJobs((prev) => [result.data, ...prev]);
  }

  // History filtering is entirely client-side over the actor's own already-fetched job list (never a
  // second server round-trip per filter change) - this sidesteps the "stale rows from the previous
  // selection linger under a new denial/empty state" bug class by construction: there is no async gap
  // between changing a filter and the list updating, so there is nothing to clear-before-fetch.
  const filteredJobs = useMemo(
    () =>
      jobs.filter((job) => {
        if (historyTargetFilter && job.targetId !== historyTargetFilter) return false;
        if (historyStatusFilter && job.status !== historyStatusFilter) return false;
        return true;
      }),
    [jobs, historyTargetFilter, historyStatusFilter],
  );

  return (
    <>
      {/* Section 3/20: a compact, continuous workflow - target grid, configuration, preview and job
          history all render together on one page (never gated behind a tab a Playwright/real user has
          to switch to first), matching this module's own established flagship-journey shape. */}
      <section className="panel" style={{ marginBottom: 18 }}>
            <div className="panelhead">
              <div>
                <h2>1. Choose a target</h2>
                <p>Every export starts from one of these server-governed targets - each with its own allowed columns, filters and sensitivity notes.</p>
              </div>
            </div>
            <div className="panelbody">
              <div className="recordgrid" data-testid="export-target-grid">
                {targets.map((target) => (
                  <article className={`record${selectedTargetId === target.targetId ? " selected" : ""}`} key={target.targetId} data-testid="export-target-card" data-target-id={target.targetId}>
                    <b>{target.title}</b>
                    <p className="foundationnote" style={{ margin: "8px 0 12px" }}>
                      {target.description}
                    </p>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                      {target.allowedFormats.map((f) => (
                        <Pill tone="blue" key={f}>
                          {f.toUpperCase()}
                        </Pill>
                      ))}
                    </div>
                    <div className="recordmeta">
                      <span>Bounded to {target.maxRows} rows</span>
                      <span>
                        {target.columns.length} column{target.columns.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <p className="foundationnote" style={{ margin: "8px 0 0" }}>
                      {target.recordScopeNote}
                    </p>
                    <div style={{ marginTop: 12 }}>
                      <Button variant={selectedTargetId === target.targetId ? "primary" : "default"} style={{ width: "100%" }} onClick={() => selectTarget(target)} data-testid="select-export-target">
                        <Icon name="table" />
                        {selectedTargetId === target.targetId ? "Selected" : "Configure export"}
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>

          {selectedTarget && !canCreateExports && (
            <section className="panel" style={{ marginBottom: 18 }}>
              <EmptyState title="You can view Export Center but not create exports" description="Ask an administrator for the create_exports permission if you believe this is wrong." icon="lock" />
            </section>
          )}

          {selectedTarget && canCreateExports && (
            <section className="panel" style={{ marginBottom: 18 }} data-testid="export-configure-panel">
              <div className="panelhead">
                <div>
                  <h2>2. Filters, columns &amp; format - {selectedTarget.title}</h2>
                  <p>{selectedTarget.recordScopeNote}</p>
                </div>
              </div>
              <div className="panelbody">
                <div className="fields">
                  <div className="field">
                    <label htmlFor="export-format-select">Format</label>
                    <select id="export-format-select" aria-label="Format" value={format} onChange={(e) => setFormat(e.target.value)} data-testid="export-format-select">
                      {selectedTarget.allowedFormats.map((f) => (
                        <option key={f} value={f}>
                          {f.toUpperCase()}
                        </option>
                      ))}
                    </select>
                  </div>
                  {selectedTarget.supportedFilters.map((filter) => (
                    <div className="field" key={filter.id}>
                      <label htmlFor={`export-filter-${filter.id}`}>{filter.label}</label>
                      <input
                        id={`export-filter-${filter.id}`}
                        type="text"
                        aria-label={filter.label}
                        placeholder={FILTER_TYPE_HINT[filter.type] ?? ""}
                        value={filterValues[filter.id] ?? ""}
                        maxLength={200}
                        onChange={(e) => setFilterValues((prev) => ({ ...prev, [filter.id]: e.target.value }))}
                        data-testid={`export-filter-${filter.id}`}
                      />
                      <small>{FILTER_TYPE_HINT[filter.type] ?? ""}</small>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                    <label style={{ fontWeight: 600 }}>Columns</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <Button variant="ghost" onClick={selectAllColumns} data-testid="export-columns-select-all">
                        Select all safe columns
                      </Button>
                      <Button variant="ghost" onClick={resetToRecommendedColumns} data-testid="export-columns-reset">
                        Reset to recommended
                      </Button>
                    </div>
                  </div>
                  <div className="checklist" data-testid="export-columns-list">
                    {selectedTarget.columns.map((col) => (
                      <label key={col.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <input type="checkbox" checked={selectedColumns.has(col.id)} onChange={() => toggleColumn(col.id)} data-testid={`export-column-${col.id}`} />
                        {col.label}
                        {selectedTarget.defaultColumnIds.includes(col.id) && (
                          <span style={{ marginLeft: 4 }}>
                            <Pill tone="gray">recommended</Pill>
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                </div>

                {selectedTarget.limitations.length > 0 && (
                  <div className="scopebox" style={{ marginTop: 16 }} data-testid="export-limitations">
                    {selectedTarget.limitations.map((l, i) => (
                      <p key={i} style={{ margin: i === 0 ? 0 : "6px 0 0" }}>
                        {l}
                      </p>
                    ))}
                  </div>
                )}
              </div>
              <div className="panelfoot">
                <span>
                  {selectedColumns.size} column{selectedColumns.size === 1 ? "" : "s"} selected
                </span>
                <div className="actions">
                  <Button variant="default" onClick={handlePreview} disabled={previewState.status === "loading"} data-testid="preview-export-button">
                    <Icon name="clock" />
                    {previewState.status === "loading" ? "Loading preview…" : "3. Preview"}
                  </Button>
                  <Button variant="primary" onClick={handleCreate} disabled={createState.status === "loading"} data-testid="create-export-button">
                    <Icon name="download" />
                    {createState.status === "loading" ? "Generating…" : "4. Generate export"}
                  </Button>
                </div>
              </div>

              {previewState.status === "error" && (
                <div className="banner" role="alert" style={{ margin: "0 20px 16px" }} data-testid="export-preview-error">
                  <Icon name="alert" />
                  <span>{previewState.message}</span>
                </div>
              )}

              {previewState.status === "done" && (
                <div className="panelbody" data-testid="export-preview-result" style={{ borderTop: "1px solid var(--border, #e2e2e2)" }}>
                  <h3 style={{ marginTop: 0 }}>Preview - sample data, not a final artifact</h3>
                  <div className="recordmeta" style={{ marginBottom: 10 }}>
                    <span>
                      {previewState.preview.matchedRowCount} matching row{previewState.preview.matchedRowCount === 1 ? "" : "s"}
                      {previewState.preview.wouldExceedMaxRows ? ` (capped at ${previewState.preview.maxRows} - see warning below)` : ""}
                    </span>
                    <span>Showing {previewState.preview.sampleRowCount} sample rows</span>
                  </div>
                  {previewState.preview.warnings.map((w, i) => (
                    <div className="banner" role="status" key={i} style={{ marginBottom: 10 }} data-testid="export-preview-warning">
                      <Icon name="alert" />
                      <span>{w}</span>
                    </div>
                  ))}
                  {previewState.preview.sampleRows.length > 0 ? (
                    <div className="tablewrap">
                      <table>
                        <caption className="sr">Preview sample rows</caption>
                        <thead>
                          <tr>
                            {previewState.preview.columns.map((c) => (
                              <th scope="col" key={c.id}>
                                {c.label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {previewState.preview.sampleRows.map((row, i) => (
                            <tr key={i}>
                              {previewState.preview.columns.map((c) => (
                                <td key={c.id}>{row[c.id] === null || row[c.id] === undefined ? "—" : String(row[c.id])}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <EmptyState title="No matching rows" description="Adjust the filters above and preview again." icon="table" />
                  )}
                </div>
              )}

              {createState.status === "error" && (
                <div className="banner" role="alert" style={{ margin: "0 20px 16px" }} data-testid="export-create-error">
                  <Icon name="alert" />
                  <span>{createState.message}</span>
                </div>
              )}
              {createState.status === "done" && (
                <div className="banner" role="status" style={{ margin: "0 20px 16px" }} data-testid="export-create-success">
                  <Icon name="check" />
                  <span>
                    {createState.job.status === "COMPLETED" && "Export ready. See Job history below to download."}
                    {createState.job.status === "FAILED" && `Export failed: ${createState.job.errorMessage ?? "Please try again."}`}
                    {(createState.job.status === "PENDING" || createState.job.status === "GENERATING") && "Export is generating - check Job history below shortly."}
                    {createState.job.status === "COMPLETED" && createState.job.truncated && " This file is capped at the target's row maximum and is marked truncated."}
                  </span>
                </div>
              )}
            </section>
          )}

      <section className="panel" data-testid="export-job-history">
          <div className="panelhead">
            <div>
              <h2>Job history</h2>
              <p>Your own export jobs only - never another user&apos;s.</p>
            </div>
            <Button variant="ghost" onClick={refreshJobs} disabled={jobsRefreshing}>
              <Icon name="clock" />
              {jobsRefreshing ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
          <div className="panelbody">
            <div className="fields" style={{ marginBottom: 16 }}>
              <div className="field">
                <label htmlFor="export-history-target-filter">Target</label>
                <select id="export-history-target-filter" value={historyTargetFilter} onChange={(e) => setHistoryTargetFilter(e.target.value)} data-testid="export-history-target-filter">
                  <option value="">All targets</option>
                  {targets.map((t) => (
                    <option key={t.targetId} value={t.targetId}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="export-history-status-filter">Status</label>
                <select id="export-history-status-filter" value={historyStatusFilter} onChange={(e) => setHistoryStatusFilter(e.target.value)} data-testid="export-history-status-filter">
                  <option value="">All statuses</option>
                  {["PENDING", "GENERATING", "COMPLETED", "FAILED"].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {filteredJobs.length === 0 ? (
              <EmptyState title="No exports match" description={jobs.length === 0 ? "Choose a target in Build export and create your first export." : "Try a different target/status filter."} icon="download" />
            ) : (
              <div className="tablewrap" data-testid="export-jobs-table">
                <table>
                  <caption className="sr">Your export job history</caption>
                  <thead>
                    <tr>
                      <th scope="col">Target</th>
                      <th scope="col">Format</th>
                      <th scope="col">Status</th>
                      <th scope="col">Requested at</th>
                      <th scope="col">Rows</th>
                      <th scope="col">Expires</th>
                      <th scope="col">
                        <span className="sr">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredJobs.map((job) => {
                      const expired = isPastExpiry(job.expiresAt, nowIso);
                      const downloadable = job.hasArtifact && !expired;
                      return (
                        <tr key={job.jobRef} data-testid="export-job-row" data-job-ref={job.jobRef} data-job-status={job.status}>
                          <td>{targets.find((t) => t.targetId === job.targetId)?.title ?? job.targetId}</td>
                          <td>{job.format.toUpperCase()}</td>
                          <td>
                            <Pill tone={statusTone(job.status)}>{job.status}</Pill>
                            {job.status === "FAILED" && job.errorMessage && (
                              <small style={{ display: "block" }} data-testid="export-job-error">
                                {job.errorMessage}
                              </small>
                            )}
                            {job.retryOfJobRef && (
                              <small style={{ display: "block" }} className="foundationnote">
                                Retry of a previous export
                              </small>
                            )}
                          </td>
                          <td>{formatDateTime(job.createdAt)}</td>
                          <td>
                            {job.rowCount !== null ? job.rowCount : "—"}
                            {job.truncated ? " (truncated)" : ""}
                          </td>
                          <td data-testid="export-job-expiry">
                            {job.expiresAt ? (
                              <span className={expired ? "foundationnote" : undefined}>
                                {expired ? "Expired" : formatDateTime(job.expiresAt)}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {downloadable ? (
                              <a className="btn" href={exportArtifactDownloadUrl(job.jobRef)} data-testid="download-export-artifact">
                                <Icon name="download" />
                                Download
                              </a>
                            ) : (
                              <span className="foundationnote">{expired ? "Expired" : job.status === "FAILED" ? "Unavailable" : "Not ready"}</span>
                            )}
                            {canCreateExports && canRetry(job) && (
                              <Button variant="ghost" onClick={() => handleRetry(job.jobRef)} disabled={retryState.status === "loading" && retryState.jobRef === job.jobRef} data-testid="retry-export-job">
                                {retryState.status === "loading" && retryState.jobRef === job.jobRef ? "Retrying…" : job.status === "FAILED" ? "Retry" : "Regenerate"}
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {retryState.status === "error" && (
              <div className="banner" role="alert" style={{ marginTop: 12 }} data-testid="export-retry-error">
                <Icon name="alert" />
                <span>{retryState.message}</span>
              </div>
            )}
            {jobsRefreshing && <Skeleton lines={2} />}
          </div>
        </section>
    </>
  );
}

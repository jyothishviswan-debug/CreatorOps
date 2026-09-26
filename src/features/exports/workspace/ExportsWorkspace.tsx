"use client";

import { useState } from "react";

import { Pill } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Icon } from "@/ui/icons";
import { EmptyState, Skeleton } from "@/ui/States";
import type { ExportJobDto, ExportTargetDto } from "@/server/exports";

import { createExportJob, exportArtifactDownloadUrl, listExportJobs, type ExportsApiResult } from "../api-client";

export type ExportsWorkspaceProps = {
  targets: ExportTargetDto[];
  canCreateExports: boolean;
  initialJobs: ExportJobDto[];
};

type CreateState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "done"; job: ExportJobDto };

const FILTER_TYPE_HINT: Record<string, string> = {
  text: "Exact or partial value",
  status: "e.g. ACTIVE",
  region: "e.g. Kerala",
  platform: "e.g. instagram or youtube",
};

// A FIXED locale (never the runtime default) - matches src/features/reports/copy.ts's own
// formatDateTime exactly. Node's SSR pass and the browser's hydration pass can otherwise resolve
// different default locales/time formats for the same Date, which produces a real React hydration
// mismatch (found and fixed during this stage's own live-browser verification).
const DATE_LOCALE = "en-GB";

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(DATE_LOCALE, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function statusTone(status: ExportJobDto["status"]): "default" | "orange" | "blue" | "purple" | "red" | "gray" {
  if (status === "COMPLETED") return "default";
  if (status === "FAILED") return "red";
  return "blue";
}

// The governed export-generation surface: choose a target from the server's own catalog, choose a
// supported format, choose allowed columns/filters (all validated again server-side - this form is
// only a convenience, never the authority), create a job, and watch job history. Every number/state
// here comes straight from the server; this component computes nothing about scope or authorization.
export function ExportsWorkspace({ targets, canCreateExports, initialJobs }: ExportsWorkspaceProps) {
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [format, setFormat] = useState<string>("");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(new Set());
  const [createState, setCreateState] = useState<CreateState>({ status: "idle" });
  const [jobs, setJobs] = useState<ExportJobDto[]>(initialJobs);
  const [jobsRefreshing, setJobsRefreshing] = useState(false);

  const selectedTarget = targets.find((t) => t.targetId === selectedTargetId) ?? null;

  function selectTarget(target: ExportTargetDto) {
    setSelectedTargetId(target.targetId);
    setFormat(target.allowedFormats[0] ?? "csv");
    setFilterValues({});
    setSelectedColumns(new Set(target.defaultColumnIds));
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

  async function refreshJobs() {
    setJobsRefreshing(true);
    const result = await listExportJobs(undefined);
    if (result.ok) setJobs(result.data);
    setJobsRefreshing(false);
  }

  async function handleCreate() {
    if (!selectedTarget) return;
    if (selectedColumns.size === 0) {
      setCreateState({ status: "error", message: "Select at least one column." });
      return;
    }
    setCreateState({ status: "loading" });
    const filters = Object.fromEntries(Object.entries(filterValues).filter(([, v]) => v.trim().length > 0));
    const columns = selectedTarget.columns.map((c) => c.id).filter((id) => selectedColumns.has(id));
    const result: ExportsApiResult<ExportJobDto> = await createExportJob({ targetId: selectedTarget.targetId, format, columns, filters });
    if (!result.ok) {
      setCreateState({ status: "error", message: result.message });
      return;
    }
    setCreateState({ status: "done", job: result.data });
    setJobs((prev) => [result.data, ...prev]);
  }

  return (
    <>
      <section className="panel" style={{ marginBottom: 18 }}>
        <div className="panelhead">
          <div>
            <h2>Export targets</h2>
            <p>Every export starts from one of these server-governed targets - each with its own allowed columns and filters.</p>
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
                  <Pill tone="gray">{target.sourceModule}</Pill>
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
              <h2>Configure - {selectedTarget.title}</h2>
              <p>{selectedTarget.recordScopeNote}</p>
            </div>
          </div>
          <div className="panelbody">
            <div className="fields">
              <div className="field">
                <label>Format</label>
                <select aria-label="Format" value={format} onChange={(e) => setFormat(e.target.value)} data-testid="export-format-select">
                  {selectedTarget.allowedFormats.map((f) => (
                    <option key={f} value={f}>
                      {f.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
              {selectedTarget.supportedFilters.map((filter) => (
                <div className="field" key={filter.id}>
                  <label>{filter.label}</label>
                  <input
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
              <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Columns</label>
              <div className="checklist" data-testid="export-columns-list">
                {selectedTarget.columns.map((col) => (
                  <label key={col.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <input type="checkbox" checked={selectedColumns.has(col.id)} onChange={() => toggleColumn(col.id)} data-testid={`export-column-${col.id}`} />
                    {col.label}
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
            <span>{selectedColumns.size} column{selectedColumns.size === 1 ? "" : "s"} selected</span>
            <div className="actions">
              <Button variant="primary" onClick={handleCreate} disabled={createState.status === "loading"} data-testid="create-export-button">
                <Icon name="download" />
                {createState.status === "loading" ? "Creating…" : "Create export"}
              </Button>
            </div>
          </div>
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
                {createState.job.status === "COMPLETED" && "Export ready. See it in Job history below."}
                {createState.job.status === "FAILED" && `Export failed: ${createState.job.errorMessage ?? "Please try again."}`}
                {(createState.job.status === "PENDING" || createState.job.status === "GENERATING") && "Export is generating - check Job history below shortly."}
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
          {jobs.length === 0 ? (
            <EmptyState title="No exports yet" description="Choose a target above and create your first export." icon="download" />
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
                    <th scope="col">
                      <span className="sr">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
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
                      </td>
                      <td>{formatDateTime(job.createdAt)}</td>
                      <td>
                        {job.rowCount !== null ? job.rowCount : "—"}
                        {job.truncated ? " (truncated)" : ""}
                      </td>
                      <td>
                        {job.hasArtifact ? (
                          <a className="btn" href={exportArtifactDownloadUrl(job.jobRef)} data-testid="download-export-artifact">
                            <Icon name="download" />
                            Download
                          </a>
                        ) : (
                          <span className="foundationnote">{job.status === "FAILED" ? "Unavailable" : "Not ready"}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {jobsRefreshing && <Skeleton lines={2} />}
        </div>
      </section>
    </>
  );
}

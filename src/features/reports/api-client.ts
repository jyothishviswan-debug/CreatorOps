import type { ReportArtifactDoc, ReportDefinitionDto, ReportFilterFieldDef, ReportId, ReportResultDto, ReportRunDetailDto, ReportSnapshotDoc, ReportTemplateDefinition, ReportVersionSummary } from "@/server/reports";

export type ReportTemplateWithFilters = ReportTemplateDefinition & { supportedFilters: ReportFilterFieldDef[] };

// NOTE: every /api/reports/snapshots** route (list/get/finalize) currently serializes the raw
// ReportSnapshotDoc returned by snapshot-service.ts's own functions directly - none of them apply
// client-dto.ts's own `toReportSnapshotDto` conversion (that export appears unused by any route as
// of Step 19A). The two shapes are otherwise identical except the Dto omits `provenance` - since the
// browser actually receives the full doc (provenance included), this client types snapshot responses
// as ReportSnapshotDoc to match real wire behavior rather than the narrower, seemingly-unused Dto
// type. Flagged in the Step 19B completion report as an observation, not changed here (server code).

// Step 19B: typed browser-side fetch wrappers for every /api/reports/** route this UI calls,
// mirroring src/features/operations/api-client.ts's own contract exactly (never throws; a
// discriminated result; `kind` is a closed set the UI can switch over). This is the ONLY way a
// Reports screen talks to the server - no report execution, filtering, or metric derivation ever
// happens in the browser.

export type ReportsApiErrorKind = "unauthorized" | "forbidden" | "not_found" | "invalid" | "unsupported" | "source_unavailable" | "size_exceeded" | "network" | "error";
export type ReportsApiSuccess<T> = { ok: true; status: number; data: T };
export type ReportsApiFailure = { ok: false; status: number; kind: ReportsApiErrorKind; message: string; aborted?: true };
export type ReportsApiResult<T> = ReportsApiSuccess<T> | ReportsApiFailure;
export type ReportsRequestOptions = { signal?: AbortSignal };

export const REPORTS_DENIED_MESSAGE = "You do not have access to this.";
export const REPORTS_NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";
export const REPORTS_GENERIC_ERROR_MESSAGE = "Something went wrong.";

function kindForStatus(status: number): ReportsApiErrorKind {
  if (status === 0) return "network";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400) return "invalid";
  if (status === 501) return "unsupported";
  if (status === 424) return "source_unavailable";
  if (status === 409) return "size_exceeded";
  return "error";
}

async function send<T>(url: string, init: { method: "GET" | "POST"; json?: unknown; signal?: AbortSignal }): Promise<ReportsApiResult<T>> {
  if (init.signal?.aborted) return { ok: false, status: 0, kind: "network", message: "The request was cancelled.", aborted: true };
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const response = await fetch(url, { method: init.method, headers, body, signal: init.signal, cache: "no-store" });
    if (response.ok) {
      try {
        return { ok: true, status: response.status, data: (await response.json()) as T };
      } catch {
        return { ok: false, status: response.status, kind: "error", message: "Unexpected response from the server." };
      }
    }
    let message: string | undefined;
    try {
      const parsed = (await response.json()) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      // No JSON body.
    }
    const kind = kindForStatus(response.status);
    const text = kind === "unauthorized" || kind === "forbidden" ? REPORTS_DENIED_MESSAGE : message?.trim() || REPORTS_GENERIC_ERROR_MESSAGE;
    return { ok: false, status: response.status, kind, message: text };
  } catch {
    return { ok: false, status: 0, kind: "network", message: REPORTS_NETWORK_MESSAGE };
  }
}

function queryString(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

const getJson = <T>(url: string, options?: ReportsRequestOptions) => send<T>(url, { method: "GET", signal: options?.signal });
const postJson = <T>(url: string, json: unknown, options?: ReportsRequestOptions) => send<T>(url, { method: "POST", json, signal: options?.signal });

// --- Catalog --------------------------------------------------------------------------------------
export function listReportCatalog(options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportDefinitionDto[]>> {
  return getJson(`/api/reports`, options);
}

export function getReportDefinitionDto(reportId: ReportId, options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportDefinitionDto>> {
  return getJson(`/api/reports/${encodeURIComponent(reportId)}`, options);
}

// --- Execution --------------------------------------------------------------------------------------
export type RunReportFilters = Record<string, string>;

export function runReportFull(reportId: ReportId, filters: RunReportFilters, options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportResultDto>> {
  return postJson(`/api/reports/${encodeURIComponent(reportId)}/run`, { filters }, options);
}

export function runReportViewerSafe(reportId: ReportId, filters: RunReportFilters, options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportResultDto>> {
  return postJson(`/api/reports/${encodeURIComponent(reportId)}/viewer-run`, { filters }, options);
}

// --- Finalized snapshots -----------------------------------------------------------------------------
export function finalizeReportRun(reportId: ReportId, filters: RunReportFilters, options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportSnapshotDoc>> {
  return postJson(`/api/reports/finalize`, { reportId, filters }, options);
}

export function listMySnapshots(limit: number | undefined, options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportSnapshotDoc[]>> {
  return getJson(`/api/reports/snapshots${queryString({ limit })}`, options);
}

export function getSnapshotDto(snapshotRef: string, options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportSnapshotDoc>> {
  return getJson(`/api/reports/snapshots/${encodeURIComponent(snapshotRef)}`, options);
}

// --- Reports Final-Master: the publication lifecycle -------------------------------------------------
export function listReportTemplates(options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportTemplateWithFilters[]>> {
  return getJson(`/api/reports/templates`, options);
}

export function createDraftRun(templateId: string, filters: RunReportFilters, options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportRunDetailDto>> {
  return postJson(`/api/reports/runs`, { templateId, filters }, options);
}

export function getRunDetail(runRef: string, version: number | undefined, options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportRunDetailDto>> {
  return getJson(`/api/reports/runs/${encodeURIComponent(runRef)}${queryString({ version })}`, options);
}

export function runDraftEvidence(runRef: string, expectedDocVersion: number, options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportRunDetailDto>> {
  return postJson(`/api/reports/runs/${encodeURIComponent(runRef)}/evidence`, { expectedDocVersion }, options);
}

export function saveRunNarrative(runRef: string, input: { version: number; sectionKey: string; title?: string; body: string; expectedRevision: number }, options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportRunDetailDto>> {
  return postJson(`/api/reports/runs/${encodeURIComponent(runRef)}/narrative`, input, options);
}

export function submitRunForReview(runRef: string, expectedDocVersion: number, options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportRunDetailDto>> {
  return postJson(`/api/reports/runs/${encodeURIComponent(runRef)}/submit-review`, { expectedDocVersion }, options);
}

export function finalizeRun(runRef: string, expectedDocVersion: number, options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportRunDetailDto>> {
  return postJson(`/api/reports/runs/${encodeURIComponent(runRef)}/finalize`, { expectedDocVersion }, options);
}

export function supersedeRun(runRef: string, expectedDocVersion: number, options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportRunDetailDto>> {
  return postJson(`/api/reports/runs/${encodeURIComponent(runRef)}/supersede`, { expectedDocVersion }, options);
}

export function listRunVersions(runRef: string, options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportVersionSummary[]>> {
  return getJson(`/api/reports/runs/${encodeURIComponent(runRef)}/versions`, options);
}

export function listRunArtifacts(runRef: string, version: number, options?: ReportsRequestOptions): Promise<ReportsApiResult<ReportArtifactDoc[]>> {
  return getJson(`/api/reports/runs/${encodeURIComponent(runRef)}/artifacts${queryString({ version })}`, options);
}

export function artifactDownloadUrl(artifactRef: string): string {
  return `/api/reports/artifacts/${encodeURIComponent(artifactRef)}/download`;
}

import type { ExportJobDto, ExportPreviewDto, ExportTargetDto } from "@/server/exports";

// Typed browser-side fetch wrappers for every /api/exports/** route this UI calls, mirroring
// src/features/reports/api-client.ts's own contract exactly (never throws; a discriminated result).
// This is the ONLY way an Export Center screen talks to the server - no target execution, column
// selection, or file generation ever happens in the browser.

export type ExportsApiErrorKind = "unauthorized" | "forbidden" | "not_found" | "invalid" | "unsupported" | "source_unavailable" | "size_exceeded" | "expired" | "network" | "error";
export type ExportsApiSuccess<T> = { ok: true; status: number; data: T };
export type ExportsApiFailure = { ok: false; status: number; kind: ExportsApiErrorKind; message: string; aborted?: true };
export type ExportsApiResult<T> = ExportsApiSuccess<T> | ExportsApiFailure;
export type ExportsRequestOptions = { signal?: AbortSignal };

export const EXPORTS_DENIED_MESSAGE = "You do not have access to this.";
export const EXPORTS_NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";
export const EXPORTS_GENERIC_ERROR_MESSAGE = "Something went wrong.";

function kindForStatus(status: number): ExportsApiErrorKind {
  if (status === 0) return "network";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400) return "invalid";
  if (status === 501) return "unsupported";
  if (status === 424) return "source_unavailable";
  if (status === 409) return "size_exceeded";
  if (status === 410) return "expired";
  return "error";
}

async function send<T>(url: string, init: { method: "GET" | "POST"; json?: unknown; signal?: AbortSignal }): Promise<ExportsApiResult<T>> {
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
    const text = kind === "unauthorized" || kind === "forbidden" ? EXPORTS_DENIED_MESSAGE : message?.trim() || EXPORTS_GENERIC_ERROR_MESSAGE;
    return { ok: false, status: response.status, kind, message: text };
  } catch {
    return { ok: false, status: 0, kind: "network", message: EXPORTS_NETWORK_MESSAGE };
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

const getJson = <T>(url: string, options?: ExportsRequestOptions) => send<T>(url, { method: "GET", signal: options?.signal });
const postJson = <T>(url: string, json: unknown, options?: ExportsRequestOptions) => send<T>(url, { method: "POST", json, signal: options?.signal });

// --- Catalog --------------------------------------------------------------------------------------
export function listExportTargets(options?: ExportsRequestOptions): Promise<ExportsApiResult<ExportTargetDto[]>> {
  return getJson(`/api/exports`, options);
}

// --- Jobs --------------------------------------------------------------------------------------------
export type CreateExportJobInput = { targetId: string; format: string; columns?: string[]; filters?: Record<string, string> };

export function createExportJob(input: CreateExportJobInput, options?: ExportsRequestOptions): Promise<ExportsApiResult<ExportJobDto>> {
  return postJson(`/api/exports/jobs`, input, options);
}

export function listExportJobs(limit: number | undefined, options?: ExportsRequestOptions): Promise<ExportsApiResult<ExportJobDto[]>> {
  return getJson(`/api/exports/jobs${queryString({ limit })}`, options);
}

export function getExportJob(jobRef: string, options?: ExportsRequestOptions): Promise<ExportsApiResult<ExportJobDto>> {
  return getJson(`/api/exports/jobs/${encodeURIComponent(jobRef)}`, options);
}

export function retryExportJob(jobRef: string, options?: ExportsRequestOptions): Promise<ExportsApiResult<ExportJobDto>> {
  return postJson(`/api/exports/jobs/${encodeURIComponent(jobRef)}/retry`, {}, options);
}

export function exportArtifactDownloadUrl(jobRef: string): string {
  return `/api/exports/jobs/${encodeURIComponent(jobRef)}/artifact`;
}

// --- Preview (section 8) ----------------------------------------------------------------------------
export type PreviewExportJobInput = { targetId: string; format: string; columns?: string[]; filters?: Record<string, string> };

export function previewExportJob(input: PreviewExportJobInput, options?: ExportsRequestOptions): Promise<ExportsApiResult<ExportPreviewDto>> {
  return postJson(`/api/exports/preview`, input, options);
}

import type { ClassifiedImportError, ImportFilePreviewResult, ImportRunResult } from "./types";

// Import Center Completion - the client's own thin fetch layer, same
// idiom as reports/api-client.ts and operations/api-client.ts. Every
// error response is already a ClassifiedImportError (or, for the
// still-bespoke Analytics routes, a plain `{error: string}` - normalized
// here into the same shape so the UI never special-cases which route it
// called).

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ClassifiedImportError };

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const commaIndex = result.indexOf(",");
      resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

function normalizeErrorBody(body: unknown, status: number): ClassifiedImportError {
  if (body && typeof body === "object" && "error" in body) {
    const raw = (body as { error: unknown }).error;
    if (raw && typeof raw === "object" && "category" in raw && "code" in raw && "message" in raw) return raw as ClassifiedImportError;
    if (typeof raw === "string") {
      return { category: status === 401 || status === 403 ? "AUTHORIZATION" : "SYSTEM", code: status === 401 || status === 403 ? "ACTION_PERMISSION_DENIED" : "REQUEST_FAILED", message: raw, correctable: status < 500 };
    }
  }
  return { category: "SYSTEM", code: "UNCLASSIFIED_SYSTEM_ERROR", message: `Request failed (${status}).`, correctable: false };
}

async function postJson<T>(path: string, payload: Record<string, unknown>): Promise<ApiResult<T>> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const body = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, error: normalizeErrorBody(body, response.status) };
  return { ok: true, data: body as T };
}

export async function previewImportFile(file: File): Promise<ApiResult<ImportFilePreviewResult>> {
  const fileBase64 = await fileToBase64(file);
  return postJson<ImportFilePreviewResult>("/api/imports/preview", { filename: file.name, mimeType: file.type || "application/octet-stream", fileBase64 });
}

export type ImportRunOptions = Record<string, unknown>;

export async function dryRunImport(module: ImportModuleArg, file: File, options: ImportRunOptions): Promise<ApiResult<ImportRunResult>> {
  const fileBase64 = await fileToBase64(file);
  return postJson<ImportRunResult>("/api/imports/dry-run", { module, filename: file.name, mimeType: file.type || "application/octet-stream", fileBase64, ...options });
}

export async function executeImport(module: ImportModuleArg, file: File, options: ImportRunOptions): Promise<ApiResult<ImportRunResult>> {
  const fileBase64 = await fileToBase64(file);
  return postJson<ImportRunResult>("/api/imports/execute", { module, filename: file.name, mimeType: file.type || "application/octet-stream", fileBase64, ...options });
}

export async function resumeAnalyticsImport(batchRef: string, file: File, options: ImportRunOptions): Promise<ApiResult<ImportRunResult>> {
  const fileBase64 = await fileToBase64(file);
  return postJson<ImportRunResult>("/api/imports/resume", { module: "analytics", batchRef, filename: file.name, mimeType: file.type || "application/octet-stream", fileBase64, ...options });
}

export type ImportModuleArg = "analytics" | "contract_bundle";

export type ImportBatchListItem = Record<string, unknown> & { batchRef: string; status: string; createdAt: string; sourceFilename: string };

export async function listImportBatches(module: ImportModuleArg, limit = 20): Promise<ApiResult<{ batches: ImportBatchListItem[] }>> {
  const response = await fetch(`/api/imports/batches?module=${encodeURIComponent(module)}&limit=${limit}`);
  const body = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, error: normalizeErrorBody(body, response.status) };
  return { ok: true, data: { batches: (body?.batches ?? []) as ImportBatchListItem[] } };
}

export async function getImportBatchDetail(module: ImportModuleArg, batchRef: string): Promise<ApiResult<ImportBatchListItem>> {
  const response = await fetch(`/api/imports/batches/${encodeURIComponent(batchRef)}?module=${encodeURIComponent(module)}`);
  const body = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, error: normalizeErrorBody(body, response.status) };
  return { ok: true, data: body as ImportBatchListItem };
}

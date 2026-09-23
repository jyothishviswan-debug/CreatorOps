// Step 15B: typed browser-side fetch wrappers for EVERY /api/finance/payables/** route. The ONLY way a
// Payables screen talks to the server. Mirrors src/features/finance-agreements/api-client.ts's contract
// exactly (same result shape, same status -> kind mapping) but is its own module: Finance sub-modules do
// not import each other's client code.
//
// Contract of every function:
//   - NEVER throws: a network failure, an aborted request, a non-JSON body - all become a failure result;
//   - returns a discriminated result   { ok: true, status, data }
//                                    | { ok: false, status, kind, message, blockers?, aborted? };
//   - `kind` is a closed set the UI can switch over: unauthorized (401) | forbidden (403) | not_found (404) |
//     invalid (400) | stale (409 "changed elsewhere": reload and retry) | conflict (other 409) |
//     not_ready (409 with blockers) | network | error;
//   - accepts an optional AbortSignal (`options.signal`); an aborted call resolves with kind "network" and
//     `aborted: true` so a caller can ignore it;
//   - every successful mutation returns the fresh PayableDetailDto: ALWAYS replace client state with it.
//
// Optimistic concurrency: every mutation on an existing Payable sends `expectedDocVersion` = the HEAD's
// `docVersion` (PayableDetailDto.head.docVersion). A mismatch comes back as `kind: "stale"`.
import type { PayableDetailDto, PayableEventDto, PayableSourcePreviewDto, PayableSourceRevisionDto, PayableWorkspaceDto } from "@/server/finance-payables/client-dto";
import type { PayableCounterpartyType, PayableReviewCode, PayableStatus } from "@/server/finance-payables/types";

// --- Result shapes ------------------------------------------------------------------------------------------------------------------
export type PayablesApiErrorKind = "unauthorized" | "forbidden" | "not_found" | "invalid" | "stale" | "conflict" | "not_ready" | "network" | "error";

export type PayablesApiBlocker = { code: string; message: string };

export type PayablesApiSuccess<T> = { ok: true; status: number; data: T };
export type PayablesApiFailure = { ok: false; status: number; kind: PayablesApiErrorKind; message: string; blockers?: PayablesApiBlocker[]; aborted?: true };
export type PayablesApiResult<T> = PayablesApiSuccess<T> | PayablesApiFailure;

export type PayablesRequestOptions = { signal?: AbortSignal };

export const PAYABLES_DENIED_MESSAGE = "You do not have access to this.";
export const PAYABLES_NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";
export const PAYABLES_GENERIC_ERROR_MESSAGE = "Something went wrong.";

const STALE_MESSAGE = /changed elsewhere/i;

export function isStaleMessage(message: string): boolean {
  return STALE_MESSAGE.test(message);
}

export function errorKindForStatus(status: number, options: { hasBlockers?: boolean; message?: string } = {}): PayablesApiErrorKind {
  if (status === 0) return "network";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400) return "invalid";
  if (status === 409) {
    if (options.hasBlockers) return "not_ready";
    return options.message && isStaleMessage(options.message) ? "stale" : "conflict";
  }
  return "error";
}

function readBlockers(value: unknown): PayablesApiBlocker[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const blockers: PayablesApiBlocker[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { code, message } = item as Record<string, unknown>;
    if (typeof code !== "string" || typeof message !== "string") continue;
    blockers.push({ code, message });
  }
  return blockers;
}

export function failureResult(status: number, message: string | undefined, blockers?: PayablesApiBlocker[]): PayablesApiFailure {
  const kind = errorKindForStatus(status, { hasBlockers: blockers !== undefined, message });
  const text = kind === "unauthorized" || kind === "forbidden" ? PAYABLES_DENIED_MESSAGE : kind === "network" ? PAYABLES_NETWORK_MESSAGE : message?.trim() || PAYABLES_GENERIC_ERROR_MESSAGE;
  return { ok: false, status, kind, message: text, ...(blockers ? { blockers } : {}) };
}

const abortedResult = (): PayablesApiFailure => ({ ok: false, status: 0, kind: "network", message: "The request was cancelled.", aborted: true });
const networkResult = (): PayablesApiFailure => ({ ok: false, status: 0, kind: "network", message: PAYABLES_NETWORK_MESSAGE });

// --- Transport ------------------------------------------------------------------------------------------------------------------------
type SendInit = { method: "GET" | "POST" | "DELETE"; json?: unknown; signal?: AbortSignal };

async function send<T>(url: string, init: SendInit): Promise<PayablesApiResult<T>> {
  if (init.signal?.aborted) return abortedResult();
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
        return init.signal?.aborted ? abortedResult() : { ok: false, status: response.status, kind: "error", message: "Unexpected response from the server." };
      }
    }

    let message: string | undefined;
    let blockers: PayablesApiBlocker[] | undefined;
    try {
      const parsed = (await response.json()) as { error?: unknown; blockers?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
      blockers = readBlockers(parsed.blockers);
    } catch {
      // No JSON body - the status alone decides the kind.
    }
    return failureResult(response.status, message, blockers);
  } catch {
    return init.signal?.aborted ? abortedResult() : networkResult();
  }
}

function queryString(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const text = typeof value === "string" ? value.trim() : String(value);
    if (text === "") continue;
    search.set(key, text);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

const payablePath = (payableRef: string, suffix = "") => `/api/finance/payables/${encodeURIComponent(payableRef)}${suffix}`;
const getJson = <T>(url: string, options: PayablesRequestOptions | undefined) => send<T>(url, { method: "GET", signal: options?.signal });
const postJson = <T>(url: string, json: unknown, options: PayablesRequestOptions | undefined) => send<T>(url, { method: "POST", json, signal: options?.signal });
const deleteJson = <T>(url: string, json: unknown, options: PayablesRequestOptions | undefined) => send<T>(url, { method: "DELETE", json, signal: options?.signal });

// --- Workspace ------------------------------------------------------------------------------------------------------------------------
export type WorkspaceRequest = {
  status?: PayableStatus;
  counterpartyType?: PayableCounterpartyType;
  counterpartyRef?: string;
  commercialPeriod?: string;
  limit?: number;
  cursor?: string;
};

export function loadPayablesWorkspace(request: WorkspaceRequest, options?: PayablesRequestOptions): Promise<PayablesApiResult<PayableWorkspaceDto>> {
  return getJson(`/api/finance/payables${queryString(request)}`, options);
}

// --- Source preview / create ------------------------------------------------------------------------------------------------------------
export type PayableSourceRequestInput = { counterpartyType: PayableCounterpartyType; counterpartyRef: string; commercialPeriod: string; agreementRef?: string };

export function previewPayableSource(input: PayableSourceRequestInput, options?: PayablesRequestOptions): Promise<PayablesApiResult<PayableSourcePreviewDto>> {
  return postJson("/api/finance/payables/preview", input, options);
}

// 201 (status) = newly created, 200 = the canonical Payable for this basis already existed (idempotent). The body
// is always the PayableDetailDto (never the {outcome, payable} wrapper - the route unwraps it).
export function createPayable(input: PayableSourceRequestInput, options?: PayablesRequestOptions): Promise<PayablesApiResult<PayableDetailDto>> {
  return postJson("/api/finance/payables", input, options);
}

// --- Read one -------------------------------------------------------------------------------------------------------------------------
export function getPayable(payableRef: string, input: { version?: number } = {}, options?: PayablesRequestOptions): Promise<PayablesApiResult<PayableDetailDto>> {
  return getJson(payablePath(payableRef, queryString({ version: input.version })), options);
}

export function listPayableEvents(payableRef: string, input: { limit?: number } = {}, options?: PayablesRequestOptions): Promise<PayablesApiResult<{ payableRef: string; events: PayableEventDto[]; hasMore: boolean }>> {
  return getJson(payablePath(payableRef, `/events${queryString({ limit: input.limit })}`), options);
}

export function getPayableSourceRevision(payableRef: string, options?: PayablesRequestOptions): Promise<PayablesApiResult<PayableSourceRevisionDto>> {
  return getJson(payablePath(payableRef, "/source-revision"), options);
}

// --- Mutations (DRAFT only, unless noted) ----------------------------------------------------------------------------------------------
export type RevisePayableRequestInput = { expectedDocVersion: number; refreshSource?: boolean; reason: string };
export function revisePayable(payableRef: string, input: RevisePayableRequestInput, options?: PayablesRequestOptions): Promise<PayablesApiResult<PayableDetailDto>> {
  return postJson(payablePath(payableRef, "/revise"), input, options);
}

export type AddAdjustmentInput = { expectedDocVersion: number; label: string; amountMinorSigned: number; reason: string; resolvesCode?: PayableReviewCode };
export function addPayableAdjustment(payableRef: string, input: AddAdjustmentInput, options?: PayablesRequestOptions): Promise<PayablesApiResult<PayableDetailDto>> {
  return postJson(payablePath(payableRef, "/adjustments"), input, options);
}

export type RemoveAdjustmentInput = { expectedDocVersion: number; lineRef: string; reason: string };
export function removePayableAdjustment(payableRef: string, input: RemoveAdjustmentInput, options?: PayablesRequestOptions): Promise<PayablesApiResult<PayableDetailDto>> {
  return deleteJson(payablePath(payableRef, "/adjustments"), input, options);
}

export function markPayableReadyForInvoice(payableRef: string, input: { expectedDocVersion: number }, options?: PayablesRequestOptions): Promise<PayablesApiResult<PayableDetailDto>> {
  return postJson(payablePath(payableRef, "/ready"), input, options);
}

export function voidPayable(payableRef: string, input: { expectedDocVersion: number; reason: string }, options?: PayablesRequestOptions): Promise<PayablesApiResult<PayableDetailDto>> {
  return postJson(payablePath(payableRef, "/void"), input, options);
}

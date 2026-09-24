// Step 16B: typed browser-side fetch wrappers for EVERY /api/finance/invoices/** route. The ONLY
// way an Invoices screen talks to the server. Mirrors src/features/finance-payables/api-client.ts's
// contract exactly (same result shape, same status -> kind mapping) but is its own module: Finance
// sub-modules do not import each other's client code.
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
//   - every successful mutation returns the fresh InvoiceDetailDto: ALWAYS replace client state with it.
//
// Optimistic concurrency: every mutation on an existing Invoice sends `expectedDocVersion` = the HEAD's
// `docVersion` (InvoiceDetailDto.head.docVersion). A mismatch comes back as `kind: "stale"`.
//
// Stage 1 of Create also needs to list ELIGIBLE (READY_FOR_INVOICE) Payables: that is Payables' own
// workspace endpoint (GET /api/finance/payables), called here directly over HTTP (never by importing
// src/features/finance-payables' client code) - only its published DTO TYPES are imported, exactly
// like a server route would import another module's published contract.
import type { PayableWorkspaceDto } from "@/server/finance-payables/client-dto";
import type { PayableCounterpartyType } from "@/server/finance-payables/types";
import type { InvoiceDetailDto, InvoiceEventDto, InvoiceExtractionPreviewDto, InvoiceVersionDto, InvoiceWorkspaceDto } from "@/server/finance-invoices/client-dto";
import type { InvoiceCounterpartyType, InvoiceReconciliationState, InvoiceStatus } from "@/server/finance-invoices/types";
import type { PreviewInvoiceEligibilityDto } from "@/server/finance-invoices/invoice-service";
import type { InvoiceSourceRevisionDto } from "@/server/finance-invoices/invoice-lifecycle-service";

// --- Result shapes ------------------------------------------------------------------------------------------------------------------
export type InvoicesApiErrorKind = "unauthorized" | "forbidden" | "not_found" | "invalid" | "stale" | "conflict" | "not_ready" | "network" | "error";

export type InvoicesApiBlocker = { code: string; message: string };

export type InvoicesApiSuccess<T> = { ok: true; status: number; data: T };
export type InvoicesApiFailure = { ok: false; status: number; kind: InvoicesApiErrorKind; message: string; blockers?: InvoicesApiBlocker[]; aborted?: true };
export type InvoicesApiResult<T> = InvoicesApiSuccess<T> | InvoicesApiFailure;

export type InvoicesRequestOptions = { signal?: AbortSignal };

export const INVOICES_DENIED_MESSAGE = "You do not have access to this.";
export const INVOICES_NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";
export const INVOICES_GENERIC_ERROR_MESSAGE = "Something went wrong.";

const STALE_MESSAGE = /changed elsewhere/i;

export function isStaleMessage(message: string): boolean {
  return STALE_MESSAGE.test(message);
}

export function errorKindForStatus(status: number, options: { hasBlockers?: boolean; message?: string } = {}): InvoicesApiErrorKind {
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

function readBlockers(value: unknown): InvoicesApiBlocker[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const blockers: InvoicesApiBlocker[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { code, message } = item as Record<string, unknown>;
    if (typeof code !== "string" || typeof message !== "string") continue;
    blockers.push({ code, message });
  }
  return blockers;
}

export function failureResult(status: number, message: string | undefined, blockers?: InvoicesApiBlocker[]): InvoicesApiFailure {
  const kind = errorKindForStatus(status, { hasBlockers: blockers !== undefined, message });
  const text = kind === "unauthorized" || kind === "forbidden" ? INVOICES_DENIED_MESSAGE : kind === "network" ? INVOICES_NETWORK_MESSAGE : message?.trim() || INVOICES_GENERIC_ERROR_MESSAGE;
  return { ok: false, status, kind, message: text, ...(blockers ? { blockers } : {}) };
}

const abortedResult = (): InvoicesApiFailure => ({ ok: false, status: 0, kind: "network", message: "The request was cancelled.", aborted: true });
const networkResult = (): InvoicesApiFailure => ({ ok: false, status: 0, kind: "network", message: INVOICES_NETWORK_MESSAGE });

// --- Transport ------------------------------------------------------------------------------------------------------------------------
type SendInit = { method: "GET" | "POST"; json?: unknown; signal?: AbortSignal; headers?: Record<string, string> };
type SendResult<T> = InvoicesApiResult<T> & { responseHeaders?: Headers };

async function send<T>(url: string, init: SendInit): Promise<SendResult<T>> {
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
        return { ok: true, status: response.status, data: (await response.json()) as T, responseHeaders: response.headers };
      } catch {
        return init.signal?.aborted ? abortedResult() : { ok: false, status: response.status, kind: "error", message: "Unexpected response from the server." };
      }
    }

    let message: string | undefined;
    let blockers: InvoicesApiBlocker[] | undefined;
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

const invoicePath = (invoiceRef: string, suffix = "") => `/api/finance/invoices/${encodeURIComponent(invoiceRef)}${suffix}`;
const getJson = <T>(url: string, options: InvoicesRequestOptions | undefined) => send<T>(url, { method: "GET", signal: options?.signal });
const postJson = <T>(url: string, json: unknown, options: InvoicesRequestOptions | undefined) => send<T>(url, { method: "POST", json, signal: options?.signal });

// --- Workspace ------------------------------------------------------------------------------------------------------------------------
export type InvoiceWorkspaceRequest = {
  status?: InvoiceStatus;
  counterpartyType?: InvoiceCounterpartyType;
  counterpartyRef?: string;
  commercialPeriod?: string;
  reconciliationState?: InvoiceReconciliationState;
  limit?: number;
  cursor?: string;
};

export function loadInvoicesWorkspace(request: InvoiceWorkspaceRequest, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<InvoiceWorkspaceDto>> {
  return getJson(`/api/finance/invoices${queryString(request)}`, options);
}

// --- Eligible Payables (Create - Stage 1): Payables' OWN workspace endpoint, called over HTTP -----------------------------------------
export type EligiblePayablesRequest = { counterpartyType?: PayableCounterpartyType; counterpartyRef?: string; commercialPeriod?: string; limit?: number; cursor?: string };

export function loadEligiblePayables(request: EligiblePayablesRequest, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<PayableWorkspaceDto>> {
  return getJson(`/api/finance/payables${queryString({ ...request, status: "READY_FOR_INVOICE" })}`, options);
}

// --- Preview / create (idempotent) -----------------------------------------------------------------------------------------------------
export function previewInvoiceEligibility(payableRef: string, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<PreviewInvoiceEligibilityDto>> {
  return postJson("/api/finance/invoices/preview", { payableRef }, options);
}

export type CreateInvoiceOutcome = { outcome: "created" | "existing"; data: InvoiceDetailDto };

// 201 = newly created, 200 = the canonical Invoice for this Payable already existed (idempotent).
// The body is always the InvoiceDetailDto; the outcome is carried in the response header.
export async function createInvoiceDraft(payableRef: string, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<CreateInvoiceOutcome>> {
  const result = await send<InvoiceDetailDto>("/api/finance/invoices", { method: "POST", json: { payableRef }, signal: options?.signal });
  if (!result.ok) return result;
  const outcome = result.responseHeaders?.get("X-Finance-Invoice-Outcome") === "existing" ? "existing" : "created";
  return { ok: true, status: result.status, data: { outcome, data: result.data } };
}

// --- Read one ---------------------------------------------------------------------------------------------------------------------------
export function getInvoice(invoiceRef: string, input: { version?: number } = {}, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<InvoiceDetailDto>> {
  return getJson(invoicePath(invoiceRef, queryString({ version: input.version })), options);
}

export function listInvoiceEvents(invoiceRef: string, input: { limit?: number } = {}, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<{ invoiceRef: string; events: InvoiceEventDto[]; hasMore: boolean }>> {
  return getJson(invoicePath(invoiceRef, `/events${queryString({ limit: input.limit })}`), options);
}

export function getInvoiceSourceRevision(invoiceRef: string, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<InvoiceSourceRevisionDto>> {
  return getJson(invoicePath(invoiceRef, "/source-revision"), options);
}

// --- Mutations (DRAFT only, unless noted) ------------------------------------------------------------------------------------------------
export type ReviseInvoiceRequestInput = {
  expectedDocVersion: number;
  externalInvoiceNumber?: string | null;
  invoiceDate?: string | null;
  receivedDate?: string | null;
  currency?: string | null;
  subtotalMinor?: number | null;
  taxLines?: Array<{ label: string; ratePercentBasisPoints: number | null; amountMinor: number }>;
  declaredTotalMinor?: number | null;
  dueDate?: string | null;
  extractedPayeeName?: string | null;
  reason: string;
};
export function reviseInvoiceDraft(invoiceRef: string, input: ReviseInvoiceRequestInput, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<InvoiceDetailDto>> {
  return postJson(invoicePath(invoiceRef, "/revise"), input, options);
}

export type AttachInvoiceDocumentInput = { expectedDocVersion: number; fileName: string; contentBase64: string };
export function attachInvoiceDocument(invoiceRef: string, input: AttachInvoiceDocumentInput, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<InvoiceDetailDto>> {
  return postJson(invoicePath(invoiceRef, "/document"), input, options);
}

// Step 15C section 19/24/26: preview extraction over the SAME staged bytes a subsequent
// attachInvoiceDocument call would persist - read-only, no expectedDocVersion (nothing is written).
export type PreviewInvoiceExtractionInput = { contentBase64: string };
export function previewInvoiceExtraction(invoiceRef: string, input: PreviewInvoiceExtractionInput, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<InvoiceExtractionPreviewDto>> {
  return postJson(invoicePath(invoiceRef, "/extraction"), input, options);
}

export function reconcileInvoice(invoiceRef: string, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<InvoiceVersionDto>> {
  return postJson(invoicePath(invoiceRef, "/reconcile"), {}, options);
}

export function submitInvoice(invoiceRef: string, input: { expectedDocVersion: number }, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<InvoiceDetailDto>> {
  return postJson(invoicePath(invoiceRef, "/submit"), input, options);
}

export function approveInvoice(invoiceRef: string, input: { expectedDocVersion: number }, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<InvoiceDetailDto>> {
  return postJson(invoicePath(invoiceRef, "/approve"), input, options);
}

export function rejectInvoice(invoiceRef: string, input: { expectedDocVersion: number; reason: string }, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<InvoiceDetailDto>> {
  return postJson(invoicePath(invoiceRef, "/reject"), input, options);
}

export function reopenInvoice(invoiceRef: string, input: { expectedDocVersion: number; reason: string }, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<InvoiceDetailDto>> {
  return postJson(invoicePath(invoiceRef, "/reopen"), input, options);
}

export function voidInvoice(invoiceRef: string, input: { expectedDocVersion: number; reason: string }, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<InvoiceDetailDto>> {
  return postJson(invoicePath(invoiceRef, "/void"), input, options);
}

export function acceptInvoiceMismatch(invoiceRef: string, input: { expectedDocVersion: number; reason: string }, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<InvoiceDetailDto>> {
  return postJson(invoicePath(invoiceRef, "/mismatch-override"), input, options);
}

// Step 16C section 11: "Resolve payee mismatch" - accepts the Invoice as belonging to the expected
// Payable counterparty despite a payee identity mismatch/review.
export function resolveInvoicePayeeMismatch(invoiceRef: string, input: { expectedDocVersion: number; reason: string }, options?: InvoicesRequestOptions): Promise<InvoicesApiResult<InvoiceDetailDto>> {
  return postJson(invoicePath(invoiceRef, "/resolve-payee-mismatch"), input, options);
}

// Step 17B: typed browser-side fetch wrappers for EVERY /api/finance/payments/** route. The ONLY
// way a Payments screen talks to the server. Mirrors src/features/finance-invoices/api-client.ts's
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
//   - every successful mutation returns the fresh PaymentDetailDto: ALWAYS replace client state with it.
//
// Optimistic concurrency: every mutation on an existing Payment sends `expectedDocVersion` = the
// HEAD's `docVersion` (PaymentDetailDto.head.docVersion). A mismatch comes back as `kind: "stale"`.
//
// Create Stage 1 also needs to list APPROVED, payment-eligible Invoices: that is Invoices' own
// workspace/detail endpoints, called here directly over HTTP (never by importing
// src/features/finance-invoices' client code) - only its published DTO TYPES are imported, exactly
// like a server route would import another module's published contract.
import type { InvoiceDetailDto, InvoiceRowDto, InvoiceWorkspaceDto } from "@/server/finance-invoices/client-dto";
import type { InvoicePaymentSettlementDto, PaymentDetailDto, PaymentEventDto, PaymentWorkspaceDto } from "@/server/finance-payments/client-dto";
import type { PaymentCounterpartyType, PaymentMethod, PaymentStatus } from "@/server/finance-payments/types";

// --- Result shapes ------------------------------------------------------------------------------------------------------------------
export type PaymentsApiErrorKind = "unauthorized" | "forbidden" | "not_found" | "invalid" | "stale" | "conflict" | "not_ready" | "network" | "error";

export type PaymentsApiBlocker = { code: string; message: string };

export type PaymentsApiSuccess<T> = { ok: true; status: number; data: T };
export type PaymentsApiFailure = { ok: false; status: number; kind: PaymentsApiErrorKind; message: string; blockers?: PaymentsApiBlocker[]; aborted?: true };
export type PaymentsApiResult<T> = PaymentsApiSuccess<T> | PaymentsApiFailure;

export type PaymentsRequestOptions = { signal?: AbortSignal };

export const PAYMENTS_DENIED_MESSAGE = "You do not have access to this.";
export const PAYMENTS_NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";
export const PAYMENTS_GENERIC_ERROR_MESSAGE = "Something went wrong.";

const STALE_MESSAGE = /changed elsewhere/i;

export function isStaleMessage(message: string): boolean {
  return STALE_MESSAGE.test(message);
}

export function errorKindForStatus(status: number, options: { hasBlockers?: boolean; message?: string } = {}): PaymentsApiErrorKind {
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

function readBlockers(value: unknown): PaymentsApiBlocker[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const blockers: PaymentsApiBlocker[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { code, message } = item as Record<string, unknown>;
    if (typeof code !== "string" || typeof message !== "string") continue;
    blockers.push({ code, message });
  }
  return blockers;
}

export function failureResult(status: number, message: string | undefined, blockers?: PaymentsApiBlocker[]): PaymentsApiFailure {
  const kind = errorKindForStatus(status, { hasBlockers: blockers !== undefined, message });
  const text = kind === "unauthorized" || kind === "forbidden" ? PAYMENTS_DENIED_MESSAGE : kind === "network" ? PAYMENTS_NETWORK_MESSAGE : message?.trim() || PAYMENTS_GENERIC_ERROR_MESSAGE;
  return { ok: false, status, kind, message: text, ...(blockers ? { blockers } : {}) };
}

const abortedResult = (): PaymentsApiFailure => ({ ok: false, status: 0, kind: "network", message: "The request was cancelled.", aborted: true });
const networkResult = (): PaymentsApiFailure => ({ ok: false, status: 0, kind: "network", message: PAYMENTS_NETWORK_MESSAGE });

// --- Transport ------------------------------------------------------------------------------------------------------------------------
type SendInit = { method: "GET" | "POST"; json?: unknown; signal?: AbortSignal; headers?: Record<string, string> };
type SendResult<T> = PaymentsApiResult<T> & { responseHeaders?: Headers };

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
    let blockers: PaymentsApiBlocker[] | undefined;
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

const paymentPath = (paymentRef: string, suffix = "") => `/api/finance/payments/${encodeURIComponent(paymentRef)}${suffix}`;
const getJson = <T>(url: string, options: PaymentsRequestOptions | undefined) => send<T>(url, { method: "GET", signal: options?.signal });
const postJson = <T>(url: string, json: unknown, options: PaymentsRequestOptions | undefined) => send<T>(url, { method: "POST", json, signal: options?.signal });

// --- Workspace ------------------------------------------------------------------------------------------------------------------------
export type PaymentWorkspaceRequest = {
  status?: PaymentStatus;
  invoiceRef?: string;
  counterpartyType?: PaymentCounterpartyType;
  counterpartyRef?: string;
  limit?: number;
  cursor?: string;
};

export function loadPaymentsWorkspace(request: PaymentWorkspaceRequest, options?: PaymentsRequestOptions): Promise<PaymentsApiResult<PaymentWorkspaceDto>> {
  return getJson(`/api/finance/payments${queryString(request)}`, options);
}

// --- Eligible Invoices (Create - Stage 1): Invoices' OWN workspace/detail endpoints, called over HTTP -----------------------------------
export type EligibleInvoicesRequest = { counterpartyType?: PaymentCounterpartyType; counterpartyRef?: string; commercialPeriod?: string; limit?: number; cursor?: string };

export function loadEligibleInvoices(request: EligibleInvoicesRequest, options?: PaymentsRequestOptions): Promise<PaymentsApiResult<InvoiceWorkspaceDto>> {
  return getJson(`/api/finance/invoices${queryString({ ...request, status: "APPROVED" })}`, options);
}

export function getInvoiceForPayment(invoiceRef: string, options?: PaymentsRequestOptions): Promise<PaymentsApiResult<InvoiceDetailDto>> {
  return getJson(`/api/finance/invoices/${encodeURIComponent(invoiceRef)}`, options);
}

export type EligibleInvoiceRow = InvoiceRowDto;

// --- Invoice settlement projection (own Payments endpoint) ------------------------------------------------------------------------------
export function getInvoicePaymentSettlement(invoiceRef: string, options?: PaymentsRequestOptions): Promise<PaymentsApiResult<InvoicePaymentSettlementDto>> {
  return getJson(`/api/finance/payments/invoices/${encodeURIComponent(invoiceRef)}/settlement`, options);
}

// --- Create --------------------------------------------------------------------------------------------------------------------------------
export function createPaymentDraft(invoiceRef: string, options?: PaymentsRequestOptions): Promise<PaymentsApiResult<PaymentDetailDto>> {
  return postJson("/api/finance/payments", { invoiceRef }, options);
}

// --- Read one ---------------------------------------------------------------------------------------------------------------------------
export function getPayment(paymentRef: string, input: { version?: number } = {}, options?: PaymentsRequestOptions): Promise<PaymentsApiResult<PaymentDetailDto>> {
  return getJson(paymentPath(paymentRef, queryString({ version: input.version })), options);
}

export function listPaymentEvents(paymentRef: string, input: { limit?: number } = {}, options?: PaymentsRequestOptions): Promise<PaymentsApiResult<{ paymentRef: string; events: PaymentEventDto[]; hasMore: boolean }>> {
  return getJson(paymentPath(paymentRef, `/events${queryString({ limit: input.limit })}`), options);
}

// --- Mutations (DRAFT revise only, unless noted) ------------------------------------------------------------------------------------------
export type RevisePaymentRequestInput = {
  expectedDocVersion: number;
  amountMinor?: number | null;
  paymentDate?: string | null;
  method?: PaymentMethod | null;
  externalReference?: string | null;
  memo?: string | null;
  reason: string;
};
export function revisePaymentDraft(paymentRef: string, input: RevisePaymentRequestInput, options?: PaymentsRequestOptions): Promise<PaymentsApiResult<PaymentDetailDto>> {
  return postJson(paymentPath(paymentRef, "/revise"), input, options);
}

export function recordPayment(paymentRef: string, input: { expectedDocVersion: number }, options?: PaymentsRequestOptions): Promise<PaymentsApiResult<PaymentDetailDto>> {
  return postJson(paymentPath(paymentRef, "/record"), input, options);
}

export function confirmPayment(paymentRef: string, input: { expectedDocVersion: number; overrideOverageReason?: string }, options?: PaymentsRequestOptions): Promise<PaymentsApiResult<PaymentDetailDto>> {
  return postJson(paymentPath(paymentRef, "/confirm"), input, options);
}

export function failPayment(paymentRef: string, input: { expectedDocVersion: number; reason: string }, options?: PaymentsRequestOptions): Promise<PaymentsApiResult<PaymentDetailDto>> {
  return postJson(paymentPath(paymentRef, "/fail"), input, options);
}

export function reopenPayment(paymentRef: string, input: { expectedDocVersion: number; reason: string }, options?: PaymentsRequestOptions): Promise<PaymentsApiResult<PaymentDetailDto>> {
  return postJson(paymentPath(paymentRef, "/reopen"), input, options);
}

export function voidPayment(paymentRef: string, input: { expectedDocVersion: number; reason: string }, options?: PaymentsRequestOptions): Promise<PaymentsApiResult<PaymentDetailDto>> {
  return postJson(paymentPath(paymentRef, "/void"), input, options);
}

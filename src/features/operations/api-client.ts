import type { ApprovalItemDto, ApprovalQueueListDto } from "@/server/operations/approval-queue/types";
import type { ReminderDto, ReminderEventDto, TaskDto, TaskEventDto } from "@/server/operations/client-dto";
import type { TargetReference, TargetType } from "@/server/operations/target-ref";

// Step 18B: typed browser-side fetch wrappers for every /api/operations/** route this UI calls,
// mirroring src/features/finance-payments/api-client.ts's own contract (never throws; a
// discriminated result; `kind` is a closed set the UI can switch over). This is the ONLY way an
// Operations screen talks to the server.

export type OpsApiErrorKind = "unauthorized" | "forbidden" | "not_found" | "invalid" | "stale" | "conflict" | "not_ready" | "network" | "error";
export type OpsApiBlocker = { code: string; message: string };
export type OpsApiSuccess<T> = { ok: true; status: number; data: T };
export type OpsApiFailure = { ok: false; status: number; kind: OpsApiErrorKind; message: string; blockers?: OpsApiBlocker[]; aborted?: true };
export type OpsApiResult<T> = OpsApiSuccess<T> | OpsApiFailure;
export type OpsRequestOptions = { signal?: AbortSignal };

export const OPS_DENIED_MESSAGE = "You do not have access to this.";
export const OPS_NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";
export const OPS_GENERIC_ERROR_MESSAGE = "Something went wrong.";

function kindForStatus(status: number, hasBlockers: boolean, message: string | undefined): OpsApiErrorKind {
  if (status === 0) return "network";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400) return "invalid";
  if (status === 409) {
    if (hasBlockers) return "not_ready";
    return message && /changed elsewhere/i.test(message) ? "stale" : "conflict";
  }
  return "error";
}

function readBlockers(value: unknown): OpsApiBlocker[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const blockers: OpsApiBlocker[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { code, message } = item as Record<string, unknown>;
    if (typeof code === "string" && typeof message === "string") blockers.push({ code, message });
  }
  return blockers;
}

async function send<T>(url: string, init: { method: "GET" | "POST"; json?: unknown; signal?: AbortSignal }): Promise<OpsApiResult<T>> {
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
    let blockers: OpsApiBlocker[] | undefined;
    try {
      const parsed = (await response.json()) as { error?: unknown; blockers?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
      blockers = readBlockers(parsed.blockers);
    } catch {
      // No JSON body.
    }
    const kind = kindForStatus(response.status, blockers !== undefined, message);
    const text = kind === "unauthorized" || kind === "forbidden" ? OPS_DENIED_MESSAGE : message?.trim() || OPS_GENERIC_ERROR_MESSAGE;
    return { ok: false, status: response.status, kind, message: text, ...(blockers ? { blockers } : {}) };
  } catch {
    return { ok: false, status: 0, kind: "network", message: OPS_NETWORK_MESSAGE };
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

const getJson = <T>(url: string, options?: OpsRequestOptions) => send<T>(url, { method: "GET", signal: options?.signal });
const postJson = <T>(url: string, json: unknown, options?: OpsRequestOptions) => send<T>(url, { method: "POST", json, signal: options?.signal });

// --- Tasks --------------------------------------------------------------------------------------
export type TaskListQuery = { status?: string; assigneeUserRef?: string; targetType?: string; targetRef?: string; priority?: string; limit?: number };
export function listTasks(query: TaskListQuery, options?: OpsRequestOptions): Promise<OpsApiResult<{ tasks: TaskDto[] }>> {
  return getJson(`/api/operations/tasks${queryString(query)}`, options);
}

export type CreateTaskRequest = { title: string; notes?: string | null; target: TargetReference; assigneeUserRef: string; priority?: string; dueAt?: string | null };
export function createTask(input: CreateTaskRequest, options?: OpsRequestOptions): Promise<OpsApiResult<TaskDto>> {
  return postJson("/api/operations/tasks", input, options);
}

export function getTask(taskRef: string, options?: OpsRequestOptions): Promise<OpsApiResult<TaskDto>> {
  return getJson(`/api/operations/tasks/${encodeURIComponent(taskRef)}`, options);
}

export function listTaskEvents(taskRef: string, options?: OpsRequestOptions): Promise<OpsApiResult<{ events: TaskEventDto[]; hasMore: boolean }>> {
  return getJson(`/api/operations/tasks/${encodeURIComponent(taskRef)}/events`, options);
}

export function reviseTask(taskRef: string, input: { expectedDocVersion: number; title?: string; notes?: string | null; priority?: string; dueAt?: string | null; reason: string }, options?: OpsRequestOptions): Promise<OpsApiResult<TaskDto>> {
  return postJson(`/api/operations/tasks/${encodeURIComponent(taskRef)}/revise`, input, options);
}

export function startTask(taskRef: string, expectedDocVersion: number, options?: OpsRequestOptions): Promise<OpsApiResult<TaskDto>> {
  return postJson(`/api/operations/tasks/${encodeURIComponent(taskRef)}/start`, { expectedDocVersion }, options);
}

export function blockTask(taskRef: string, input: { expectedDocVersion: number; reason: string }, options?: OpsRequestOptions): Promise<OpsApiResult<TaskDto>> {
  return postJson(`/api/operations/tasks/${encodeURIComponent(taskRef)}/block`, input, options);
}

export function unblockTask(taskRef: string, expectedDocVersion: number, options?: OpsRequestOptions): Promise<OpsApiResult<TaskDto>> {
  return postJson(`/api/operations/tasks/${encodeURIComponent(taskRef)}/unblock`, { expectedDocVersion }, options);
}

export function completeTask(taskRef: string, expectedDocVersion: number, options?: OpsRequestOptions): Promise<OpsApiResult<TaskDto>> {
  return postJson(`/api/operations/tasks/${encodeURIComponent(taskRef)}/complete`, { expectedDocVersion }, options);
}

export function cancelTask(taskRef: string, input: { expectedDocVersion: number; reason: string }, options?: OpsRequestOptions): Promise<OpsApiResult<TaskDto>> {
  return postJson(`/api/operations/tasks/${encodeURIComponent(taskRef)}/cancel`, input, options);
}

export function reopenTask(taskRef: string, input: { expectedDocVersion: number; reason: string }, options?: OpsRequestOptions): Promise<OpsApiResult<TaskDto>> {
  return postJson(`/api/operations/tasks/${encodeURIComponent(taskRef)}/reopen`, input, options);
}

export function reassignTask(taskRef: string, input: { expectedDocVersion: number; assigneeUserRef: string; reason: string }, options?: OpsRequestOptions): Promise<OpsApiResult<TaskDto>> {
  return postJson(`/api/operations/tasks/${encodeURIComponent(taskRef)}/reassign`, input, options);
}

// --- Approval Queue (READ-ONLY: list / get / refresh - no mutation call exists here or ever should) ----
export type ApprovalListQuery = { sourceModule?: string; limit?: number };
export function listApprovalQueue(query: ApprovalListQuery, options?: OpsRequestOptions): Promise<OpsApiResult<ApprovalQueueListDto>> {
  return getJson(`/api/operations/approvals${queryString(query)}`, options);
}
export function getApprovalItem(approvalItemRef: string, options?: OpsRequestOptions): Promise<OpsApiResult<ApprovalItemDto>> {
  return getJson(`/api/operations/approvals/${encodeURIComponent(approvalItemRef)}`, options);
}
export function refreshApprovalItem(approvalItemRef: string, options?: OpsRequestOptions): Promise<OpsApiResult<ApprovalItemDto>> {
  return postJson(`/api/operations/approvals/${encodeURIComponent(approvalItemRef)}/refresh`, {}, options);
}

// --- Reminders ------------------------------------------------------------------------------------
export type ReminderListQuery = { status?: string; recipientUserRef?: string; taskRef?: string; dueOnly?: boolean; limit?: number };
export function listReminders(query: ReminderListQuery, options?: OpsRequestOptions): Promise<OpsApiResult<{ reminders: ReminderDto[] }>> {
  return getJson(`/api/operations/reminders${queryString(query)}`, options);
}

export type CreateReminderRequest = { target: TargetReference; taskRef?: string | null; recipientUserRef: string; message: string; reminderAt: string };
export function createReminder(input: CreateReminderRequest, options?: OpsRequestOptions): Promise<OpsApiResult<ReminderDto>> {
  return postJson("/api/operations/reminders", input, options);
}

export function getReminder(reminderRef: string, options?: OpsRequestOptions): Promise<OpsApiResult<ReminderDto>> {
  return getJson(`/api/operations/reminders/${encodeURIComponent(reminderRef)}`, options);
}

export function listReminderEvents(reminderRef: string, options?: OpsRequestOptions): Promise<OpsApiResult<{ events: ReminderEventDto[]; hasMore: boolean }>> {
  return getJson(`/api/operations/reminders/${encodeURIComponent(reminderRef)}/events`, options);
}

export function rescheduleReminder(reminderRef: string, input: { expectedDocVersion: number; reminderAt: string; reason?: string }, options?: OpsRequestOptions): Promise<OpsApiResult<ReminderDto>> {
  return postJson(`/api/operations/reminders/${encodeURIComponent(reminderRef)}/reschedule`, input, options);
}

export function dismissReminder(reminderRef: string, expectedDocVersion: number, options?: OpsRequestOptions): Promise<OpsApiResult<ReminderDto>> {
  return postJson(`/api/operations/reminders/${encodeURIComponent(reminderRef)}/dismiss`, { expectedDocVersion }, options);
}

export function completeReminder(reminderRef: string, expectedDocVersion: number, options?: OpsRequestOptions): Promise<OpsApiResult<ReminderDto>> {
  return postJson(`/api/operations/reminders/${encodeURIComponent(reminderRef)}/complete`, { expectedDocVersion }, options);
}

export function cancelReminder(reminderRef: string, input: { expectedDocVersion: number; reason: string }, options?: OpsRequestOptions): Promise<OpsApiResult<ReminderDto>> {
  return postJson(`/api/operations/reminders/${encodeURIComponent(reminderRef)}/cancel`, input, options);
}

// --- Assignee picker: active/admitted CreatorOps users only (Administration's own published list) ----
export type AdminUserOption = { userRef: string; displayName: string | null; email: string; role: string; active: boolean };
export function searchActiveUsers(emailPrefix: string, options?: OpsRequestOptions): Promise<OpsApiResult<{ users: AdminUserOption[] }>> {
  return getJson(`/api/administration/users${queryString({ active: true, emailPrefix: emailPrefix || undefined, limit: 10 })}`, options);
}

// --- Target picker: bounded search against each supported target type's OWN authoritative module
// list endpoint (never a generic/arbitrary Firestore query - see TargetPicker.tsx's own comment for
// which types are supported and why three of the eleven are not yet). Every function returns the
// same safe {targetRef, label} shape so the picker never needs to know per-module field names.
export type TargetOption = { targetRef: string; label: string };

// Each loader below fetches a bounded page from the target type's own real module endpoint and
// projects it to {targetRef,label} client-side - the mapping lives here (not in listSafe) because
// each module's row shape has different field names.
export async function searchTargetOptions(targetType: TargetType, query: string, options?: OpsRequestOptions): Promise<TargetOption[]> {
  const q = query.trim();
  switch (targetType) {
    case "PARTNER": {
      const r = await getJson<{ partners: Array<{ partnerRef: string; displayName: string }> }>(`/api/partners${queryString({ displayNamePrefix: q || undefined, limit: 10 })}`, options);
      return r.ok ? r.data.partners.map((p) => ({ targetRef: p.partnerRef, label: p.displayName })) : [];
    }
    case "VENDOR": {
      const r = await getJson<{ vendors: Array<{ vendorRef: string; displayName: string }> }>(`/api/vendors${queryString({ displayNamePrefix: q || undefined, limit: 10 })}`, options);
      return r.ok ? r.data.vendors.map((v) => ({ targetRef: v.vendorRef, label: v.displayName })) : [];
    }
    case "CAMPAIGN": {
      const r = await getJson<{ campaigns: Array<{ campaignRef: string; name: string }> }>(`/api/campaigns${queryString({ namePrefix: q || undefined, limit: 10 })}`, options);
      return r.ok ? r.data.campaigns.map((c) => ({ targetRef: c.campaignRef, label: c.name })) : [];
    }
    case "ASSIGNMENT": {
      const r = await getJson<{ assignments: Array<{ assignmentRef: string; partnerDisplayName: string | null; campaignName: string | null }> }>(`/api/assignments${queryString({ limit: 10 })}`, options);
      return r.ok ? r.data.assignments.map((a) => ({ targetRef: a.assignmentRef, label: `${a.partnerDisplayName ?? "Partner"} · ${a.campaignName ?? "Campaign"}` })) : [];
    }
    case "CONTENT": {
      const r = await getJson<{ content: Array<{ contentRef: string; partnerDisplayName: string | null; campaignName: string | null }> }>(`/api/content${queryString({ limit: 10 })}`, options);
      return r.ok ? r.data.content.map((c) => ({ targetRef: c.contentRef, label: `${c.partnerDisplayName ?? "Partner"} · ${c.campaignName ?? "Campaign"}` })) : [];
    }
    case "PAYABLE": {
      const r = await getJson<{ rows: Array<{ payableRef: string; counterparty: { displayName: string | null; type: string } }> }>(`/api/finance/payables${queryString({ limit: 10 })}`, options);
      return r.ok ? r.data.rows.map((row) => ({ targetRef: row.payableRef, label: row.counterparty.displayName ?? row.counterparty.type })) : [];
    }
    case "INVOICE": {
      const r = await getJson<{ rows: Array<{ invoiceRef: string; externalInvoiceNumber: string | null; counterparty: { displayName: string | null; type: string } }> }>(`/api/finance/invoices${queryString({ limit: 10 })}`, options);
      return r.ok ? r.data.rows.map((row) => ({ targetRef: row.invoiceRef, label: row.externalInvoiceNumber ? `${row.counterparty.displayName ?? row.counterparty.type} (${row.externalInvoiceNumber})` : row.counterparty.displayName ?? row.counterparty.type })) : [];
    }
    case "PAYMENT": {
      const r = await getJson<{ rows: Array<{ paymentRef: string; counterparty: { displayName: string | null; type: string } }> }>(`/api/finance/payments${queryString({ limit: 10 })}`, options);
      return r.ok ? r.data.rows.map((row) => ({ targetRef: row.paymentRef, label: row.counterparty.displayName ?? row.counterparty.type })) : [];
    }
    // PARTNER_REVIEW / AGREEMENT / PARTNER_ACCOUNT: not yet backed by a general bounded browse
    // endpoint this picker can safely call (see TargetPicker.tsx's own comment) - Step 18B integration
    // gap, documented in the completion report rather than faked with an unsafe raw-ref entry point.
    case "PARTNER_REVIEW":
    case "AGREEMENT":
    case "PARTNER_ACCOUNT":
      return [];
    default:
      return [];
  }
}

export const TARGET_TYPES_WITH_PICKER_SUPPORT: TargetType[] = ["PARTNER", "VENDOR", "CAMPAIGN", "ASSIGNMENT", "CONTENT", "PAYABLE", "INVOICE", "PAYMENT"];

import type { ActionItemDto, AttachmentDto, MeetingDto, MeetingVersionDto, NoteDto, NotesMeetingsEventDto, NoteVersionDto } from "@/server/notes-meetings";
import type { OwnerType } from "@/server/notes-meetings";

// Notes/Meetings Completion: typed browser-side fetch wrappers for every /api/notes-meetings/**
// route, mirroring src/features/operations/api-client.ts's own contract exactly (never throws; a
// discriminated result; `kind` is a closed set the UI can switch over).

export type NmApiErrorKind = "unauthorized" | "forbidden" | "not_found" | "invalid" | "stale" | "conflict" | "network" | "error";
export type NmApiSuccess<T> = { ok: true; status: number; data: T };
export type NmApiFailure = { ok: false; status: number; kind: NmApiErrorKind; message: string };
export type NmApiResult<T> = NmApiSuccess<T> | NmApiFailure;
export type NmRequestOptions = { signal?: AbortSignal };

export const NM_DENIED_MESSAGE = "You do not have access to this.";
export const NM_NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";
export const NM_GENERIC_ERROR_MESSAGE = "Something went wrong.";

function kindForStatus(status: number, message: string | undefined): NmApiErrorKind {
  if (status === 0) return "network";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400) return "invalid";
  if (status === 409) return message && /changed elsewhere/i.test(message) ? "stale" : "conflict";
  return "error";
}

async function send<T>(url: string, init: { method: "GET" | "POST"; json?: unknown; formData?: FormData; signal?: AbortSignal }): Promise<NmApiResult<T>> {
  if (init.signal?.aborted) return { ok: false, status: 0, kind: "network", message: "The request was cancelled." };
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    let body: BodyInit | undefined;
    if (init.formData) {
      body = init.formData;
    } else if (init.json !== undefined) {
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
    const kind = kindForStatus(response.status, message);
    const text = kind === "unauthorized" || kind === "forbidden" ? NM_DENIED_MESSAGE : message?.trim() || NM_GENERIC_ERROR_MESSAGE;
    return { ok: false, status: response.status, kind, message: text };
  } catch {
    return { ok: false, status: 0, kind: "network", message: NM_NETWORK_MESSAGE };
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

const getJson = <T>(url: string, options?: NmRequestOptions) => send<T>(url, { method: "GET", signal: options?.signal });
const postJson = <T>(url: string, json: unknown, options?: NmRequestOptions) => send<T>(url, { method: "POST", json, signal: options?.signal });
const postForm = <T>(url: string, formData: FormData, options?: NmRequestOptions) => send<T>(url, { method: "POST", formData, signal: options?.signal });

export type OwnerRef = { ownerType: OwnerType; ownerRef: string };

// --- Notes --------------------------------------------------------------------------------------
export function listNotes(owner: OwnerRef, query: { status?: string; authorUserRef?: string; limit?: number } = {}, options?: NmRequestOptions): Promise<NmApiResult<{ notes: NoteDto[] }>> {
  return getJson(`/api/notes-meetings/notes${queryString({ ownerType: owner.ownerType, ownerRef: owner.ownerRef, ...query })}`, options);
}
export function createNote(input: { owner: OwnerRef; body: string; visibility?: "STANDARD" | "RESTRICTED" }, options?: NmRequestOptions): Promise<NmApiResult<NoteDto>> {
  return postJson("/api/notes-meetings/notes", input, options);
}
export function getNote(noteRef: string, options?: NmRequestOptions): Promise<NmApiResult<NoteDto>> {
  return getJson(`/api/notes-meetings/notes/${encodeURIComponent(noteRef)}`, options);
}
export function reviseNote(noteRef: string, input: { expectedDocVersion: number; body: string; reason: string }, options?: NmRequestOptions): Promise<NmApiResult<NoteDto>> {
  return postJson(`/api/notes-meetings/notes/${encodeURIComponent(noteRef)}/revise`, input, options);
}
export function archiveNote(noteRef: string, input: { expectedDocVersion: number; reason: string }, options?: NmRequestOptions): Promise<NmApiResult<NoteDto>> {
  return postJson(`/api/notes-meetings/notes/${encodeURIComponent(noteRef)}/archive`, input, options);
}
export function listNoteVersions(noteRef: string, options?: NmRequestOptions): Promise<NmApiResult<{ versions: NoteVersionDto[] }>> {
  return getJson(`/api/notes-meetings/notes/${encodeURIComponent(noteRef)}/versions`, options);
}
export function listNoteEvents(noteRef: string, options?: NmRequestOptions): Promise<NmApiResult<{ events: NotesMeetingsEventDto[] }>> {
  return getJson(`/api/notes-meetings/notes/${encodeURIComponent(noteRef)}/events`, options);
}
export function listNoteAttachments(noteRef: string, options?: NmRequestOptions): Promise<NmApiResult<{ attachments: AttachmentDto[] }>> {
  return getJson(`/api/notes-meetings/notes/${encodeURIComponent(noteRef)}/attachments`, options);
}
export function uploadNoteAttachment(noteRef: string, file: File, options?: NmRequestOptions): Promise<NmApiResult<AttachmentDto>> {
  const form = new FormData();
  form.set("file", file);
  return postForm(`/api/notes-meetings/notes/${encodeURIComponent(noteRef)}/attachments`, form, options);
}

// --- Meetings ------------------------------------------------------------------------------------
export function listMeetings(owner: OwnerRef, query: { status?: string; limit?: number } = {}, options?: NmRequestOptions): Promise<NmApiResult<{ meetings: MeetingDto[] }>> {
  return getJson(`/api/notes-meetings/meetings${queryString({ ownerType: owner.ownerType, ownerRef: owner.ownerRef, ...query })}`, options);
}
export type CreateMeetingRequest = { owner: OwnerRef; title: string; meetingAt: string; participants?: { userRef: string }[]; agenda?: string | null; summary?: string | null; decisions?: { text: string }[]; visibility?: "STANDARD" | "RESTRICTED" };
export function createMeeting(input: CreateMeetingRequest, options?: NmRequestOptions): Promise<NmApiResult<MeetingDto>> {
  return postJson("/api/notes-meetings/meetings", input, options);
}
export function getMeeting(meetingRef: string, options?: NmRequestOptions): Promise<NmApiResult<MeetingDto>> {
  return getJson(`/api/notes-meetings/meetings/${encodeURIComponent(meetingRef)}`, options);
}
export type ReviseMeetingRequest = { expectedDocVersion: number; title?: string; meetingAt?: string; participants?: { userRef: string }[]; agenda?: string | null; summary?: string | null; decisions?: { text: string }[]; reason: string };
export function reviseMeeting(meetingRef: string, input: ReviseMeetingRequest, options?: NmRequestOptions): Promise<NmApiResult<MeetingDto>> {
  return postJson(`/api/notes-meetings/meetings/${encodeURIComponent(meetingRef)}/revise`, input, options);
}
export function cancelMeeting(meetingRef: string, input: { expectedDocVersion: number; reason: string }, options?: NmRequestOptions): Promise<NmApiResult<MeetingDto>> {
  return postJson(`/api/notes-meetings/meetings/${encodeURIComponent(meetingRef)}/cancel`, input, options);
}
export function listMeetingVersions(meetingRef: string, options?: NmRequestOptions): Promise<NmApiResult<{ versions: MeetingVersionDto[] }>> {
  return getJson(`/api/notes-meetings/meetings/${encodeURIComponent(meetingRef)}/versions`, options);
}
export function listMeetingEvents(meetingRef: string, options?: NmRequestOptions): Promise<NmApiResult<{ events: NotesMeetingsEventDto[] }>> {
  return getJson(`/api/notes-meetings/meetings/${encodeURIComponent(meetingRef)}/events`, options);
}
export function listMeetingAttachments(meetingRef: string, options?: NmRequestOptions): Promise<NmApiResult<{ attachments: AttachmentDto[] }>> {
  return getJson(`/api/notes-meetings/meetings/${encodeURIComponent(meetingRef)}/attachments`, options);
}
export function uploadMeetingAttachment(meetingRef: string, file: File, options?: NmRequestOptions): Promise<NmApiResult<AttachmentDto>> {
  const form = new FormData();
  form.set("file", file);
  return postForm(`/api/notes-meetings/meetings/${encodeURIComponent(meetingRef)}/attachments`, form, options);
}

// --- Action items --------------------------------------------------------------------------------
export function listActionItems(meetingRef: string, options?: NmRequestOptions): Promise<NmApiResult<{ actionItems: ActionItemDto[] }>> {
  return getJson(`/api/notes-meetings/meetings/${encodeURIComponent(meetingRef)}/action-items`, options);
}
export function createActionItem(meetingRef: string, input: { expectedDocVersion: number; text: string; assigneeUserRef?: string | null; dueAt?: string | null }, options?: NmRequestOptions): Promise<NmApiResult<ActionItemDto>> {
  return postJson(`/api/notes-meetings/meetings/${encodeURIComponent(meetingRef)}/action-items`, input, options);
}
export function getActionItem(actionItemRef: string, options?: NmRequestOptions): Promise<NmApiResult<ActionItemDto>> {
  return getJson(`/api/notes-meetings/action-items/${encodeURIComponent(actionItemRef)}`, options);
}
export function reviseActionItem(actionItemRef: string, input: { expectedDocVersion: number; text?: string; assigneeUserRef?: string | null; dueAt?: string | null; status?: "OPEN" | "IN_PROGRESS"; reason: string }, options?: NmRequestOptions): Promise<NmApiResult<ActionItemDto>> {
  return postJson(`/api/notes-meetings/action-items/${encodeURIComponent(actionItemRef)}/revise`, input, options);
}
export function completeActionItem(actionItemRef: string, expectedDocVersion: number, options?: NmRequestOptions): Promise<NmApiResult<ActionItemDto>> {
  return postJson(`/api/notes-meetings/action-items/${encodeURIComponent(actionItemRef)}/complete`, { expectedDocVersion }, options);
}
export function cancelActionItem(actionItemRef: string, input: { expectedDocVersion: number; reason: string }, options?: NmRequestOptions): Promise<NmApiResult<ActionItemDto>> {
  return postJson(`/api/notes-meetings/action-items/${encodeURIComponent(actionItemRef)}/cancel`, input, options);
}
export function promoteActionItem(actionItemRef: string, input: { assigneeUserRef?: string; priority?: string } = {}, options?: NmRequestOptions): Promise<NmApiResult<ActionItemDto>> {
  return postJson(`/api/notes-meetings/action-items/${encodeURIComponent(actionItemRef)}/promote`, input, options);
}
export function listActionItemVersions(actionItemRef: string, options?: NmRequestOptions) {
  return getJson<{ versions: unknown[] }>(`/api/notes-meetings/action-items/${encodeURIComponent(actionItemRef)}/versions`, options);
}
export function listActionItemEvents(actionItemRef: string, options?: NmRequestOptions): Promise<NmApiResult<{ events: NotesMeetingsEventDto[] }>> {
  return getJson(`/api/notes-meetings/action-items/${encodeURIComponent(actionItemRef)}/events`, options);
}

// --- Attachments (download href only - the browser navigates/opens this directly; it re-authorizes
// server-side on every request, so there is nothing to "fetch" here) -------------------------------
export function attachmentDownloadHref(attachmentRef: string): string {
  return `/api/notes-meetings/attachments/${encodeURIComponent(attachmentRef)}`;
}

// --- Participant/assignee search -------------------------------------------------------------------
export type NmUserOption = { userRef: string; displayName: string | null; email: string; role: string; active: boolean };
export function searchActiveUsers(emailPrefix: string, options?: NmRequestOptions): Promise<NmApiResult<{ users: NmUserOption[] }>> {
  return getJson(`/api/notes-meetings/users/search${queryString({ emailPrefix: emailPrefix || undefined, limit: 10 })}`, options);
}

// --- Reverse lookup (Task -> Meeting Action Item deep link) -----------------------------------------
export function findActionItemByTask(taskRef: string, options?: NmRequestOptions): Promise<NmApiResult<{ found: boolean; actionItemRef?: string; meetingRef?: string; ownerType?: OwnerType; ownerRef?: string }>> {
  return getJson(`/api/notes-meetings/action-items/by-task/${encodeURIComponent(taskRef)}`, options);
}

// The real owner-record route for each SUPPORTED owner type, so a reverse deep link (Task -> Meeting)
// lands on the actual record with a real Notes & Meetings entry point - never a hardcoded wrong path.
const OWNER_DETAIL_ROUTE: Partial<Record<OwnerType, (ref: string) => string>> = {
  DISCOVERY_LEAD: (ref) => `/discovery/${encodeURIComponent(ref)}`,
  PARTNER: (ref) => `/partners/${encodeURIComponent(ref)}`,
  VENDOR: (ref) => `/vendors/${encodeURIComponent(ref)}`,
  CAMPAIGN: (ref) => `/campaigns/${encodeURIComponent(ref)}`,
  ASSIGNMENT: (ref) => `/assignments/${encodeURIComponent(ref)}`,
  CONTENT: (ref) => `/content/${encodeURIComponent(ref)}`,
};

export function ownerDetailHref(ownerType: OwnerType, ownerRef: string): string | null {
  return OWNER_DETAIL_ROUTE[ownerType]?.(ownerRef) ?? null;
}

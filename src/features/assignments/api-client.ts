// Thin client-side fetch wrappers around the Step 10A/10A.1 trusted
// Assignments API routes - the ONLY way any Assignment screen mutates or
// reads data. Every call here hits a real `/api/assignments/*` route,
// which independently re-verifies the actor server-side. Mirrors
// src/features/campaigns/api-client.ts's pattern/ApiResult shape exactly -
// Assignments has a "conflict" code too (external-submission session
// boundary, not used by anything this UI step calls, but kept for shape
// parity with the server's own AssignmentsServiceErrorCode).
import type { AssignmentDto } from "@/server/assignments/client-dto";
import type { CreateAssignmentInput, EditAssignmentBriefInput, ListAssignmentHistoryInput, ListAssignmentsInput, AssignmentHistoryEventDto } from "@/server/assignments/assignment-service";
import type { TransitionAssignmentInput } from "@/server/assignments/assignment-lifecycle-service";
import type { AssignmentListCursor } from "@/server/assignments/firestore";
import type { AssignmentEventListCursor } from "@/server/assignments/assignment-events";
import type { CreateExternalSubmissionSessionInput, SafeSubmissionSessionDto, SafeVendorOption } from "@/server/assignments/external-submission-service";
import type { SubmissionRecipientType } from "@/server/assignments/external-submission-types";

export type AssignmentsApiErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "not_ready" | "conflict" | "internal" | "network_error";

export type ReadinessIssue = { code: string; message: string };

export type AssignmentsApiResult<T> = { ok: true; data: T; status?: number } | { ok: false; status: number; code: AssignmentsApiErrorCode; error: string; blockers?: ReadinessIssue[] };

async function call<T>(input: string, init?: RequestInit): Promise<AssignmentsApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(input, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  } catch {
    return { ok: false, status: 0, code: "network_error", error: "Could not reach the server. Check your connection and try again." };
  }

  if (res.ok) {
    const data = (await res.json()) as T;
    return { ok: true, data, status: res.status };
  }

  let error = "Something went wrong.";
  let blockers: ReadinessIssue[] | undefined;
  try {
    const body = (await res.json()) as { error?: string; blockers?: ReadinessIssue[] };
    if (typeof body.error === "string") error = body.error;
    if (Array.isArray(body.blockers)) blockers = body.blockers;
  } catch {
    // No JSON body - keep the generic message.
  }

  const code: AssignmentsApiErrorCode =
    res.status === 401 || res.status === 403
      ? "unauthorized"
      : res.status === 404
        ? "not_found"
        : res.status === 400
          ? "invalid_input"
          : res.status === 409
            ? blockers
              ? "not_ready"
              : "stale_write"
            : "internal";

  return { ok: false, status: res.status, code, error, blockers };
}

function query(params: Record<string, string | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) search.append(key, v);
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

// ---- Assignments: list / get / edit ----

export type ListAssignmentsResult = { assignments: AssignmentDto[]; nextCursor: AssignmentListCursor | null };

export function listAssignments(input: ListAssignmentsInput = {}): Promise<AssignmentsApiResult<ListAssignmentsResult>> {
  const qs = query({
    limit: input.limit !== undefined ? String(input.limit) : undefined,
    cursor: input.cursor ? JSON.stringify(input.cursor) : undefined,
    status: input.status,
    campaignRef: input.campaignRef,
    partnerRef: input.partnerRef,
    platform: input.platform,
    assignedToMe: input.assignedToMe ? "true" : undefined,
  });
  return call(`/api/assignments${qs}`);
}

export function getAssignment(assignmentRef: string): Promise<AssignmentsApiResult<AssignmentDto>> {
  return call(`/api/assignments/${encodeURIComponent(assignmentRef)}`);
}

// Step 12C.1: contextual create from Campaign Detail. POST /api/assignments
// answers 201 when THIS call created the canonical Assignment and 200 when
// the permanent (campaign, partner) claim already existed and the existing
// Assignment was returned untouched (it also sends `X-Assignment-Outcome`).
// Anything other than a 201 is therefore reported as "existing" - never a
// false "created". The dialog must never treat "existing" as a fresh create.
export type CreateAssignmentOutcome = "created" | "existing";

export async function createAssignment(input: CreateAssignmentInput): Promise<AssignmentsApiResult<{ assignment: AssignmentDto; outcome: CreateAssignmentOutcome }>> {
  const result = await call<AssignmentDto>("/api/assignments", { method: "POST", body: JSON.stringify(input) });
  if (!result.ok) return result;
  return { ok: true, data: { assignment: result.data, outcome: result.status === 201 ? "created" : "existing" } };
}

export function editAssignmentBrief(assignmentRef: string, input: EditAssignmentBriefInput): Promise<AssignmentsApiResult<AssignmentDto>> {
  return call(`/api/assignments/${encodeURIComponent(assignmentRef)}`, { method: "PATCH", body: JSON.stringify(input) });
}

// ---- Lifecycle ----

export function transitionAssignmentLifecycle(assignmentRef: string, input: TransitionAssignmentInput): Promise<AssignmentsApiResult<{ version: number; status: AssignmentDto["status"] }>> {
  return call(`/api/assignments/${encodeURIComponent(assignmentRef)}/lifecycle`, { method: "POST", body: JSON.stringify(input) });
}

// ---- History (used only by the Detail page's History dialog) ----

export type ListAssignmentHistoryResult = { events: AssignmentHistoryEventDto[]; nextCursor: AssignmentEventListCursor | null };

export function getAssignmentHistory(assignmentRef: string, input: ListAssignmentHistoryInput = {}): Promise<AssignmentsApiResult<ListAssignmentHistoryResult>> {
  const qs = query({
    limit: input.limit !== undefined ? String(input.limit) : undefined,
    cursorCreatedAt: input.cursor?.createdAt,
    cursorId: input.cursor?.id,
  });
  return call(`/api/assignments/${encodeURIComponent(assignmentRef)}/history${qs}`);
}

// ---- WhatsApp share dialog support (Step 10C) ----

// A bounded, read-only lookup - never a broad Vendor list. Used only to
// decide whether the share dialog's "Current Vendor" recipient option
// should render at all.
export function getAssignmentCurrentVendor(assignmentRef: string): Promise<AssignmentsApiResult<{ vendor: SafeVendorOption | null }>> {
  return call(`/api/assignments/${encodeURIComponent(assignmentRef)}/current-vendor`);
}

// Creates a real, single-use external submission session - called ONLY
// from the share dialog's final "Open WhatsApp" confirmation with the
// public-link checkbox ON, never merely because the dialog opened or the
// checkbox was toggled. Returns the raw bearer token exactly once.
export function createSubmissionSession(assignmentRef: string, input: CreateExternalSubmissionSessionInput): Promise<AssignmentsApiResult<{ session: SafeSubmissionSessionDto; rawToken: string }>> {
  return call(`/api/assignments/${encodeURIComponent(assignmentRef)}/submission-sessions`, { method: "POST", body: JSON.stringify(input) });
}

// Step 11A.1: a bounded, read-only pre-check for an already-eligible
// active session for this exact (assignmentRef, recipientType,
// recipientRef) triple - so the Share dialog can warn the user BEFORE a
// blind create-then-fail against createSubmissionSession's own reuse
// guard.
export function getActiveSubmissionSession(
  assignmentRef: string,
  recipientType: SubmissionRecipientType,
  recipientRef?: string,
): Promise<AssignmentsApiResult<{ session: SafeSubmissionSessionDto | null }>> {
  const qs = query({ recipientType, recipientRef });
  return call(`/api/assignments/${encodeURIComponent(assignmentRef)}/submission-sessions${qs}`);
}

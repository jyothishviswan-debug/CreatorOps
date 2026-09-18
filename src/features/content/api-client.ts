// Thin client-side fetch wrappers around the Step 11A trusted Content API
// routes - the ONLY way any Content screen mutates or reads data. Every
// call here hits a real `/api/content/*` route, which independently
// re-verifies the actor server-side. Mirrors
// src/features/assignments/api-client.ts's pattern/ApiResult shape
// exactly.
import type { ContentDto } from "@/server/content/client-dto";
import type { ContentHistoryEventDto, GenerateContentFromAssignmentInput, ListContentHistoryInput, ListContentInput, StartContentProductionInput, SaveContentVersionInput } from "@/server/content/content-service";
import type { AddPublicationEvidenceInput, CancelContentInput, CompleteContentInput, ReviewContentDecisionInput, SubmitContentForReviewInput } from "@/server/content/content-lifecycle-service";
import type { ContentListCursor } from "@/server/content/firestore";
import type { ContentEventListCursor } from "@/server/content/content-events";

export type ContentApiErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "not_ready" | "conflict" | "internal" | "network_error";

export type ContentReadinessIssue = { code: string; message: string };

export type ContentApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: ContentApiErrorCode; error: string; blockers?: ContentReadinessIssue[] };

async function call<T>(input: string, init?: RequestInit): Promise<ContentApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(input, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  } catch {
    return { ok: false, status: 0, code: "network_error", error: "Could not reach the server. Check your connection and try again." };
  }

  if (res.ok) {
    const data = (await res.json()) as T;
    return { ok: true, data };
  }

  let error = "Something went wrong.";
  let blockers: ContentReadinessIssue[] | undefined;
  try {
    const body = (await res.json()) as { error?: string; blockers?: ContentReadinessIssue[] };
    if (typeof body.error === "string") error = body.error;
    if (Array.isArray(body.blockers)) blockers = body.blockers;
  } catch {
    // No JSON body - keep the generic message.
  }

  // Both stale-write and publication-identity-conflict errors are plain
  // 409s with no `blockers` array (only not_ready carries one) - the
  // server's own toContentHttpResponse doesn't send a separate
  // discriminator field for the two, so this mirrors Assignments'
  // api-client.ts's own identical simplification exactly: a 409 with
  // blockers is "not_ready", any other 409 is labeled "stale_write" here,
  // but callers that need the real distinction (e.g. the Publication
  // dialog's collision case) read `error` itself - the server's own
  // message text ("This URL ... is already claimed by another Content
  // record.") already carries that meaning verbatim.
  const code: ContentApiErrorCode =
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

// ---- Content: list / get ----

export type ListContentResult = { content: ContentDto[]; nextCursor: ContentListCursor | null };

export function listContent(input: ListContentInput = {}): Promise<ContentApiResult<ListContentResult>> {
  const qs = query({
    limit: input.limit !== undefined ? String(input.limit) : undefined,
    cursor: input.cursor ? JSON.stringify(input.cursor) : undefined,
    status: input.status,
    assignmentRef: input.assignmentRef,
    campaignRef: input.campaignRef,
    partnerRef: input.partnerRef,
    platform: input.platform,
    reviewPolicy: input.reviewPolicy,
    assignedToMe: input.assignedToMe ? "true" : undefined,
  });
  return call(`/api/content${qs}`);
}

export function getContent(contentRef: string): Promise<ContentApiResult<ContentDto>> {
  return call(`/api/content/${encodeURIComponent(contentRef)}`);
}

// ---- Generation (Assignment -> Content) ----

export function generateContentFromAssignment(input: GenerateContentFromAssignmentInput): Promise<ContentApiResult<ContentDto>> {
  return call(`/api/content`, { method: "POST", body: JSON.stringify(input) });
}

// ---- Lifecycle / production / review / publication ----

export function startContentProduction(contentRef: string, input: StartContentProductionInput): Promise<ContentApiResult<ContentDto>> {
  return call(`/api/content/${encodeURIComponent(contentRef)}/production`, { method: "POST", body: JSON.stringify(input) });
}

export function saveContentVersion(contentRef: string, input: SaveContentVersionInput): Promise<ContentApiResult<ContentDto>> {
  return call(`/api/content/${encodeURIComponent(contentRef)}/versions`, { method: "POST", body: JSON.stringify(input) });
}

export function submitContentForReview(contentRef: string, input: SubmitContentForReviewInput): Promise<ContentApiResult<ContentDto>> {
  return call(`/api/content/${encodeURIComponent(contentRef)}/submit`, { method: "POST", body: JSON.stringify(input) });
}

export function reviewContentDecision(contentRef: string, input: ReviewContentDecisionInput): Promise<ContentApiResult<ContentDto>> {
  return call(`/api/content/${encodeURIComponent(contentRef)}/review`, { method: "POST", body: JSON.stringify(input) });
}

export function addPublicationEvidence(contentRef: string, input: AddPublicationEvidenceInput): Promise<ContentApiResult<ContentDto>> {
  return call(`/api/content/${encodeURIComponent(contentRef)}/publication-evidence`, { method: "POST", body: JSON.stringify(input) });
}

export function completeContent(contentRef: string, input: CompleteContentInput): Promise<ContentApiResult<ContentDto>> {
  return call(`/api/content/${encodeURIComponent(contentRef)}/complete`, { method: "POST", body: JSON.stringify(input) });
}

export function cancelContent(contentRef: string, input: CancelContentInput): Promise<ContentApiResult<ContentDto>> {
  return call(`/api/content/${encodeURIComponent(contentRef)}/cancel`, { method: "POST", body: JSON.stringify(input) });
}

// ---- History (Detail page's History dialog) ----

export type ListContentHistoryResult = { events: ContentHistoryEventDto[]; nextCursor: ContentEventListCursor | null };

export function getContentHistory(contentRef: string, input: ListContentHistoryInput = {}): Promise<ContentApiResult<ListContentHistoryResult>> {
  const qs = query({
    limit: input.limit !== undefined ? String(input.limit) : undefined,
    cursorCreatedAt: input.cursor?.createdAt,
    cursorId: input.cursor?.id,
  });
  return call(`/api/content/${encodeURIComponent(contentRef)}/history${qs}`);
}

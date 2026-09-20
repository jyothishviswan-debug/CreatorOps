// Thin client-side fetch wrappers around the accepted Partner Reviews API routes - the ONLY way any
// Partner Reviews screen mutates or pages data. Every call hits a real `/api/partner-reviews/*` route,
// which independently re-verifies the actor server-side (Feature + Action + live Partner scope). Mirrors
// src/features/assignments/api-client.ts's ApiResult shape.
import type { PartnerReviewDetailDto } from "@/server/partner-reviews/client-dto";
import type { PartnerReviewsWorkspaceDto, ReviewPartnerSearchResult } from "@/server/partner-reviews/partner-review-workspace-service";
import { workspaceQueryString, type WorkspaceQueryState } from "./workspace-query";

export type ReviewsApiErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "not_ready" | "conflict" | "internal" | "network_error";
export type ReviewsReadinessIssue = { code: string; message: string };
export type ReviewsApiResult<T> = { ok: true; data: T; status: number; outcome?: string | null } | { ok: false; status: number; code: ReviewsApiErrorCode; error: string; blockers?: ReviewsReadinessIssue[] };

async function call<T>(input: string, init?: RequestInit): Promise<ReviewsApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(input, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  } catch {
    return { ok: false, status: 0, code: "network_error", error: "Could not reach the server. Check your connection and try again." };
  }

  if (res.ok) return { ok: true, data: (await res.json()) as T, status: res.status, outcome: res.headers.get("X-Partner-Review-Outcome") };

  let error = "Something went wrong.";
  let blockers: ReviewsReadinessIssue[] | undefined;
  try {
    const body = (await res.json()) as { error?: string; blockers?: ReviewsReadinessIssue[] };
    if (typeof body.error === "string") error = body.error;
    if (Array.isArray(body.blockers)) blockers = body.blockers;
  } catch {
    // No JSON body - keep the generic message.
  }

  const code: ReviewsApiErrorCode = res.status === 401 || res.status === 403 ? "unauthorized" : res.status === 404 ? "not_found" : res.status === 400 ? "invalid_input" : res.status === 409 ? (blockers ? "not_ready" : "stale_write") : "internal";
  return { ok: false, status: res.status, code, error, blockers };
}

// ---- Reads ------------------------------------------------------------------------------------
export function loadWorkspacePage(state: WorkspaceQueryState & { cursor?: string; limit?: number }): Promise<ReviewsApiResult<PartnerReviewsWorkspaceDto>> {
  return call(`/api/partner-reviews/workspace${workspaceQueryString(state)}`);
}

export function searchReviewPartnersApi(input: { q: string; signal?: AbortSignal }): Promise<ReviewsApiResult<ReviewPartnerSearchResult>> {
  const search = new URLSearchParams();
  if (input.q) search.set("q", input.q);
  const qs = search.toString();
  return call(`/api/partner-reviews/partners/search${qs ? `?${qs}` : ""}`, { signal: input.signal });
}

// ---- Mutations (accepted routes only; the server owns every rule) ---------------------------------
export function generateReview(input: { partnerRef: string; periodKey: string }): Promise<ReviewsApiResult<PartnerReviewDetailDto>> {
  return call(`/api/partner-reviews`, { method: "POST", body: JSON.stringify(input) });
}

export function refreshReviewEvidence(reviewRef: string, input: { version?: number; expectedDocVersion: number }): Promise<ReviewsApiResult<PartnerReviewDetailDto>> {
  return call(`/api/partner-reviews/${reviewRef}/refresh`, { method: "POST", body: JSON.stringify(input) });
}

export function submitReview(reviewRef: string, input: { version?: number; expectedDocVersion: number }): Promise<ReviewsApiResult<PartnerReviewDetailDto>> {
  return call(`/api/partner-reviews/${reviewRef}/submit`, { method: "POST", body: JSON.stringify(input) });
}

export function finalizeReview(reviewRef: string, input: { version?: number; expectedDocVersion: number }): Promise<ReviewsApiResult<PartnerReviewDetailDto>> {
  return call(`/api/partner-reviews/${reviewRef}/finalize`, { method: "POST", body: JSON.stringify(input) });
}

export function createReviewRevision(reviewRef: string, input: { expectedDocVersion: number }): Promise<ReviewsApiResult<PartnerReviewDetailDto>> {
  return call(`/api/partner-reviews/${reviewRef}/revision`, { method: "POST", body: JSON.stringify(input) });
}

// Reloads one review's detail (the "reload" after a stale write).
export function loadReviewDetail(reviewRef: string, version?: number): Promise<ReviewsApiResult<PartnerReviewDetailDto>> {
  return call(`/api/partner-reviews/${reviewRef}${version ? `?version=${version}` : ""}`);
}

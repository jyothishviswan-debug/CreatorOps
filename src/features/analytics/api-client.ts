// Thin client-side fetch wrappers around the trusted Analytics API
// routes - mirrors src/features/content/api-client.ts's/
// src/features/assignments/api-client.ts's ApiResult shape/pattern
// exactly. Every call independently re-verifies the actor server-side.
import type { AnalyticsLabelMaps } from "@/server/analytics/label-resolution";
import type { AnalyticsPartnerAccountCandidateDto } from "@/server/analytics/partner-account-candidates";
import type { PartnerSearchResultDto } from "@/server/analytics/partners-workspace-dto";
import type { ResolveAnalyticsSourceRecordMatchInput, ResolveAnalyticsSourceRecordMatchResult } from "@/server/analytics/correction-service";
import type { AnalyticsImportBatchDetailDto, AnalyticsImportBatchListCursor, AnalyticsImportBatchListItemDto } from "@/server/analytics/import-history-service";
import type { AnalyticsSourceRecordListCursor } from "@/server/analytics/firestore";
import type { AnalyticsChannelSourceRecordDoc, AnalyticsContentSourceRecordDoc } from "@/server/analytics/types";

export type AnalyticsApiErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "conflict" | "internal" | "network_error";
export type AnalyticsApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: AnalyticsApiErrorCode; error: string };

async function call<T>(input: string, init?: RequestInit): Promise<AnalyticsApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(input, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  } catch {
    return { ok: false, status: 0, code: "network_error", error: "Could not reach the server. Check your connection and try again." };
  }
  if (res.ok) return { ok: true, data: (await res.json()) as T };

  let error = "Something went wrong.";
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === "string") error = body.error;
  } catch {
    // No JSON body - keep the generic message.
  }
  const code: AnalyticsApiErrorCode = res.status === 401 || res.status === 403 ? "unauthorized" : res.status === 404 ? "not_found" : res.status === 400 ? "invalid_input" : res.status === 409 ? "stale_write" : "internal";
  return { ok: false, status: res.status, code, error };
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, value);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

// ---- Data Explorer -------------------------------------------------------

export type ListAnalyticsRecordsResult =
  | { recordKind: "content"; records: AnalyticsContentSourceRecordDoc[]; nextCursor: AnalyticsSourceRecordListCursor | null }
  | { recordKind: "channel"; records: AnalyticsChannelSourceRecordDoc[]; nextCursor: AnalyticsSourceRecordListCursor | null };

export type ListAnalyticsRecordsInput = {
  recordKind: "content" | "channel";
  limit?: number;
  cursor?: AnalyticsSourceRecordListCursor;
  matchState?: "MATCHED" | "UNMATCHED" | "AMBIGUOUS";
  platform?: string;
  batchRef?: string;
  matchedCampaignRef?: string;
  matchedPartnerRef?: string;
  matchedPartnerAccountRef?: string;
  matchedContentRef?: string;
};

export function listAnalyticsRecords(input: ListAnalyticsRecordsInput): Promise<AnalyticsApiResult<ListAnalyticsRecordsResult>> {
  const qs = query({
    recordKind: input.recordKind,
    limit: input.limit !== undefined ? String(input.limit) : undefined,
    cursor: input.cursor ? JSON.stringify(input.cursor) : undefined,
    matchState: input.matchState,
    platform: input.platform,
    batchRef: input.batchRef,
    matchedCampaignRef: input.matchedCampaignRef,
    matchedPartnerRef: input.matchedPartnerRef,
    matchedPartnerAccountRef: input.matchedPartnerAccountRef,
    matchedContentRef: input.matchedContentRef,
  });
  return call(`/api/analytics/records${qs}`);
}

export function resolveAnalyticsLabels(input: { contentRefs?: string[]; campaignRefs?: string[]; partnerRefs?: string[]; partnerAccountRefs?: string[]; batchRefs?: string[] }): Promise<AnalyticsApiResult<AnalyticsLabelMaps>> {
  return call(`/api/analytics/labels`, { method: "POST", body: JSON.stringify(input) });
}

export function resolveAnalyticsSourceRecordMatch(input: ResolveAnalyticsSourceRecordMatchInput): Promise<AnalyticsApiResult<ResolveAnalyticsSourceRecordMatchResult>> {
  return call(`/api/analytics/corrections`, { method: "POST", body: JSON.stringify(input) });
}

export function searchAnalyticsPartnerAccountCandidates(input: { query?: string; platform?: string; limit?: number }): Promise<AnalyticsApiResult<AnalyticsPartnerAccountCandidateDto[]>> {
  const qs = query({ query: input.query, platform: input.platform, limit: input.limit !== undefined ? String(input.limit) : undefined });
  return call(`/api/analytics/partner-accounts/search${qs}`);
}

// Step 12F: the Partners Analytics selector's bounded, scope-first Partner search.
// `signal` lets the caller abort a stale keystroke's request.
export function searchAnalyticsWorkspacePartners(input: { q?: string; targetAudience?: string[]; region?: string[]; limit?: number; signal?: AbortSignal }): Promise<AnalyticsApiResult<{ partners: PartnerSearchResultDto[]; hasMore: boolean }>> {
  const search = new URLSearchParams();
  if (input.q) search.set("q", input.q);
  for (const value of input.targetAudience ?? []) search.append("targetAudience", value);
  for (const value of input.region ?? []) search.append("region", value);
  if (input.limit !== undefined) search.set("limit", String(input.limit));
  const qs = search.toString();
  return call(`/api/analytics/partners/search${qs ? `?${qs}` : ""}`, { signal: input.signal });
}

// ---- Import History -------------------------------------------------------

export function listAnalyticsImportBatches(input: {
  limit?: number;
  cursor?: AnalyticsImportBatchListCursor;
  targetKind?: "campaign_content" | "channel_account";
  status?: string;
}): Promise<AnalyticsApiResult<{ batches: AnalyticsImportBatchListItemDto[]; nextCursor: AnalyticsImportBatchListCursor | null }>> {
  const qs = query({ limit: input.limit !== undefined ? String(input.limit) : undefined, cursor: input.cursor ? JSON.stringify(input.cursor) : undefined, targetKind: input.targetKind, status: input.status });
  return call(`/api/imports/batches${qs}`);
}

export function getAnalyticsImportBatchDetail(batchRef: string): Promise<AnalyticsApiResult<AnalyticsImportBatchDetailDto>> {
  return call(`/api/imports/batches/${encodeURIComponent(batchRef)}`);
}

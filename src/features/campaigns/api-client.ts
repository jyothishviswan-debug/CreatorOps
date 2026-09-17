// Thin client-side fetch wrappers around the Step 9A/9A.1 trusted
// Campaigns API routes - the ONLY way any Campaign screen mutates data.
// Every call here hits a real `/api/campaigns/*` route, which
// independently re-verifies the actor server-side. Mirrors
// src/features/vendors/api-client.ts's pattern and ApiResult shape -
// Campaigns has no "conflict" code (unlike Vendors' GST collision), only
// stale_write and not_ready share the bare 409 status.
import type { CampaignDto } from "@/server/campaigns/client-dto";
import type {
  AddCampaignResourceInput,
  CampaignHistoryEventDto,
  CreateCampaignInput,
  EditCampaignInput,
  EditCampaignResourceInput,
  ListCampaignHistoryInput,
  ListCampaignsInput,
  RemoveCampaignResourceInput,
  SetCampaignOwnerTeamInput,
} from "@/server/campaigns/campaign-service";
import type { TransitionCampaignInput } from "@/server/campaigns/campaign-lifecycle-service";
import type { CampaignListCursor } from "@/server/campaigns/firestore";
import type { CampaignEventListCursor } from "@/server/campaigns/campaign-events";
import type { CampaignReadinessResult } from "@/server/campaigns/types";
import type { CampaignOwnerCandidateDto } from "@/server/campaigns/user-picker";

export type CampaignsApiErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "not_ready" | "internal" | "network_error";

export type ReadinessIssue = { code: string; message: string };

export type CampaignsApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: CampaignsApiErrorCode; error: string; blockers?: ReadinessIssue[] };

async function call<T>(input: string, init?: RequestInit): Promise<CampaignsApiResult<T>> {
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
  let blockers: ReadinessIssue[] | undefined;
  try {
    const body = (await res.json()) as { error?: string; blockers?: ReadinessIssue[] };
    if (typeof body.error === "string") error = body.error;
    if (Array.isArray(body.blockers)) blockers = body.blockers;
  } catch {
    // No JSON body - keep the generic message.
  }

  const code: CampaignsApiErrorCode =
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
    // A multi-select filter (e.g. region) sends one query param per
    // value - the API route reads them back with getAll(key).
    for (const v of Array.isArray(value) ? value : [value]) search.append(key, v);
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

// ---- Campaigns: list / get / create / edit ----

export type ListCampaignsResult = { campaigns: CampaignDto[]; nextCursor: CampaignListCursor | null };

export function listCampaigns(input: ListCampaignsInput = {}): Promise<CampaignsApiResult<ListCampaignsResult>> {
  const qs = query({
    limit: input.limit !== undefined ? String(input.limit) : undefined,
    cursor: input.cursor ? JSON.stringify(input.cursor) : undefined,
    status: input.status,
    namePrefix: input.namePrefix,
    region: input.region,
    platform: input.platform,
    assignedToMe: input.assignedToMe ? "true" : undefined,
  });
  return call(`/api/campaigns${qs}`);
}

export function getCampaign(campaignRef: string): Promise<CampaignsApiResult<CampaignDto>> {
  return call(`/api/campaigns/${encodeURIComponent(campaignRef)}`);
}

export function createCampaign(input: CreateCampaignInput): Promise<CampaignsApiResult<CampaignDto>> {
  return call("/api/campaigns", { method: "POST", body: JSON.stringify(input) });
}

export function editCampaign(campaignRef: string, input: EditCampaignInput): Promise<CampaignsApiResult<CampaignDto>> {
  return call(`/api/campaigns/${encodeURIComponent(campaignRef)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function setCampaignOwnerTeam(campaignRef: string, input: SetCampaignOwnerTeamInput): Promise<CampaignsApiResult<CampaignDto>> {
  return call(`/api/campaigns/${encodeURIComponent(campaignRef)}/owner`, { method: "POST", body: JSON.stringify(input) });
}

// ---- Lifecycle ----

export function transitionCampaignLifecycle(campaignRef: string, input: TransitionCampaignInput): Promise<CampaignsApiResult<{ version: number; status: CampaignDto["status"] }>> {
  return call(`/api/campaigns/${encodeURIComponent(campaignRef)}/lifecycle`, { method: "POST", body: JSON.stringify(input) });
}

export function getCampaignReadiness(campaignRef: string): Promise<CampaignsApiResult<CampaignReadinessResult>> {
  return call(`/api/campaigns/${encodeURIComponent(campaignRef)}/readiness`);
}

// ---- History ----

export type ListCampaignHistoryResult = { events: CampaignHistoryEventDto[]; nextCursor: CampaignEventListCursor | null };

export function getCampaignHistory(campaignRef: string, input: ListCampaignHistoryInput = {}): Promise<CampaignsApiResult<ListCampaignHistoryResult>> {
  const qs = query({
    limit: input.limit !== undefined ? String(input.limit) : undefined,
    cursorCreatedAt: input.cursor?.createdAt,
    cursorId: input.cursor?.id,
  });
  return call(`/api/campaigns/${encodeURIComponent(campaignRef)}/history${qs}`);
}

// ---- Resources ----

export function addCampaignResource(campaignRef: string, input: AddCampaignResourceInput): Promise<CampaignsApiResult<CampaignDto>> {
  return call(`/api/campaigns/${encodeURIComponent(campaignRef)}/resources`, { method: "POST", body: JSON.stringify(input) });
}

export function editCampaignResource(campaignRef: string, input: EditCampaignResourceInput): Promise<CampaignsApiResult<CampaignDto>> {
  return call(`/api/campaigns/${encodeURIComponent(campaignRef)}/resources`, { method: "PATCH", body: JSON.stringify(input) });
}

export function removeCampaignResource(campaignRef: string, input: RemoveCampaignResourceInput): Promise<CampaignsApiResult<CampaignDto>> {
  return call(`/api/campaigns/${encodeURIComponent(campaignRef)}/resources`, { method: "DELETE", body: JSON.stringify(input) });
}

// ---- Owner picker ----

export function searchCampaignOwnerCandidates(emailPrefix: string): Promise<CampaignsApiResult<CampaignOwnerCandidateDto[]>> {
  return call(`/api/campaigns/users/search${query({ emailPrefix })}`);
}

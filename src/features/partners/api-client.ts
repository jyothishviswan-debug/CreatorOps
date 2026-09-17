// Thin client-side fetch wrappers around the Step 7A/7A.1 trusted
// Partners API routes - the ONLY way any Partners screen mutates data.
// Every call here hits a real `/api/partners/*` route, which
// independently re-verifies the actor server-side. Mirrors
// src/features/discovery/api-client.ts's pattern and ApiResult shape -
// Partners' own "not_ready" (governance dependency check) carries
// structured `blockers` the same way Discovery's readiness does.
//
// The server distinguishes "stale_write" (optimistic-concurrency
// mismatch) from "conflict" (e.g. an identity collision) - both surface
// as a bare 409 with only a message (see toPartnersHttpResponse). This
// client collapses them into one "conflict" code: the UI only needs one
// "conflict/stale - reload or resolve" state either way (see Step 7B's
// own state list), and the message text itself already says which one
// happened.
import type { PartnerDto, PartnerAccountDto } from "@/server/partners/client-dto";
import type { PartnerRestrictedIdentityDto } from "@/server/partners/restricted-identity-service";
import type { PartnerOwnerCandidateDto } from "@/server/partners/user-picker";
import type { CreatePartnerInput, EditPartnerInput, ListPartnersInput, ListPartnerHistoryInput, PartnerHistoryEventDto, SetPartnerOwnerTeamInput, SetPartnerStatusInput } from "@/server/partners/partner-service";
import type { BlacklistPartnerInput, ArchivePartnerInput, RestorePartnerInput } from "@/server/partners/partner-lifecycle-service";
import type { CreatePartnerAccountInput, EditPartnerAccountInput, SetPartnerAccountStatusInput, SetPrimaryPartnerAccountInput } from "@/server/partners/partner-account-service";
import type { SavePartnerRestrictedIdentityInput } from "@/server/partners/restricted-identity-service";
import type { PartnerListCursor } from "@/server/partners/firestore";
import type { PartnerEventListCursor } from "@/server/partners/partner-events";
import type { PartnerDuplicateCheckResult } from "@/server/partners/types";

export type PartnersApiErrorCode = "unauthorized" | "not_found" | "invalid_input" | "conflict" | "not_ready" | "internal" | "network_error";

export type ReadinessIssue = { code: string; message: string };

export type PartnersApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: PartnersApiErrorCode; error: string; blockers?: ReadinessIssue[] };

async function call<T>(input: string, init?: RequestInit): Promise<PartnersApiResult<T>> {
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

  const code: PartnersApiErrorCode =
    res.status === 401 || res.status === 403
      ? "unauthorized"
      : res.status === 404
        ? "not_found"
        : res.status === 400
          ? "invalid_input"
          : res.status === 409
            ? blockers
              ? "not_ready"
              : "conflict"
            : "internal";

  return { ok: false, status: res.status, code, error, blockers };
}

function query(params: Record<string, string | undefined>): string {
  const usable = Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined);
  if (usable.length === 0) return "";
  return `?${new URLSearchParams(usable).toString()}`;
}

// ---- Partners: list / get / create / edit ----

export type ListPartnersResult = { partners: PartnerDto[]; nextCursor: PartnerListCursor | null };

export function listPartners(input: ListPartnersInput = {}): Promise<PartnersApiResult<ListPartnersResult>> {
  const qs = query({
    limit: input.limit !== undefined ? String(input.limit) : undefined,
    cursorOrderValue: input.cursor?.orderValue,
    cursorUid: input.cursor?.uid,
    status: input.status,
    displayNamePrefix: input.displayNamePrefix,
    region: input.region,
    tier: input.tier,
    targetAudience: input.targetAudience,
    assignedToMe: input.assignedToMe ? "true" : undefined,
    pendingPartnerAccountSetup: input.pendingPartnerAccountSetup ? "true" : undefined,
  });
  return call(`/api/partners${qs}`);
}

export function getPartner(partnerRef: string): Promise<PartnersApiResult<PartnerDto>> {
  return call(`/api/partners/${encodeURIComponent(partnerRef)}`);
}

export function createPartner(input: CreatePartnerInput): Promise<PartnersApiResult<PartnerDto>> {
  return call("/api/partners", { method: "POST", body: JSON.stringify(input) });
}

export function editPartner(partnerRef: string, input: EditPartnerInput): Promise<PartnersApiResult<PartnerDto>> {
  return call(`/api/partners/${encodeURIComponent(partnerRef)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function setPartnerOwnerTeam(partnerRef: string, input: SetPartnerOwnerTeamInput): Promise<PartnersApiResult<PartnerDto>> {
  return call(`/api/partners/${encodeURIComponent(partnerRef)}/owner`, { method: "POST", body: JSON.stringify(input) });
}

export function setPartnerStatus(partnerRef: string, input: SetPartnerStatusInput): Promise<PartnersApiResult<PartnerDto>> {
  return call(`/api/partners/${encodeURIComponent(partnerRef)}/status`, { method: "POST", body: JSON.stringify(input) });
}

// ---- Governance lifecycle ----

export function blacklistPartner(partnerRef: string, input: BlacklistPartnerInput): Promise<PartnersApiResult<PartnerDto>> {
  return call(`/api/partners/${encodeURIComponent(partnerRef)}/blacklist`, { method: "POST", body: JSON.stringify(input) });
}

export function archivePartner(partnerRef: string, input: ArchivePartnerInput): Promise<PartnersApiResult<PartnerDto>> {
  return call(`/api/partners/${encodeURIComponent(partnerRef)}/archive`, { method: "POST", body: JSON.stringify(input) });
}

export function restorePartner(partnerRef: string, input: RestorePartnerInput): Promise<PartnersApiResult<PartnerDto>> {
  return call(`/api/partners/${encodeURIComponent(partnerRef)}/restore`, { method: "POST", body: JSON.stringify(input) });
}

// ---- History ----

export type ListPartnerHistoryResult = { events: PartnerHistoryEventDto[]; nextCursor: PartnerEventListCursor | null };

export function getPartnerHistory(partnerRef: string, input: ListPartnerHistoryInput = {}): Promise<PartnersApiResult<ListPartnerHistoryResult>> {
  const qs = query({
    limit: input.limit !== undefined ? String(input.limit) : undefined,
    cursorCreatedAt: input.cursor?.createdAt,
    cursorId: input.cursor?.id,
  });
  return call(`/api/partners/${encodeURIComponent(partnerRef)}/history${qs}`);
}

// ---- Partner Accounts ----

export function listPartnerAccounts(partnerRef: string): Promise<PartnersApiResult<PartnerAccountDto[]>> {
  return call(`/api/partners/${encodeURIComponent(partnerRef)}/accounts`);
}

export function createPartnerAccount(partnerRef: string, input: CreatePartnerAccountInput): Promise<PartnersApiResult<PartnerAccountDto>> {
  return call(`/api/partners/${encodeURIComponent(partnerRef)}/accounts`, { method: "POST", body: JSON.stringify(input) });
}

export function getPartnerAccount(partnerAccountRef: string): Promise<PartnersApiResult<PartnerAccountDto>> {
  return call(`/api/partners/accounts/${encodeURIComponent(partnerAccountRef)}`);
}

export function editPartnerAccount(partnerAccountRef: string, input: EditPartnerAccountInput): Promise<PartnersApiResult<PartnerAccountDto>> {
  return call(`/api/partners/accounts/${encodeURIComponent(partnerAccountRef)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function setPartnerAccountStatus(partnerAccountRef: string, input: SetPartnerAccountStatusInput): Promise<PartnersApiResult<PartnerAccountDto>> {
  return call(`/api/partners/accounts/${encodeURIComponent(partnerAccountRef)}/status`, { method: "POST", body: JSON.stringify(input) });
}

export function setPrimaryPartnerAccount(partnerAccountRef: string, input: SetPrimaryPartnerAccountInput): Promise<PartnersApiResult<PartnerAccountDto>> {
  return call(`/api/partners/accounts/${encodeURIComponent(partnerAccountRef)}/primary`, { method: "POST", body: JSON.stringify(input) });
}

// ---- Restricted identity ----

export function getPartnerRestrictedIdentity(partnerRef: string): Promise<PartnersApiResult<PartnerRestrictedIdentityDto | null>> {
  return call(`/api/partners/${encodeURIComponent(partnerRef)}/restricted-identity`);
}

export function savePartnerRestrictedIdentity(partnerRef: string, input: SavePartnerRestrictedIdentityInput): Promise<PartnersApiResult<PartnerRestrictedIdentityDto>> {
  return call(`/api/partners/${encodeURIComponent(partnerRef)}/restricted-identity`, { method: "PUT", body: JSON.stringify(input) });
}

// ---- Duplicate check ----

export type PrecheckPartnerDuplicatesInput = {
  email?: string;
  phone?: string;
  originLeadRef?: string;
  accountIdentity?: { platform: string; platformAccountId?: string; profileUrl?: string; handle?: string };
};

export function precheckPartnerDuplicates(input: PrecheckPartnerDuplicatesInput): Promise<PartnersApiResult<PartnerDuplicateCheckResult>> {
  return call("/api/partners/duplicate-check", { method: "POST", body: JSON.stringify(input) });
}

// ---- Owner picker ----

export function searchPartnerOwnerCandidates(emailPrefix: string): Promise<PartnersApiResult<PartnerOwnerCandidateDto[]>> {
  return call(`/api/partners/users/search${query({ emailPrefix })}`);
}

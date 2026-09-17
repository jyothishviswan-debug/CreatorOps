// Thin client-side fetch wrappers around the Step 6A trusted Discovery
// API routes - the ONLY way any Discovery screen mutates data. Every
// call here hits a real `/api/discovery/*` route, which independently
// re-verifies the actor server-side; nothing here trusts or interprets
// access on its own. Mirrors src/features/administration/api-client.ts's
// pattern, with its own ApiResult shape since Discovery has a
// `not_ready` code (readiness-blocked conversion/transition) that
// carries structured `blockers` the caller needs to render.
import type { LeadDto } from "@/server/discovery/client-dto";
import type { AddKycLinkAttachmentInput, LeadKycDto, SaveKycInput } from "@/server/discovery/kyc-service";
import type { ConversionDto, ConvertLeadInput } from "@/server/discovery/conversion-service";
import type {
  AssignManagerInput,
  CreateLeadInput,
  ListLeadHistoryInput,
  ListLeadsInput,
  PrecheckDuplicatesInput,
  RecordOutreachInput,
  RecordReviewInput,
  SaveAgreementInput,
  SaveAssetDecisionInput,
  SaveCommercialInput,
  SaveResearchInput,
  UpdateLeadInput,
} from "@/server/discovery/lead-service";
import type { LeadListCursor } from "@/server/discovery/firestore";
import type { LeadEventListCursor } from "@/server/discovery/lead-events";
import type { LeadEvent, ReadinessResult, DuplicateCheckResult, LeadKycAttachment } from "@/server/discovery/types";
import type { RestoreLeadInput, TransitionLeadInput } from "@/server/discovery/lifecycle-service";
import type { ManagerCandidateDto } from "@/server/discovery/user-picker";

export type DiscoveryApiErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "not_ready" | "internal" | "network_error";

export type ReadinessIssue = { code: string; message: string };

export type DiscoveryApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: DiscoveryApiErrorCode; error: string; blockers?: ReadinessIssue[] };

async function call<T>(input: string, init?: RequestInit): Promise<DiscoveryApiResult<T>> {
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

  // 409 is shared by both "not_ready" (readiness-blocked, carries
  // blockers) and "stale_write" (optimistic-concurrency mismatch) on the
  // server - the presence of a blockers array is what distinguishes them
  // on this side, since Discovery never returns a generic "conflict".
  const code: DiscoveryApiErrorCode =
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

function query(params: Record<string, string | undefined>): string {
  const usable = Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined);
  if (usable.length === 0) return "";
  return `?${new URLSearchParams(usable).toString()}`;
}

// ---- Leads: list / get / create / edit ----

export type ListLeadsResult = { leads: LeadDto[]; nextCursor: LeadListCursor | null };

export function listLeads(input: ListLeadsInput = {}): Promise<DiscoveryApiResult<ListLeadsResult>> {
  const qs = query({
    limit: input.limit !== undefined ? String(input.limit) : undefined,
    cursorValue: input.cursor?.orderValue,
    cursorUid: input.cursor?.uid,
    lifecycle: input.lifecycle,
    region: input.region,
    platform: input.platform,
    assignedToMe: input.assignedToMe ? "true" : undefined,
    search: input.search,
    followUpDue: input.followUpDue ? "true" : undefined,
  });
  return call(`/api/discovery/leads${qs}`);
}

export function getLead(leadRef: string): Promise<DiscoveryApiResult<LeadDto>> {
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}`);
}

export function createLead(input: CreateLeadInput): Promise<DiscoveryApiResult<LeadDto>> {
  return call("/api/discovery/leads", { method: "POST", body: JSON.stringify(input) });
}

export function updateLead(leadRef: string, input: UpdateLeadInput): Promise<DiscoveryApiResult<LeadDto>> {
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}`, { method: "PATCH", body: JSON.stringify(input) });
}

// ---- Lifecycle ----

export function transitionLifecycle(leadRef: string, input: TransitionLeadInput): Promise<DiscoveryApiResult<{ version: number; lifecycle: LeadDto["lifecycle"] }>> {
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}/lifecycle`, { method: "POST", body: JSON.stringify(input) });
}

export function restoreLead(leadRef: string, input: RestoreLeadInput): Promise<DiscoveryApiResult<{ version: number; lifecycle: LeadDto["lifecycle"] }>> {
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}/lifecycle/restore`, { method: "POST", body: JSON.stringify(input) });
}

// ---- Evidence ----

export function saveResearch(leadRef: string, input: SaveResearchInput): Promise<DiscoveryApiResult<LeadDto>> {
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}/research`, { method: "POST", body: JSON.stringify(input) });
}

export function recordReview(leadRef: string, input: RecordReviewInput): Promise<DiscoveryApiResult<LeadDto>> {
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}/review`, { method: "POST", body: JSON.stringify(input) });
}

export function recordOutreach(leadRef: string, input: RecordOutreachInput): Promise<DiscoveryApiResult<LeadDto>> {
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}/outreach`, { method: "POST", body: JSON.stringify(input) });
}

export function saveCommercial(leadRef: string, input: SaveCommercialInput): Promise<DiscoveryApiResult<LeadDto>> {
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}/commercial`, { method: "POST", body: JSON.stringify(input) });
}

export function saveDiscoveryAgreement(leadRef: string, input: SaveAgreementInput): Promise<DiscoveryApiResult<LeadDto>> {
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}/agreement`, { method: "POST", body: JSON.stringify(input) });
}

export function saveAssetDecision(leadRef: string, input: SaveAssetDecisionInput): Promise<DiscoveryApiResult<LeadDto>> {
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}/asset-decision`, { method: "POST", body: JSON.stringify(input) });
}

export function assignManager(leadRef: string, input: AssignManagerInput): Promise<DiscoveryApiResult<LeadDto>> {
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}/manager`, { method: "POST", body: JSON.stringify(input) });
}

// ---- KYC ----

export function getLeadKyc(leadRef: string): Promise<DiscoveryApiResult<LeadKycDto | null>> {
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}/kyc`);
}

export function saveLeadKyc(leadRef: string, input: SaveKycInput): Promise<DiscoveryApiResult<{ version: number }>> {
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}/kyc`, { method: "PUT", body: JSON.stringify(input) });
}

export function addKycLinkAttachment(leadRef: string, input: AddKycLinkAttachmentInput): Promise<DiscoveryApiResult<{ version: number; attachment: LeadKycAttachment }>> {
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}/kyc/attachments`, { method: "POST", body: JSON.stringify(input) });
}

// A real file upload - deliberately bypasses `call`'s JSON Content-Type
// header (FormData needs the browser to set its own multipart boundary)
// and shares its response-parsing logic instead of duplicating it.
export async function uploadKycAttachment(
  leadRef: string,
  input: { docType: string; file: File; expectedKycVersion: number },
): Promise<DiscoveryApiResult<{ version: number; attachment: LeadKycAttachment }>> {
  const form = new FormData();
  form.set("docType", input.docType);
  form.set("expectedKycVersion", String(input.expectedKycVersion));
  form.set("file", input.file);

  let res: Response;
  try {
    res = await fetch(`/api/discovery/leads/${encodeURIComponent(leadRef)}/kyc/attachments`, { method: "POST", body: form });
  } catch {
    return { ok: false, status: 0, code: "network_error", error: "Could not reach the server. Check your connection and try again." };
  }

  if (res.ok) return { ok: true, data: (await res.json()) as { version: number; attachment: LeadKycAttachment } };

  let error = "Something went wrong.";
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === "string") error = body.error;
  } catch {
    // No JSON body - keep the generic message.
  }
  const code: DiscoveryApiErrorCode = res.status === 401 || res.status === 403 ? "unauthorized" : res.status === 404 ? "not_found" : res.status === 400 ? "invalid_input" : res.status === 409 ? "stale_write" : "internal";
  return { ok: false, status: res.status, code, error };
}

// ---- Duplicate check ----

export function precheckDuplicates(input: PrecheckDuplicatesInput): Promise<DiscoveryApiResult<DuplicateCheckResult>> {
  return call("/api/discovery/duplicate-check", { method: "POST", body: JSON.stringify(input) });
}

// ---- Readiness / conversion ----

export function getLeadReadiness(leadRef: string): Promise<DiscoveryApiResult<ReadinessResult & { leadRef: string; version: number; lifecycle: LeadDto["lifecycle"] }>> {
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}/readiness`);
}

export function convertLead(leadRef: string, input: ConvertLeadInput): Promise<DiscoveryApiResult<ConversionDto>> {
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}/convert`, { method: "POST", body: JSON.stringify(input) });
}

// ---- History ----

export type ListLeadHistoryResult = { events: (LeadEvent & { id: string; actorDisplayName: string | null })[]; nextCursor: LeadEventListCursor | null };

export function getLeadHistory(leadRef: string, input: ListLeadHistoryInput = {}): Promise<DiscoveryApiResult<ListLeadHistoryResult>> {
  const qs = query({
    limit: input.limit !== undefined ? String(input.limit) : undefined,
    cursorCreatedAt: input.cursor?.createdAt,
    cursorId: input.cursor?.id,
  });
  return call(`/api/discovery/leads/${encodeURIComponent(leadRef)}/history${qs}`);
}

// ---- Manager picker ----

export function searchManagerCandidates(emailPrefix: string): Promise<DiscoveryApiResult<ManagerCandidateDto[]>> {
  return call(`/api/discovery/users/search${query({ emailPrefix })}`);
}

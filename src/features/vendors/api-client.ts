// Thin client-side fetch wrappers around the Step 8A/8A.1/8A.2 trusted
// Vendors API routes - the ONLY way any Vendors screen mutates data.
// Every call here hits a real `/api/vendors/*` (or, for the Partner-side
// relationship slice, `/api/partners/*`) route, which independently
// re-verifies the actor server-side. Mirrors
// src/features/partners/api-client.ts's pattern and ApiResult shape.
import type { VendorDto, VendorPartnerLinkDto, VendorPartnerLinkWithPartnerDto, PartnerVendorLinkDto } from "@/server/vendors/client-dto";
import type { VendorRestrictedIdentityDto, SaveVendorRestrictedIdentityInput, AddVendorRestrictedIdentityLinkEvidenceInput } from "@/server/vendors/restricted-identity-service";
import type { RestrictedFinancialIdentityEvidence } from "@/server/shared/restricted-financial-identity";
import type { VendorOwnerCandidateDto } from "@/server/vendors/user-picker";
import type { CreateVendorInput, EditVendorInput, ListVendorsInput, ListVendorHistoryInput, VendorHistoryEventDto, SetVendorOwnerTeamInput, SetVendorStatusInput } from "@/server/vendors/vendor-service";
import type { ArchiveVendorInput, RestoreVendorInput } from "@/server/vendors/vendor-lifecycle-service";
import type { CreateVendorPartnerLinkInput, EditVendorPartnerLinkInput, EndVendorPartnerLinkInput, RestoreVendorPartnerLinkInput } from "@/server/vendors/vendor-partner-link-service";
import type { VendorListCursor } from "@/server/vendors/firestore";
import type { VendorEventListCursor } from "@/server/vendors/vendor-events";
import type { VendorDuplicateCheckResult } from "@/server/vendors/types";

export type VendorsApiErrorCode = "unauthorized" | "not_found" | "invalid_input" | "conflict" | "not_ready" | "internal" | "network_error";

export type ReadinessIssue = { code: string; message: string };

export type VendorsApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: VendorsApiErrorCode; error: string; blockers?: ReadinessIssue[] };

async function call<T>(input: string, init?: RequestInit): Promise<VendorsApiResult<T>> {
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

  const code: VendorsApiErrorCode =
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

// ---- Vendors: list / get / create / edit ----

export type ListVendorsResult = { vendors: VendorDto[]; nextCursor: VendorListCursor | null };

export function listVendors(input: ListVendorsInput = {}): Promise<VendorsApiResult<ListVendorsResult>> {
  const qs = query({
    limit: input.limit !== undefined ? String(input.limit) : undefined,
    // Opaque compound cursor (one entry per active scope branch, see
    // src/server/shared/scoped-list.ts) - round-tripped unchanged.
    cursor: input.cursor ? JSON.stringify(input.cursor) : undefined,
    status: input.status,
    displayNamePrefix: input.displayNamePrefix,
    region: input.region,
    vendorType: input.vendorType,
    assignedToMe: input.assignedToMe ? "true" : undefined,
  });
  return call(`/api/vendors${qs}`);
}

export function getVendor(vendorRef: string): Promise<VendorsApiResult<VendorDto>> {
  return call(`/api/vendors/${encodeURIComponent(vendorRef)}`);
}

export function createVendor(input: CreateVendorInput): Promise<VendorsApiResult<VendorDto>> {
  return call("/api/vendors", { method: "POST", body: JSON.stringify(input) });
}

export function editVendor(vendorRef: string, input: EditVendorInput): Promise<VendorsApiResult<VendorDto>> {
  return call(`/api/vendors/${encodeURIComponent(vendorRef)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function setVendorOwnerTeam(vendorRef: string, input: SetVendorOwnerTeamInput): Promise<VendorsApiResult<VendorDto>> {
  return call(`/api/vendors/${encodeURIComponent(vendorRef)}/owner`, { method: "POST", body: JSON.stringify(input) });
}

export function setVendorStatus(vendorRef: string, input: SetVendorStatusInput): Promise<VendorsApiResult<VendorDto>> {
  return call(`/api/vendors/${encodeURIComponent(vendorRef)}/status`, { method: "POST", body: JSON.stringify(input) });
}

// ---- Governance lifecycle ----

export function archiveVendor(vendorRef: string, input: ArchiveVendorInput): Promise<VendorsApiResult<VendorDto>> {
  return call(`/api/vendors/${encodeURIComponent(vendorRef)}/archive`, { method: "POST", body: JSON.stringify(input) });
}

export function restoreVendor(vendorRef: string, input: RestoreVendorInput): Promise<VendorsApiResult<VendorDto>> {
  return call(`/api/vendors/${encodeURIComponent(vendorRef)}/restore`, { method: "POST", body: JSON.stringify(input) });
}

// ---- History ----

export type ListVendorHistoryResult = { events: VendorHistoryEventDto[]; nextCursor: VendorEventListCursor | null };

export function getVendorHistory(vendorRef: string, input: ListVendorHistoryInput = {}): Promise<VendorsApiResult<ListVendorHistoryResult>> {
  const qs = query({
    limit: input.limit !== undefined ? String(input.limit) : undefined,
    cursorCreatedAt: input.cursor?.createdAt,
    cursorId: input.cursor?.id,
  });
  return call(`/api/vendors/${encodeURIComponent(vendorRef)}/history${qs}`);
}

// ---- Partner Relationships (vendorPartnerLinks) ----

export function listVendorPartnerLinks(vendorRef: string): Promise<VendorsApiResult<VendorPartnerLinkWithPartnerDto[]>> {
  return call(`/api/vendors/${encodeURIComponent(vendorRef)}/links`);
}

export function createVendorPartnerLink(vendorRef: string, input: CreateVendorPartnerLinkInput): Promise<VendorsApiResult<VendorPartnerLinkDto>> {
  return call(`/api/vendors/${encodeURIComponent(vendorRef)}/links`, { method: "POST", body: JSON.stringify(input) });
}

export function editVendorPartnerLink(linkRef: string, input: EditVendorPartnerLinkInput): Promise<VendorsApiResult<VendorPartnerLinkDto>> {
  return call(`/api/vendors/links/${encodeURIComponent(linkRef)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function endVendorPartnerLink(linkRef: string, input: EndVendorPartnerLinkInput): Promise<VendorsApiResult<VendorPartnerLinkDto>> {
  return call(`/api/vendors/links/${encodeURIComponent(linkRef)}/end`, { method: "POST", body: JSON.stringify(input) });
}

export function restoreVendorPartnerLink(linkRef: string, input: RestoreVendorPartnerLinkInput): Promise<VendorsApiResult<VendorPartnerLinkDto>> {
  return call(`/api/vendors/links/${encodeURIComponent(linkRef)}/restore`, { method: "POST", body: JSON.stringify(input) });
}

// ---- Restricted identity ----

export function getVendorRestrictedIdentity(vendorRef: string): Promise<VendorsApiResult<VendorRestrictedIdentityDto | null>> {
  return call(`/api/vendors/${encodeURIComponent(vendorRef)}/restricted-identity`);
}

export function saveVendorRestrictedIdentity(vendorRef: string, input: SaveVendorRestrictedIdentityInput): Promise<VendorsApiResult<VendorRestrictedIdentityDto>> {
  return call(`/api/vendors/${encodeURIComponent(vendorRef)}/restricted-identity`, { method: "PUT", body: JSON.stringify(input) });
}

// ---- Restricted identity evidence (real KYC upload, mirrors Discovery) ----

export function addVendorRestrictedIdentityLinkEvidence(
  vendorRef: string,
  input: AddVendorRestrictedIdentityLinkEvidenceInput,
): Promise<VendorsApiResult<{ version: number; evidence: RestrictedFinancialIdentityEvidence }>> {
  return call(`/api/vendors/${encodeURIComponent(vendorRef)}/restricted-identity/evidence`, { method: "POST", body: JSON.stringify(input) });
}

// A real file upload - deliberately bypasses `call`'s JSON Content-Type
// header (FormData needs the browser to set its own multipart boundary).
export async function uploadVendorRestrictedIdentityEvidence(
  vendorRef: string,
  input: { docType: string; file: File; expectedVersion: number },
): Promise<VendorsApiResult<{ version: number; evidence: RestrictedFinancialIdentityEvidence }>> {
  const form = new FormData();
  form.set("docType", input.docType);
  form.set("expectedVersion", String(input.expectedVersion));
  form.set("file", input.file);

  let res: Response;
  try {
    res = await fetch(`/api/vendors/${encodeURIComponent(vendorRef)}/restricted-identity/evidence`, { method: "POST", body: form });
  } catch {
    return { ok: false, status: 0, code: "network_error", error: "Could not reach the server. Check your connection and try again." };
  }

  if (res.ok) return { ok: true, data: (await res.json()) as { version: number; evidence: RestrictedFinancialIdentityEvidence } };

  let error = "Something went wrong.";
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === "string") error = body.error;
  } catch {
    // No JSON body - keep the generic message.
  }
  const code: VendorsApiErrorCode = res.status === 401 || res.status === 403 ? "unauthorized" : res.status === 404 ? "not_found" : res.status === 400 ? "invalid_input" : res.status === 409 ? "conflict" : "internal";
  return { ok: false, status: res.status, code, error };
}

// ---- Duplicate check ----

export type PrecheckVendorDuplicatesInput = { displayName?: string; email?: string; phone?: string };

export function precheckVendorDuplicates(input: PrecheckVendorDuplicatesInput): Promise<VendorsApiResult<VendorDuplicateCheckResult>> {
  return call("/api/vendors/duplicate-check", { method: "POST", body: JSON.stringify(input) });
}

// ---- Owner picker ----

export function searchVendorOwnerCandidates(emailPrefix: string): Promise<VendorsApiResult<VendorOwnerCandidateDto[]>> {
  return call(`/api/vendors/users/search${query({ emailPrefix })}`);
}

// ---- Partner-side relationship slice (Step 8A section 10 / Step 8B section 7) ----
// Lives under /api/partners/* because it is gated ENTIRELY by the
// Partner's own scope, never Vendor scope - see
// listVendorLinksForPartner's own comment.
export function listVendorLinksForPartner(partnerRef: string): Promise<VendorsApiResult<PartnerVendorLinkDto[]>> {
  return call(`/api/partners/${encodeURIComponent(partnerRef)}/vendor-links`);
}

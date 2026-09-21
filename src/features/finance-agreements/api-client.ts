// Step 14B: typed browser-side fetch wrappers for EVERY /api/finance/** route (plus the owning-module KYC evidence
// routes the KYC dialog needs). The ONLY way a Finance Agreements screen talks to the server.
//
// Contract of every function:
//   - NEVER throws: a network failure, an aborted request, a non-JSON body - all become a failure result;
//   - returns a discriminated result   { ok: true, status, data }
//                                    | { ok: false, status, kind, message, blockers?, aborted? };
//   - `kind` is a closed set the UI can switch over: unauthorized (401) | forbidden (403) | not_found (404) |
//     invalid (400/413/415) | stale (409 "changed elsewhere": reload and retry) | conflict (other 409) |
//     not_ready (409 with blockers - the confirm gate) | network | error;
//   - accepts an optional AbortSignal (`options.signal`); an aborted call resolves with kind "network" and
//     `aborted: true` so a caller can ignore it;
//   - the messages are safe to show as-is (the server's Finance denials are always the same neutral text).
//
// Optimistic concurrency (the server checks; the client must send the right counter):
//   decideField / attachExtractionProposals / confirmAgreementVersion  -> the VERSION doc's `docVersion`
//   activate / revise / suspend / resume / end                          -> the HEAD's `docVersion`
//   master-data command                                                 -> `expectedCounterpartyVersion` (the Partner / Vendor's own version)
// Every successful mutation returns the new AgreementDetailDto (or its outcome wrapper): ALWAYS replace client state with it.
import { addPartnerRestrictedIdentityLinkEvidence, uploadPartnerRestrictedIdentityEvidence, type PartnersApiResult } from "@/features/partners/api-client";
import { addVendorRestrictedIdentityLinkEvidence, uploadVendorRestrictedIdentityEvidence, type VendorsApiResult } from "@/features/vendors/api-client";
import type { AddPartnerRestrictedIdentityLinkEvidenceInput } from "@/server/partners/restricted-identity-service";
import type { RestrictedFinancialIdentityEvidence } from "@/server/shared/restricted-financial-identity";
import type { AgreementDocumentStatusResultDto, StoreAgreementDocumentOutcome } from "@/server/finance-agreements/agreement-document-service";
import type { AttachExtractionOutcome } from "@/server/finance-agreements/agreement-service";
import type { AgreementDetailDto, AgreementEventDto, AgreementHeadDto, AgreementVersionSummaryDto, ContractArtifactDto, CounterpartyAgreementDocumentsDto, ExtractionResultDto } from "@/server/finance-agreements/client-dto";
import type { CounterpartySearchResponse } from "@/server/finance-agreements/counterparty-picker-service";
import type { AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { OnboardingDuplicatesDto, OnboardingDuplicatesRequest, OnboardingOutcomeDto, OnboardingPreviewDto, OnboardingStatusRequest } from "@/server/finance-agreements/onboarding-dto";
import type { OnboardingRequest } from "@/server/finance-agreements/onboarding-input";
import type { ApplyExtractedKycOutcome, KycComponent, MasterDataMode, UpdateCounterpartyContactOutcome } from "@/server/finance-agreements/master-data-commands";
import type { AgreementKycStatusDto } from "@/server/finance-agreements/kyc-status-service";
import type { AgreementReconciliationDto } from "@/server/finance-agreements/reconciliation-service";
import type { AgreementCounterpartyInput, CounterpartyType } from "@/server/finance-agreements/types";
import type { AgreementWorkspaceDto, AgreementWorkspaceDiscrepancyFilter, AgreementWorkspaceLifecycleFilter, AgreementWorkspacePeriodFilter, CounterpartyPreviewDto, FinanceAgreementPermissionsDto } from "@/server/finance-agreements/workspace-dto";

// --- Result shapes ------------------------------------------------------------------------------------------------------------------
export type FinanceApiErrorKind = "unauthorized" | "forbidden" | "not_found" | "invalid" | "stale" | "conflict" | "not_ready" | "network" | "error";

// A confirm blocker (or any readiness issue): a stable code, a human message and, when it belongs to one field, its key.
export type FinanceApiBlocker = { code: string; message: string; fieldKey?: string };

export type FinanceApiSuccess<T> = { ok: true; status: number; data: T };
export type FinanceApiFailure = { ok: false; status: number; kind: FinanceApiErrorKind; message: string; blockers?: FinanceApiBlocker[]; aborted?: true };
export type FinanceApiResult<T> = FinanceApiSuccess<T> | FinanceApiFailure;

export type FinanceRequestOptions = { signal?: AbortSignal };

// The message shown for a denial. The server answers every Finance denial with one neutral body, and so does the UI.
export const FINANCE_DENIED_MESSAGE = "You do not have access to this.";
export const FINANCE_NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";
export const FINANCE_GENERIC_ERROR_MESSAGE = "Something went wrong.";

// --- Status -> kind ---------------------------------------------------------------------------------------------------------------
// Every "stale" outcome (agreement docVersion, or the Partner / Vendor version of a master-data command) carries the
// words "changed elsewhere"; any other 409 is a plain conflict (e.g. a confirmed version can no longer be edited).
const STALE_MESSAGE = /changed elsewhere/i;

export function isStaleMessage(message: string): boolean {
  return STALE_MESSAGE.test(message);
}

export function errorKindForStatus(status: number, options: { hasBlockers?: boolean; message?: string } = {}): FinanceApiErrorKind {
  if (status === 0) return "network";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400 || status === 413 || status === 415 || status === 422) return "invalid";
  if (status === 409) {
    if (options.hasBlockers) return "not_ready";
    return options.message && isStaleMessage(options.message) ? "stale" : "conflict";
  }
  return "error";
}

function readBlockers(value: unknown): FinanceApiBlocker[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const blockers: FinanceApiBlocker[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { code, message, fieldKey } = item as Record<string, unknown>;
    if (typeof code !== "string" || typeof message !== "string") continue;
    blockers.push(typeof fieldKey === "string" ? { code, message, fieldKey } : { code, message });
  }
  return blockers;
}

export function failureResult(status: number, message: string | undefined, blockers?: FinanceApiBlocker[]): FinanceApiFailure {
  const kind = errorKindForStatus(status, { hasBlockers: blockers !== undefined, message });
  const text = kind === "unauthorized" || kind === "forbidden" ? FINANCE_DENIED_MESSAGE : kind === "network" ? FINANCE_NETWORK_MESSAGE : (message?.trim() || FINANCE_GENERIC_ERROR_MESSAGE);
  return { ok: false, status, kind, message: text, ...(blockers ? { blockers } : {}) };
}

const abortedResult = (): FinanceApiFailure => ({ ok: false, status: 0, kind: "network", message: "The request was cancelled.", aborted: true });
const networkResult = (): FinanceApiFailure => ({ ok: false, status: 0, kind: "network", message: FINANCE_NETWORK_MESSAGE });

// --- Transport ------------------------------------------------------------------------------------------------------------------------
type SendInit = { method: "GET" | "POST"; json?: unknown; form?: FormData; signal?: AbortSignal };

async function send<T>(url: string, init: SendInit): Promise<FinanceApiResult<T>> {
  if (init.signal?.aborted) return abortedResult();
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    let body: BodyInit | undefined;
    if (init.form) {
      // multipart: the browser sets its own Content-Type with the boundary.
      body = init.form;
    } else if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const response = await fetch(url, { method: init.method, headers, body, signal: init.signal, cache: "no-store" });

    if (response.ok) {
      try {
        return { ok: true, status: response.status, data: (await response.json()) as T };
      } catch {
        return init.signal?.aborted ? abortedResult() : { ok: false, status: response.status, kind: "error", message: "Unexpected response from the server." };
      }
    }

    let message: string | undefined;
    let blockers: FinanceApiBlocker[] | undefined;
    try {
      const parsed = (await response.json()) as { error?: unknown; blockers?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
      blockers = readBlockers(parsed.blockers);
    } catch {
      // No JSON body - the status alone decides the kind.
    }
    return failureResult(response.status, message, blockers);
  } catch {
    return init.signal?.aborted ? abortedResult() : networkResult();
  }
}

function queryString(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const text = typeof value === "string" ? value.trim() : String(value);
    if (text === "") continue;
    search.set(key, text);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

const agreementPath = (agreementRef: string, suffix = "") => `/api/finance/agreements/${encodeURIComponent(agreementRef)}${suffix}`;
const getJson = <T>(url: string, options: FinanceRequestOptions | undefined) => send<T>(url, { method: "GET", signal: options?.signal });
const postJson = <T>(url: string, json: unknown, options: FinanceRequestOptions | undefined) => send<T>(url, { method: "POST", json, signal: options?.signal });

// --- Agreements: create / read ---------------------------------------------------------------------------------------------------------
export type CreateAgreementInput = {
  // ONE uuid per form mount, reused across retries; regenerate only after success or an intentional counterparty change.
  clientRequestId: string;
  counterparty: AgreementCounterpartyInput;
  sourceMode?: "MANUAL" | "EXTRACTED";
};

// 201 (status) = created, 200 = the same clientRequestId had already created it (idempotent retry). The body is the AgreementDetailDto.
export function createAgreementDraft(input: CreateAgreementInput, options?: FinanceRequestOptions): Promise<FinanceApiResult<AgreementDetailDto>> {
  return postJson<AgreementDetailDto>("/api/finance/agreements", input, options);
}

// A one-counterparty Agreement list (<= 50, newest update first). The workspace uses loadAgreementsWorkspace instead.
export function listAgreementsForCounterparty(counterpartyType: CounterpartyType, ref: string, options?: FinanceRequestOptions): Promise<FinanceApiResult<{ agreements: AgreementHeadDto[]; hasMore: boolean }>> {
  return getJson(`/api/finance/agreements${queryString({ counterpartyType, ref })}`, options);
}

// The head, bounded version summaries and one version's detail (default: the open version, else the governing one).
export function getAgreementDetail(agreementRef: string, input: { version?: number } = {}, options?: FinanceRequestOptions): Promise<FinanceApiResult<AgreementDetailDto>> {
  return getJson(agreementPath(agreementRef, queryString({ version: input.version })), options);
}

export function listAgreementVersions(agreementRef: string, options?: FinanceRequestOptions): Promise<FinanceApiResult<{ agreementRef: string; versions: AgreementVersionSummaryDto[]; hasMore: boolean }>> {
  return getJson(agreementPath(agreementRef, "/versions"), options);
}

// Audit events, newest first, one bounded page (limit 1-100, default 50). Metadata is allowlist-redacted server-side.
export function listAgreementEvents(agreementRef: string, input: { limit?: number } = {}, options?: FinanceRequestOptions): Promise<FinanceApiResult<{ agreementRef: string; events: AgreementEventDto[]; hasMore: boolean }>> {
  return getJson(agreementPath(agreementRef, `/events${queryString({ limit: input.limit })}`), options);
}

// --- Agreements: field decisions & confirm ------------------------------------------------------------------------------------------------
export type DecideFieldInput = {
  version: number;
  // The VERSION doc's docVersion (selectedVersion.docVersion) - the response carries the next value.
  expectedDocVersion: number;
  fieldKey: AgreementFieldKey;
  decision: "ACCEPTED" | "CORRECTED" | "UNAVAILABLE" | "NOT_APPLICABLE";
  // CORRECTED needs it; ACCEPTED may carry it; UNAVAILABLE / NOT_APPLICABLE and identity fields must NOT.
  value?: unknown;
  note?: string;
};
export function decideField(agreementRef: string, input: DecideFieldInput, options?: FinanceRequestOptions): Promise<FinanceApiResult<AgreementDetailDto>> {
  return postJson(agreementPath(agreementRef, "/fields"), input, options);
}

// 409 + blockers (kind "not_ready") when the version is not ready; each blocker names its field.
export function confirmAgreementVersion(agreementRef: string, input: { version: number; expectedDocVersion: number }, options?: FinanceRequestOptions): Promise<FinanceApiResult<AgreementDetailDto>> {
  return postJson(agreementPath(agreementRef, "/confirm"), input, options);
}

// --- Original signed Agreement document (Step 14B.1) ------------------------------------------------------------------------------------------
// Stores (or retries) the ORIGINAL signed PDF of a CONFIRMED version in Drive. Idempotent; needs manage_agreements. A Drive failure is a
// SUCCESSFUL call with data.outcome "failed" (retriable) - check `outcome`, never assume 200 means stored. data.agreement is the
// refreshed AgreementDetailDto (replace client state with it). The Drive link is on data.document only for finance_contracts holders.
export function storeAgreementDocument(agreementRef: string, input: { version: number; expectedDocVersion?: number }, options?: FinanceRequestOptions): Promise<FinanceApiResult<StoreAgreementDocumentOutcome>> {
  return postJson(agreementPath(agreementRef, "/document"), input, options);
}
// The document status of one version (default: open / governing) plus whether Drive storage is configured at all.
export function getAgreementDocumentStatus(agreementRef: string, input: { version?: number } = {}, options?: FinanceRequestOptions): Promise<FinanceApiResult<AgreementDocumentStatusResultDto>> {
  return getJson(agreementPath(agreementRef, `/document${queryString({ version: input.version })}`), options);
}
// The signed Agreement documents of ONE Partner / Vendor (same stored reference as Finance; link only for finance_contracts holders).
export function listCounterpartyAgreementDocuments(input: { counterpartyType: CounterpartyType; ref: string }, options?: FinanceRequestOptions): Promise<FinanceApiResult<CounterpartyAgreementDocumentsDto>> {
  return getJson(`/api/finance/counterparties/documents${queryString({ counterpartyType: input.counterpartyType, ref: input.ref })}`, options);
}

// --- Agreements: lifecycle (activate_agreements; expectedDocVersion = the HEAD's) ------------------------------------------------------------
export function activateAgreementVersion(agreementRef: string, input: { version: number; expectedDocVersion: number }, options?: FinanceRequestOptions): Promise<FinanceApiResult<AgreementDetailDto>> {
  return postJson(agreementPath(agreementRef, "/activate"), input, options);
}
export function createAgreementRevision(agreementRef: string, input: { expectedDocVersion: number }, options?: FinanceRequestOptions): Promise<FinanceApiResult<AgreementDetailDto>> {
  return postJson(agreementPath(agreementRef, "/revise"), input, options);
}
// reason: 3-1000 characters.
export function suspendAgreement(agreementRef: string, input: { expectedDocVersion: number; reason: string }, options?: FinanceRequestOptions): Promise<FinanceApiResult<AgreementDetailDto>> {
  return postJson(agreementPath(agreementRef, "/suspend"), input, options);
}
export function resumeAgreement(agreementRef: string, input: { expectedDocVersion: number }, options?: FinanceRequestOptions): Promise<FinanceApiResult<AgreementDetailDto>> {
  return postJson(agreementPath(agreementRef, "/resume"), input, options);
}
// Terminal. reason: 3-1000 characters.
export function endAgreement(agreementRef: string, input: { expectedDocVersion: number; reason: string }, options?: FinanceRequestOptions): Promise<FinanceApiResult<AgreementDetailDto>> {
  return postJson(agreementPath(agreementRef, "/end"), input, options);
}

// --- Contract upload / extraction ---------------------------------------------------------------------------------------------------------------
// multipart/form-data { file, counterpartyType, counterpartyRef }. PDF only, <= 10 MB (pre-check with checkContractFile;
// the server is the truth). status 201 = stored, 200 = the same bytes were already uploaded for that counterparty.
export function uploadContractArtifact(input: { file: File; counterpartyType: CounterpartyType; counterpartyRef: string }, options?: FinanceRequestOptions): Promise<FinanceApiResult<ContractArtifactDto>> {
  const form = new FormData();
  form.set("counterpartyType", input.counterpartyType);
  form.set("counterpartyRef", input.counterpartyRef);
  form.set("file", input.file, input.file.name);
  return send("/api/finance/contracts/upload", { method: "POST", form, signal: options?.signal });
}

// Parses one uploaded PDF into a recorded extraction run. A scanned / unreadable PDF is a MANUAL_REVIEW_REQUIRED result, not a failure.
export function extractContract(input: { agreementRef: string; version: number; artifactRef: string }, options?: FinanceRequestOptions): Promise<FinanceApiResult<ExtractionResultDto>> {
  return postJson("/api/finance/contracts/extract", input, options);
}

// One extraction run shaped for THIS actor (default: the latest run).
export function getExtractionResult(agreementRef: string, input: { runRef?: string } = {}, options?: FinanceRequestOptions): Promise<FinanceApiResult<ExtractionResultDto>> {
  return getJson(agreementPath(agreementRef, `/extraction${queryString({ runRef: input.runRef })}`), options);
}

// Copies the run's non-restricted proposals into the open draft as PENDING (never accepted). expectedDocVersion = the VERSION doc's.
export function attachExtractionProposals(agreementRef: string, input: { version: number; expectedDocVersion: number; extractionRunRef: string }, options?: FinanceRequestOptions): Promise<FinanceApiResult<AttachExtractionOutcome>> {
  return postJson(agreementPath(agreementRef, "/extraction/attach"), input, options);
}

// --- Reconciliation / KYC / master data ---------------------------------------------------------------------------------------------------------------
export function getAgreementReconciliation(agreementRef: string, input: { version?: number } = {}, options?: FinanceRequestOptions): Promise<FinanceApiResult<AgreementReconciliationDto>> {
  return getJson(agreementPath(agreementRef, `/reconciliation${queryString({ version: input.version })}`), options);
}

// KYC completeness of the counterparty as STATUS only (per-component detail needs the identity category; never a value).
export function getAgreementKycStatus(agreementRef: string, options?: FinanceRequestOptions): Promise<FinanceApiResult<AgreementKycStatusDto>> {
  return getJson(agreementPath(agreementRef, "/kyc-status"), options);
}

export type UpdateMasterDataInput = {
  version: number;
  fieldKey: "emailAddress" | "contactNumber";
  mode: MasterDataMode;
  // Required for OVERWRITE_MISMATCH: the deliberate acknowledgement + reason (3-1000 characters).
  resolution?: { acknowledged: true; reason: string };
  // The Partner's / Vendor's own `version` the person saw (NOT a docVersion).
  expectedCounterpartyVersion: number;
  // Optional: the version doc's docVersion the person saw.
  expectedDocVersion?: number;
};
// Copies ONE decided email / phone onto the Partner / Vendor through the OWNING module. Saving an Agreement never does this.
export function updateCounterpartyContact(agreementRef: string, input: UpdateMasterDataInput, options?: FinanceRequestOptions): Promise<FinanceApiResult<UpdateCounterpartyContactOutcome>> {
  return postJson(agreementPath(agreementRef, "/master-data"), input, options);
}

export type ApplyKycInput = {
  version: number;
  components: KycComponent[];
  mode: MasterDataMode;
  resolution?: { acknowledged: true; reason: string };
};
// Fills MISSING restricted KYC components on the canonical record from the extraction, through the owning module. Bank is refused.
export function applyExtractedKyc(agreementRef: string, input: ApplyKycInput, options?: FinanceRequestOptions): Promise<FinanceApiResult<ApplyExtractedKycOutcome>> {
  return postJson(agreementPath(agreementRef, "/kyc"), input, options);
}

// --- Workspace / counterparty picker / permissions (Step 14B routes) ------------------------------------------------------------------------------
export type WorkspaceRequest = {
  lifecycle?: AgreementWorkspaceLifecycleFilter | null;
  counterpartyType?: CounterpartyType | null;
  q?: string | null;
  platform?: string | null;
  period?: AgreementWorkspacePeriodFilter | null;
  discrepancy?: AgreementWorkspaceDiscrepancyFilter | null;
  // Opaque: exactly the previous response's nextCursor.
  cursor?: string | null;
  // 1-20 (server default 20).
  limit?: number;
};

// One bounded, scope-first, deterministic page of the Agreement workspace. Send only the filters that are set.
export function loadAgreementsWorkspace(request: WorkspaceRequest = {}, options?: FinanceRequestOptions): Promise<FinanceApiResult<AgreementWorkspaceDto>> {
  return getJson(
    `/api/finance/agreements/workspace${queryString({
      lifecycle: request.lifecycle,
      counterpartyType: request.counterpartyType,
      q: request.q,
      platform: request.platform,
      period: request.period,
      discrepancy: request.discrepancy,
      cursor: request.cursor,
      limit: request.limit,
    })}`,
    options,
  );
}

// Authorized ACTIVE Partners / Vendors matching a name (display identity only; limit 1-10, server default 10).
export function searchCounterparties(input: { counterpartyType: CounterpartyType; q: string; limit?: number }, options?: FinanceRequestOptions): Promise<FinanceApiResult<CounterpartySearchResponse>> {
  return getJson(`/api/finance/counterparties/search${queryString({ counterpartyType: input.counterpartyType, q: input.q, limit: input.limit })}`, options);
}

// The CreatorOps master-data preview of ONE authorized counterparty (ordinary facts + KYC status only; never a restricted value).
export function getCounterpartyPreview(input: { counterpartyType: CounterpartyType; ref: string }, options?: FinanceRequestOptions): Promise<FinanceApiResult<CounterpartyPreviewDto>> {
  return getJson(`/api/finance/counterparties/preview${queryString({ counterpartyType: input.counterpartyType, ref: input.ref })}`, options);
}

// The signed-in actor's own Finance capabilities (booleans from real grants). Pass the counterparty type to get its identity / KYC flags.
export function getFinancePermissions(input: { counterpartyType?: CounterpartyType } = {}, options?: FinanceRequestOptions): Promise<FinanceApiResult<FinanceAgreementPermissionsDto>> {
  return getJson(`/api/finance/permissions${queryString({ counterpartyType: input.counterpartyType })}`, options);
}

// --- Agreement-led counterparty onboarding (Step 14B.1) ----------------------------------------------------------------------------------------------
// A NEW Partner / Vendor started from a signed Agreement. Four calls, in this order:
//   1. previewOnboardingFromContract  multipart { file, counterpartyType } -> proposed profile + presence flags. Persists NOTHING.
//   2. checkOnboardingDuplicates      JSON -> possible existing records, filtered by the caller's live scope (`strongMatchOutsideYourAccess` blocks creating new)
//   3. createCounterpartyFromOnboarding  JSON -> the resumable step ledger. 200 = an outcome (COMPLETED | FAILED at a step, retry the SAME body | IN_PROGRESS);
//      a refusal before anything was written is a failure result: kind "not_ready" carries `blockers[].code` (counterparty_create_not_permitted,
//      account_management_not_permitted, strong_match_outside_access, duplicate_acknowledgement_required, duplicate_reason_required,
//      account_identity_collision, use_existing_not_a_candidate); kind "invalid" is a field problem (region outside your access, missing vendor type ...).
//   4. getOnboardingStatus            GET -> the same outcome for a clientRequestId the caller started (never resumes anything)
// After COMPLETED the SAME File is sent through the normal uploadContractArtifact -> extractContract -> attachExtractionProposals for the new
// counterparty (idempotent by content); restricted KYC values never pass through the browser.
export function previewOnboardingFromContract(input: { file: File; counterpartyType: CounterpartyType }, options?: FinanceRequestOptions): Promise<FinanceApiResult<OnboardingPreviewDto>> {
  const form = new FormData();
  form.set("counterpartyType", input.counterpartyType);
  form.set("file", input.file, input.file.name);
  return send("/api/finance/onboarding/preview", { method: "POST", form, signal: options?.signal });
}

export function checkOnboardingDuplicates(input: OnboardingDuplicatesRequest, options?: FinanceRequestOptions): Promise<FinanceApiResult<OnboardingDuplicatesDto>> {
  return postJson("/api/finance/onboarding/duplicates", input, options);
}

export function createCounterpartyFromOnboarding(input: OnboardingRequest, options?: FinanceRequestOptions): Promise<FinanceApiResult<OnboardingOutcomeDto>> {
  return postJson("/api/finance/onboarding", input, options);
}

export function getOnboardingStatus(input: OnboardingStatusRequest, options?: FinanceRequestOptions): Promise<FinanceApiResult<OnboardingOutcomeDto>> {
  return getJson(`/api/finance/onboarding${queryString({ onboardingRef: input.onboardingRef, clientRequestId: input.clientRequestId })}`, options);
}

// --- KYC evidence through the OWNING module (Partner / Vendor restricted-identity evidence routes) --------------------------------------------------
// Finance has no upload path of its own: a link or a document is added to the canonical restricted identity record by the
// owning module's existing endpoint, which applies its own action / scope / category rules. The existing owning-module
// client functions are reused as-is (they do not take an AbortSignal, so `signal` is honoured only before dispatch).
// The record must already exist (the owning module refuses evidence for a counterparty with no saved identity fields); pass the
// record's current `version` as expectedVersion. An owning-module 403 is a plain "forbidden" here as well.
export type KycEvidenceDocType = AddPartnerRestrictedIdentityLinkEvidenceInput["docType"];
export type KycEvidenceResult = { version: number; evidence: RestrictedFinancialIdentityEvidence };

function fromOwning<T>(result: PartnersApiResult<T> | VendorsApiResult<T>): FinanceApiResult<T> {
  if (result.ok) return { ok: true, status: 200, data: result.data };
  return failureResult(result.status, result.error, result.blockers?.map((blocker) => ({ code: blocker.code, message: blocker.message })));
}

// A Vendor has no Aadhaar: asking for one is refused here exactly as the owning module would refuse it.
const VENDOR_AADHAAR_REFUSAL: FinanceApiFailure = { ok: false, status: 400, kind: "invalid", message: "Aadhaar applies to Partners only." };

export async function addKycLinkEvidence(input: { counterpartyType: CounterpartyType; ref: string; docType: KycEvidenceDocType; url: string; expectedVersion: number }, options?: FinanceRequestOptions): Promise<FinanceApiResult<KycEvidenceResult>> {
  if (options?.signal?.aborted) return abortedResult();
  try {
    if (input.counterpartyType === "PARTNER") return fromOwning(await addPartnerRestrictedIdentityLinkEvidence(input.ref, { docType: input.docType, url: input.url, expectedVersion: input.expectedVersion }));
    if (input.docType === "aadhaar") return VENDOR_AADHAAR_REFUSAL;
    return fromOwning(await addVendorRestrictedIdentityLinkEvidence(input.ref, { docType: input.docType, url: input.url, expectedVersion: input.expectedVersion }));
  } catch {
    return networkResult();
  }
}

export async function uploadKycEvidenceFile(input: { counterpartyType: CounterpartyType; ref: string; docType: KycEvidenceDocType; file: File; expectedVersion: number }, options?: FinanceRequestOptions): Promise<FinanceApiResult<KycEvidenceResult>> {
  if (options?.signal?.aborted) return abortedResult();
  try {
    if (input.counterpartyType === "PARTNER") return fromOwning(await uploadPartnerRestrictedIdentityEvidence(input.ref, { docType: input.docType, file: input.file, expectedVersion: input.expectedVersion }));
    if (input.docType === "aadhaar") return VENDOR_AADHAAR_REFUSAL;
    return fromOwning(await uploadVendorRestrictedIdentityEvidence(input.ref, { docType: input.docType, file: input.file, expectedVersion: input.expectedVersion }));
  } catch {
    return networkResult();
  }
}

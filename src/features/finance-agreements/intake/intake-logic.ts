import { AGREEMENT_FIELDS, AGREEMENT_FIELD_BY_KEY, type AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { AgreementDetailDto, AgreementDraftEntryDto, AgreementVersionDto } from "@/server/finance-agreements/client-dto";
import type { AgreementCounterpartyInput, CounterpartyType } from "@/server/finance-agreements/types";
import type { FinanceAgreementPermissionsDto } from "@/server/finance-agreements/workspace-dto";

import type { DecideFieldInput, FinanceApiFailure, FinanceApiResult } from "../api-client";
import { deepEqual } from "../field-values";

// Step 14B intake: the pure logic behind the intake context (no React, no DOM, unit-tested).
//   - local edit buffering and the `Save Draft` flush ordering
//   - intake URL building / parsing (deep link + resume)
//   - permission-derived UI flags (what the server said the person may do - never a role name)
//   - the counterparty summary of a created draft
//   - the section progress shown by the right-hand checklist

// --- Field decisions & local edits ---------------------------------------------------------------------------------------------------
export type FieldDecisionKind = DecideFieldInput["decision"];

// One unsaved edit: the decision the person made and (for ACCEPTED / CORRECTED) the value. UNAVAILABLE / NOT_APPLICABLE carry no value.
export type LocalFieldEdit = { decision: FieldDecisionKind; value?: unknown };
export type LocalEdits = Partial<Record<AgreementFieldKey, LocalFieldEdit>>;

// The decision an edit of `value` amounts to, mirroring applyFieldDecision: a value that differs from the entry's current one is
// CORRECTED (never a silent ACCEPTED); the same value, or a value typed where none existed, is ACCEPTED. An identity VALUE field
// is only ever acknowledged (ACCEPTED, no value).
export function resolveEditDecision(entry: Pick<AgreementDraftEntryDto, "value"> | null | undefined, value: unknown, fieldKey?: AgreementFieldKey): FieldDecisionKind {
  if (fieldKey && AGREEMENT_FIELD_BY_KEY[fieldKey]?.identityValue) return "ACCEPTED";
  const current = entry?.value;
  if (current === undefined || current === null) return "ACCEPTED";
  return deepEqual(current, value) ? "ACCEPTED" : "CORRECTED";
}

// Builds the buffered edit for setLocalEdit(fieldKey, value, decision?). An explicit decision wins; otherwise it is derived.
export function buildLocalEdit(fieldKey: AgreementFieldKey, value: unknown, entry: Pick<AgreementDraftEntryDto, "value"> | null | undefined, decision?: FieldDecisionKind): LocalFieldEdit {
  const resolved = decision ?? resolveEditDecision(entry, value, fieldKey);
  if (resolved === "UNAVAILABLE" || resolved === "NOT_APPLICABLE" || AGREEMENT_FIELD_BY_KEY[fieldKey]?.identityValue) return { decision: resolved };
  return { decision: resolved, value };
}

export function hasLocalEdits(edits: LocalEdits): boolean {
  return countLocalEdits(edits) > 0;
}
export function countLocalEdits(edits: LocalEdits): number {
  return Object.keys(edits).length;
}

// The order edits are written in: registry order, so a flush is deterministic regardless of the order the person touched fields
// (currency is decided before the money fields that display against it).
export function flushOrder(edits: LocalEdits): AgreementFieldKey[] {
  return AGREEMENT_FIELDS.filter((field) => edits[field.key] !== undefined).map((field) => field.key);
}

export function withEdit(edits: LocalEdits, fieldKey: AgreementFieldKey, edit: LocalFieldEdit): LocalEdits {
  return { ...edits, [fieldKey]: edit };
}
export function withoutEdit(edits: LocalEdits, fieldKey: AgreementFieldKey): LocalEdits {
  if (edits[fieldKey] === undefined) return edits;
  const next = { ...edits };
  delete next[fieldKey];
  return next;
}

// The edit whose value the draft already holds is not an edit at all (nothing to save).
export function isRedundantEdit(edit: LocalFieldEdit, entry: AgreementDraftEntryDto | null | undefined): boolean {
  if (!entry || entry.decision !== edit.decision) return false;
  if (edit.decision === "UNAVAILABLE" || edit.decision === "NOT_APPLICABLE") return true;
  return deepEqual(entry.value, edit.value);
}

export type FlushOutcome = {
  saved: AgreementFieldKey[];
  // The first failure (the flush stops there); the failing edit and every later one stay buffered.
  failed: { fieldKey: AgreementFieldKey; failure: FinanceApiFailure } | null;
  remaining: LocalEdits;
  // The last successful mutation's response (null when nothing was written).
  agreement: AgreementDetailDto | null;
};

// Writes the buffered edits one at a time (each decideField must carry the docVersion the PREVIOUS write returned, so they can never
// run in parallel). `decide` performs one write and returns the api-client result; `onSaved` lets the caller replace its state with each
// response as it lands. Stops at the first failure so nothing is silently skipped or overwritten.
export async function flushLocalEdits(
  edits: LocalEdits,
  decide: (item: { fieldKey: AgreementFieldKey; decision: FieldDecisionKind; value?: unknown }) => Promise<FinanceApiResult<AgreementDetailDto>>,
  onSaved?: (agreement: AgreementDetailDto, fieldKey: AgreementFieldKey) => void,
): Promise<FlushOutcome> {
  const remaining: LocalEdits = { ...edits };
  const saved: AgreementFieldKey[] = [];
  let agreement: AgreementDetailDto | null = null;
  for (const fieldKey of flushOrder(edits)) {
    const edit = edits[fieldKey]!;
    const result = await decide({ fieldKey, decision: edit.decision, ...(edit.value !== undefined ? { value: edit.value } : {}) });
    if (!result.ok) return { saved, failed: { fieldKey, failure: result }, remaining, agreement };
    delete remaining[fieldKey];
    saved.push(fieldKey);
    agreement = result.data;
    onSaved?.(result.data, fieldKey);
  }
  return { saved, failed: null, remaining, agreement };
}

// Human summary of a flush for the aria-live status line.
export function describeFlush(outcome: Pick<FlushOutcome, "saved" | "failed">): { tone: "success" | "error" | "info"; message: string } {
  if (outcome.failed) {
    const savedText = outcome.saved.length > 0 ? `${outcome.saved.length} ${outcome.saved.length === 1 ? "change was" : "changes were"} saved before the problem. ` : "";
    return { tone: "error", message: `${savedText}Some changes are not saved yet. ${outcome.failed.failure.message}` };
  }
  if (outcome.saved.length === 0) return { tone: "info", message: "Draft is up to date. There are no unsaved changes." };
  return { tone: "success", message: `Draft saved (${outcome.saved.length} ${outcome.saved.length === 1 ? "change" : "changes"}).` };
}

// --- URLs -----------------------------------------------------------------------------------------------------------------------------------
export const INTAKE_PATH = "/finance/agreements/new";

export type IntakeUrlParams = { counterpartyType: CounterpartyType | null; ref: string | null; agreementRef: string | null; version: number | null };

const REF_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
type RawParam = string | string[] | undefined;
const first = (value: RawParam): string | undefined => (Array.isArray(value) ? value[0] : value);

// Parses the page's searchParams. Anything malformed is dropped (never trusted, never echoed).
export function parseIntakeSearchParams(raw: Record<string, RawParam>): IntakeUrlParams {
  const type = first(raw.counterpartyType);
  const ref = first(raw.ref)?.trim();
  const agreementRef = first(raw.agreementRef)?.trim();
  const versionText = first(raw.version)?.trim();
  const version = versionText !== undefined && /^[1-9]\d{0,5}$/.test(versionText) ? Number(versionText) : null;
  return {
    counterpartyType: type === "PARTNER" || type === "VENDOR" ? type : null,
    ref: ref && REF_PATTERN.test(ref) ? ref : null,
    agreementRef: agreementRef && REF_PATTERN.test(agreementRef) ? agreementRef : null,
    version,
  };
}

// /finance/agreements/new?agreementRef=&version= (resume) or ?counterpartyType=&ref= (deep link preselect).
export function intakeHref(params: { agreementRef?: string | null; version?: number | null; counterpartyType?: CounterpartyType | null; ref?: string | null } = {}): string {
  const search = new URLSearchParams();
  if (params.agreementRef) {
    search.set("agreementRef", params.agreementRef);
    if (params.version) search.set("version", String(params.version));
  } else if (params.counterpartyType && params.ref) {
    search.set("counterpartyType", params.counterpartyType);
    search.set("ref", params.ref);
  }
  const text = search.toString();
  return text ? `${INTAKE_PATH}?${text}` : INTAKE_PATH;
}

// The stable key the server page uses to remount the client tree when the route identity changes.
export function intakeRouteKey(params: IntakeUrlParams): string {
  if (params.agreementRef) return `resume:${params.agreementRef}:${params.version ?? "open"}`;
  return `new:${params.counterpartyType ?? "-"}:${params.ref ?? "-"}`;
}

// --- Counterparty of a created draft ----------------------------------------------------------------------------------------------------------
export type IntakeAccountMode = "account-specific" | "partner-level" | "vendor";

export type IntakeCounterparty = {
  type: CounterpartyType;
  ref: string;
  displayName: string;
  // The platform scope: the covered platforms (Account-specific: derived from the accounts; Partner-level: recorded through `platforms`).
  platforms: string[];
  accountRefs: string[];
  mode: IntakeAccountMode;
};

export function counterpartyOfAgreement(agreement: AgreementDetailDto | null, fallbackDisplayName: string | null): IntakeCounterparty | null {
  if (!agreement) return null;
  const { counterparty } = agreement.head;
  const displayName = agreement.head.counterpartyDisplayName ?? fallbackDisplayName ?? counterparty.ref;
  if (counterparty.type === "VENDOR") return { type: "VENDOR", ref: counterparty.ref, displayName, platforms: [], accountRefs: [], mode: "vendor" };
  const accountRefs = [...counterparty.partnerAccountRefs];
  return { type: "PARTNER", ref: counterparty.ref, displayName, platforms: [...counterparty.platformScope], accountRefs, mode: accountRefs.length > 0 ? "account-specific" : "partner-level" };
}

export function counterpartyRefsOf(input: AgreementCounterpartyInput): { type: CounterpartyType; ref: string } {
  return input.type === "VENDOR" ? { type: "VENDOR", ref: input.vendorRef } : { type: "PARTNER", ref: input.partnerRef };
}

// --- Permission-derived UI flags -----------------------------------------------------------------------------------------------------------------
export type IntakeFlags = {
  // May start a draft / edit / extract / confirm (manage_agreements).
  canManage: boolean;
  // The open version is an unconfirmed DRAFT and the actor may manage: field editors are live.
  canEdit: boolean;
  // Explains a read-only screen (null when editable).
  readOnlyReason: string | null;
  // Confirm is offered: editable draft.
  canConfirm: boolean;
  // Activate is offered: server says canActivate AND the version is confirmed but not yet active.
  canActivate: boolean;
  // This is an editable revision (a DRAFT with a version number above 1).
  isRevision: boolean;
  // Extraction may be run / attached.
  canExtract: boolean;
  // Contract snippets may be shown.
  canViewContractDetail: boolean;
  // The identity category / owning KYC action for THIS counterparty type.
  canViewIdentity: boolean;
  canManageCounterpartyKyc: boolean;
};

export function isEditableVersion(version: Pick<AgreementVersionDto, "status" | "confirmed"> | null | undefined): boolean {
  return !!version && version.status === "DRAFT" && !version.confirmed;
}

export function deriveIntakeFlags(input: { permissions: FinanceAgreementPermissionsDto; counterpartyType: CounterpartyType | null; agreement: AgreementDetailDto | null }): IntakeFlags {
  const { permissions, agreement } = input;
  const type = input.counterpartyType ?? agreement?.head.counterparty.type ?? null;
  const version = agreement?.selectedVersion ?? null;
  const editableVersion = isEditableVersion(version);
  const canEdit = permissions.canManage && editableVersion;
  let readOnlyReason: string | null = null;
  if (agreement && !canEdit) {
    if (!permissions.canManage) readOnlyReason = "You can view this Agreement but not edit it.";
    else if (version?.confirmed) readOnlyReason = "This version is confirmed. Create a revision to change the terms.";
    else if (version && version.status !== "DRAFT") readOnlyReason = "This version can no longer be edited.";
  }
  const detail = type ? permissions.byCounterpartyType[type] : { canViewIdentity: permissions.canViewIdentity, canManageCounterpartyKyc: permissions.canManageCounterpartyKyc };
  return {
    canManage: permissions.canManage,
    canEdit,
    readOnlyReason,
    canConfirm: canEdit,
    canActivate: permissions.canActivate && !!version && version.confirmed && version.status === "DRAFT" && agreement?.head.openVersion === version.version,
    isRevision: canEdit && (version?.version ?? 1) > 1,
    canExtract: canEdit,
    canViewContractDetail: permissions.canViewContractDetail,
    canViewIdentity: detail.canViewIdentity,
    canManageCounterpartyKyc: detail.canManageCounterpartyKyc,
  };
}

// The prior CONFIRMED version a revision draft is compared against: the highest confirmed version below the selected one.
export function findPriorConfirmedVersion(versions: ReadonlyArray<{ version: number; confirmed: boolean }>, selectedVersion: number): number | null {
  const prior = versions.filter((item) => item.confirmed && item.version < selectedVersion).sort((a, b) => b.version - a.version)[0];
  return prior ? prior.version : null;
}

// --- Idempotency ------------------------------------------------------------------------------------------------------------------------------
// clientRequestId must match ^[A-Za-z0-9._:-]{8,100}$. One id per form mount, reused across retries, regenerated only after a
// success or when the counterparty being created for changes on purpose.
export const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;

export function newClientRequestId(random: () => number = Math.random): string {
  const uuid = typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function" ? globalThis.crypto.randomUUID() : null;
  if (uuid) return `intake-${uuid}`;
  let text = "";
  for (let index = 0; index < 24; index += 1) text += Math.floor(random() * 36).toString(36);
  return `intake-${text}`;
}

// The holder the context keeps: the id is tied to the counterparty key it was minted for.
export type ClientRequestIdHolder = { id: string; key: string } | null;

export function clientRequestIdFor(holder: ClientRequestIdHolder, key: string, mint: () => string = newClientRequestId): { id: string; key: string } {
  return holder && holder.key === key ? holder : { id: mint(), key };
}

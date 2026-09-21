import type { z } from "zod";

import type { ActorContext } from "@/server/authz/types";

import { toAgreementHeadDto, toAgreementVersionDto, toAgreementVersionSummaryDto, type AgreementDetailDto } from "./client-dto";
import { listAgreementVersionDocs } from "./firestore";
import { loadAuthorizedAgreement, requireContractSensitiveAccess, requireFinanceAgreementsAccess, requireIdentitySensitiveAccess, type AuthorizedAgreement, type FinanceAgreementAction } from "./finance-agreements-gate";
import {
  financeAgreementsInvalidInputResult,
  financeAgreementsUnauthorizedResult,
  type AgreementCounterparty,
  type AgreementDraft,
  type AgreementHeadDoc,
  type AgreementScopeSnapshot,
  type AgreementSourceMode,
  type AgreementVersionDoc,
  type FinanceAgreementsErrorResult,
} from "./types";

// Step 14A: small helpers shared by the Agreement mutation/read services and the lifecycle
// service. Nothing here writes; every write lives in the two services' own transactions.

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}

// The head's own scope fields are a point-in-time copy of the LIVE Partner's / Vendor's scope,
// refreshed on every mutation. They only serve bounded scoped list queries.
export function scopeFieldsOf(scope: AgreementScopeSnapshot): Pick<AgreementHeadDoc, "ownerUid" | "regionIds" | "teamIds" | "partnerUid" | "vendorUid"> {
  return { ownerUid: scope.ownerUid, regionIds: scope.regionIds, teamIds: scope.teamIds, partnerUid: scope.partnerUid, vendorUid: scope.vendorUid };
}

// The version a caller means by default: the open one, else the governing (active/suspended),
// else the newest.
export function defaultVersionNumber(head: Pick<AgreementHeadDoc, "openVersion" | "activeVersion" | "latestVersion">): number {
  return head.openVersion ?? head.activeVersion ?? head.latestVersion;
}

export type AuthorizedCommand<T> = { ok: true; input: T; authorized: AuthorizedAgreement } | { ok: false; error: FinanceAgreementsErrorResult };

// The chain every Agreement command starts with, in order: Authentication -> Admission ->
// FeatureAccess(finance) -> ActionPermission -> input shape -> live RecordScope (the head's
// Partner / Vendor). Unauthenticated / unauthorized callers learn nothing about the input's
// validity or the record's existence; a missing / out-of-scope / forged agreementRef is the
// same neutral not_found.
export async function authorizeAgreementCommand<T extends { agreementRef: string }>(actor: ActorContext | null, action: FinanceAgreementAction, schema: z.ZodType<T, unknown>, rawInput: unknown): Promise<AuthorizedCommand<T>> {
  const access = await requireFinanceAgreementsAccess(actor, action);
  if (!access.ok) return { ok: false, error: financeAgreementsUnauthorizedResult(access.reason) };

  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, error: financeAgreementsInvalidInputResult(formatIssues(parsed.error)) };

  const loaded = await loadAuthorizedAgreement(actor, parsed.data.agreementRef, action);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return { ok: true, input: parsed.data, authorized: loaded.authorized };
}

// Head + bounded version summaries + one version's full detail. Every response - reads AND
// mutation results - is built through here. Identity appears as status only; the per-component
// detail needs the owning identity category (checked here, not in the DTO). The Drive link of a
// version's original signed document needs finance_contracts (also checked here): without it the
// DTOs carry `hasLink` and no URL.
export async function buildAgreementDetailDto(actor: ActorContext, head: AgreementHeadDoc, displayName: string | null, selected: AgreementVersionDoc | null): Promise<AgreementDetailDto> {
  const [versions, identity, contract] = await Promise.all([listAgreementVersionDocs(head.agreementRef), requireIdentitySensitiveAccess(actor, head.counterparty.type), requireContractSensitiveAccess(actor)]);
  const contractDetailVisible = contract.ok;
  return {
    head: toAgreementHeadDto(head, displayName),
    versions: versions.versions.map((doc) => toAgreementVersionSummaryDto(doc, { contractDetailVisible })),
    hasMoreVersions: versions.hasMore,
    selectedVersion: selected ? toAgreementVersionDto(selected, { identityDetailVisible: identity.ok, contractDetailVisible }) : null,
  };
}

export type NewDraftVersionInput = {
  agreementRef: string;
  version: number;
  counterparty: AgreementCounterparty;
  sourceMode: AgreementSourceMode;
  draft: AgreementDraft;
  now: string;
  actorUserRef: string;
};

// A brand-new DRAFT version document: mutable working copy only, no confirmed part, no lifecycle field.
export function newDraftVersionDoc(input: NewDraftVersionInput): AgreementVersionDoc {
  return {
    agreementRef: input.agreementRef,
    version: input.version,
    status: "DRAFT",
    docVersion: 1,
    counterparty: input.counterparty,
    sourceMode: input.sourceMode,
    source: { contractArtifactRef: null, extractionRunRef: null, parserVersion: null },
    document: null,
    draft: input.draft,
    terms: null,
    contactSnapshot: null,
    identityStatusSnapshot: null,
    fieldProvenance: null,
    effective: null,
    confirmation: null,
    activation: null,
    supersededByVersion: null,
    supersededAt: null,
    suspendedAt: null,
    suspendedByUserRef: null,
    suspendReason: null,
    endedAt: null,
    endedByUserRef: null,
    endReason: null,
    createdAt: input.now,
    createdByUserRef: input.actorUserRef,
    updatedAt: input.now,
    updatedByUserRef: input.actorUserRef,
  };
}

// True when this error is Firestore's ALREADY_EXISTS (gRPC code 6): a tx.create lost a race.
export function isAlreadyExistsError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  return candidate?.code === 6 || candidate?.code === "already-exists" || (typeof candidate?.message === "string" && /ALREADY_EXISTS/.test(candidate.message));
}

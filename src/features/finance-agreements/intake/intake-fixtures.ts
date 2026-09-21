import type { AgreementDetailDto, AgreementDraftEntryDto, AgreementVersionDto } from "@/server/finance-agreements/client-dto";
import type { AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { CounterpartyType } from "@/server/finance-agreements/types";
import type { FinanceAgreementPermissionsDto } from "@/server/finance-agreements/workspace-dto";

// Test fixtures for the intake modules (plain DTOs; no server code).
export function draftEntry(over: Partial<AgreementDraftEntryDto> = {}): AgreementDraftEntryDto {
  return { value: null, origin: "MANUAL", decision: "PENDING", extractedValue: null, decidedByUserRef: null, decidedAt: null, provenance: { label: "Manual entry", extractionRunRef: null, page: null, confidence: null }, ...over };
}

export function permissionsDto(over: Partial<FinanceAgreementPermissionsDto> = {}): FinanceAgreementPermissionsDto {
  const detail = { canViewIdentity: false, canManageCounterpartyKyc: false };
  return { canView: true, canManage: true, canActivate: false, canViewContractDetail: false, canViewIdentity: false, canManageCounterpartyKyc: false, canCreatePartner: false, canCreateVendor: false, canManagePartnerAccounts: false, counterpartyType: null, byCounterpartyType: { PARTNER: { ...detail }, VENDOR: { ...detail } }, ...over };
}

export function agreementDto(
  over: {
    type?: CounterpartyType;
    accountRefs?: string[];
    platformScope?: string[];
    version?: number;
    docVersion?: number;
    headDocVersion?: number;
    status?: AgreementVersionDto["status"];
    confirmed?: boolean;
    draft?: Partial<Record<AgreementFieldKey, AgreementDraftEntryDto>>;
    openVersion?: number | null;
    versions?: AgreementDetailDto["versions"];
    extractionRunRef?: string | null;
    displayName?: string | null;
    // Step 14B.1: the version's Agreement document DTO (default: PENDING, nothing to store).
    document?: AgreementVersionDto["document"];
  } = {},
): AgreementDetailDto {
  const type = over.type ?? "PARTNER";
  const version = over.version ?? 1;
  const counterparty = { type, ref: type === "PARTNER" ? "prt_1" : "vnd_1", partnerAccountRefs: type === "PARTNER" ? (over.accountRefs ?? []) : [], platformScope: type === "PARTNER" ? (over.platformScope ?? []) : [] };
  const summary = {
    version,
    status: over.status ?? "DRAFT",
    docVersion: over.docVersion ?? 3,
    sourceMode: "MANUAL" as const,
    confirmed: over.confirmed ?? false,
    confirmedAt: null,
    confirmedByUserRef: null,
    activatedAt: null,
    activatedByUserRef: null,
    supersededVersion: null,
    supersededByVersion: null,
    suspendedAt: null,
    suspendReason: null,
    endedAt: null,
    endReason: null,
    signedDate: null,
    effectiveFrom: null,
    effectiveTo: null,
    agreementType: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    createdByUserRef: "usr_1",
    updatedAt: "2026-09-01T00:00:00.000Z",
    updatedByUserRef: "usr_1",
    document: over.document ?? { status: "PENDING" as const, fileName: null, storedAt: null, hasLink: false, attemptCount: 0, message: null, canStore: false },
  };
  return {
    head: {
      agreementRef: "agr_0123456789abcdef0123",
      counterparty,
      counterpartyDisplayName: over.displayName === undefined ? "Asha Rao" : over.displayName,
      status: "DRAFT",
      latestVersion: version,
      openVersion: over.openVersion === undefined ? version : over.openVersion,
      activeVersion: null,
      lastEndedVersion: null,
      docVersion: over.headDocVersion ?? 5,
      createdAt: "2026-09-01T00:00:00.000Z",
      createdByUserRef: "usr_1",
      updatedAt: "2026-09-01T00:00:00.000Z",
      updatedByUserRef: "usr_1",
    },
    versions: over.versions ?? [summary],
    hasMoreVersions: false,
    selectedVersion: {
      ...summary,
      counterparty,
      source: { contractArtifactRef: null, extractionRunRef: over.extractionRunRef ?? null, parserVersion: null },
      draft: over.draft ?? {},
      terms: null,
      contactSnapshot: null,
      identityStatus: null,
      fieldProvenance: null,
    },
  };
}

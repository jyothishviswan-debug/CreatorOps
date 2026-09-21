import { redactAgreementEventMetadata } from "./agreement-events";
import { AGREEMENT_DOCUMENT_FAILURE_MESSAGES } from "./document-storage/types";
import { describeExtractionReason } from "./extraction-reasons";
import { AGREEMENT_FIELD_BY_KEY, type AgreementFieldKey } from "./fields";
import type {
  AgreementDraftEntry,
  AgreementEffective,
  AgreementEntryDecision,
  AgreementEvent,
  AgreementEventKind,
  AgreementFieldOrigin,
  AgreementFieldProvenance,
  AgreementFieldProvenanceEntry,
  AgreementHeadDoc,
  AgreementHeadStatus,
  AgreementSourceMode,
  AgreementType,
  AgreementVersionDoc,
  AgreementVersionSource,
  AgreementVersionStatus,
  ConfirmedAgreementTerms,
  ContactSnapshot,
  ContractArtifactDoc,
  ContractArtifactStatus,
  CounterpartyType,
  ExtractionConfidence,
  ExtractionRunDoc,
  ExtractionRunStatus,
  IdentityComponentStatus,
  IdentityComponents,
  IdentityStatusSnapshot,
  IdentityStatusState,
} from "./types";

// The only shapes of an Agreement ever handed to the browser:
//   - opaque refs only (agreementRef, partnerRef/vendorRef, partnerAccountRefs, artifactRef,
//     runRef, userRefs) - never a Firebase uid, and never any scope-snapshot field
//     (ownerUid / regionIds / teamIds / partnerUid / vendorUid stay server-side);
//   - no storage locator, bucket, path or signed URL of a contract artifact;
//   - no restricted extraction data (raw snippets, locators, raw identity values);
//   - identity appears ONLY as status + component presence, and the per-component detail is
//     itself withheld (RESTRICTED) unless the caller passes identityDetailVisible - the
//     identity sensitive category check is the caller's job, this file only shapes the result.
// Every builder here is an explicit field-by-field copy, so a field added to a stored doc can
// never reach the browser by accident. A static test walks these DTOs for forbidden keys.

export type AgreementCounterpartyDto = { type: CounterpartyType; ref: string; partnerAccountRefs: string[]; platformScope: string[] };

export type AgreementHeadDto = {
  agreementRef: string;
  counterparty: AgreementCounterpartyDto;
  counterpartyDisplayName: string | null;
  status: AgreementHeadStatus;
  latestVersion: number;
  openVersion: number | null;
  activeVersion: number | null;
  lastEndedVersion: number | null;
  docVersion: number;
  createdAt: string;
  createdByUserRef: string;
  updatedAt: string;
  updatedByUserRef: string;
};

// Step 14B.1: the durable Drive copy of the ORIGINAL signed Agreement, as the browser may see it.
//   STORED          the exact uploaded PDF is in Drive (fileName / storedAt are set; `hasLink` is true)
//   PENDING         the version has its own signed file and it has not been stored yet
//   FAILED          the last store attempt failed (`message` says why in plain words); retriable
//   NOT_CONFIGURED  Drive storage is not set up ("Drive storage not configured"); retriable once it is
//   NOT_APPLICABLE  no signed file of its own for this version (a manual entry or a revision without a new signed document)
// `link` is present ONLY for an actor holding finance_contracts (the caller passes contractDetailVisible); everyone else
// gets `hasLink` and no URL. Neither the Drive file id nor any storage locator / bucket / credential is ever in this shape.
export type AgreementDocumentStatusDto = "STORED" | "PENDING" | "FAILED" | "NOT_CONFIGURED" | "NOT_APPLICABLE";

export type AgreementDocumentDto = {
  status: AgreementDocumentStatusDto;
  fileName: string | null;
  storedAt: string | null;
  hasLink: boolean;
  link?: string;
  attemptCount: number;
  // Plain human text for FAILED / NOT_CONFIGURED / NOT_APPLICABLE; null otherwise.
  message: string | null;
  // The version is confirmed, has its own signed file, and it is not stored yet: a store / retry is meaningful.
  canStore: boolean;
};

// One row of the Partner / Vendor contextual list: a version's document reference (the SAME stored Drive reference the Finance
// detail shows). `document.link` is present only when the actor holds finance_contracts.
// Step 14C: `confirmed` (additive) - the version's terms are confirmed. With `lifecycle` DRAFT it means "Confirmed · awaiting
// activation" (never shown as a bare "Draft"); the backend lifecycle vocabulary is unchanged.
export type CounterpartyAgreementDocumentDto = {
  agreementRef: string;
  version: number;
  lifecycle: AgreementVersionStatus;
  confirmed: boolean;
  headStatus: AgreementHeadStatus;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  document: AgreementDocumentDto;
};

export type CounterpartyAgreementDocumentsDto = {
  counterpartyType: CounterpartyType;
  ref: string;
  documents: CounterpartyAgreementDocumentDto[];
  hasMore: boolean;
  // true only when the actor holds finance_contracts (links may be present); false = status only.
  linksVisible: boolean;
};

export const NO_NEW_SIGNED_DOCUMENT_MESSAGE = "No new signed document for this version";

export type AgreementVersionSummaryDto = {
  version: number;
  status: AgreementVersionStatus;
  docVersion: number;
  sourceMode: AgreementSourceMode;
  confirmed: boolean;
  confirmedAt: string | null;
  confirmedByUserRef: string | null;
  activatedAt: string | null;
  activatedByUserRef: string | null;
  supersededVersion: number | null;
  supersededByVersion: number | null;
  suspendedAt: string | null;
  suspendReason: string | null;
  endedAt: string | null;
  endReason: string | null;
  signedDate: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  agreementType: AgreementType | null;
  createdAt: string;
  createdByUserRef: string;
  updatedAt: string;
  updatedByUserRef: string;
  document: AgreementDocumentDto;
};

// KYC STATUS only. `state` is visible to anyone authorized for the Agreement; the per-component
// presence is RESTRICTED unless the actor holds the identity category. Agreement docs hold no
// identity value at all, so valuesVisible is always false here (values are read only through
// the owning module's restricted-identity boundary).
export type IdentityStatusDto = {
  state: IdentityStatusState | "RESTRICTED";
  components: { pan: IdentityComponentStatus | "RESTRICTED"; aadhaar: IdentityComponentStatus | "RESTRICTED"; gst: IdentityComponentStatus | "RESTRICTED"; bank: IdentityComponentStatus | "RESTRICTED" };
  valuesVisible: false;
  capturedAt: string | null;
};

export type AgreementDraftEntryDto = {
  value: unknown;
  origin: AgreementFieldOrigin;
  decision: AgreementEntryDecision;
  extractedValue: unknown;
  decidedByUserRef: string | null;
  decidedAt: string | null;
  provenance: AgreementFieldProvenanceEntry;
};

export type AgreementVersionDto = AgreementVersionSummaryDto & {
  counterparty: AgreementCounterpartyDto;
  source: AgreementVersionSource;
  draft: Partial<Record<AgreementFieldKey, AgreementDraftEntryDto>>;
  terms: ConfirmedAgreementTerms | null;
  contactSnapshot: ContactSnapshot | null;
  identityStatus: IdentityStatusDto | null;
  fieldProvenance: AgreementFieldProvenance | null;
};

export type AgreementDetailDto = {
  head: AgreementHeadDto;
  versions: AgreementVersionSummaryDto[];
  hasMoreVersions: boolean;
  selectedVersion: AgreementVersionDto | null;
};

export type AgreementEventDto = { kind: AgreementEventKind; version: number; actorUserRef: string; metadata: Record<string, unknown> | null; createdAt: string };

export type ContractArtifactDto = {
  artifactRef: string;
  fileName: string;
  mimeType: "application/pdf";
  sizeBytes: number;
  // A short prefix only - enough to compare files by eye, never the full digest.
  sha256Prefix: string;
  uploadedAt: string;
  uploadedByUserRef: string;
  status: ContractArtifactStatus;
  counterparty: { type: CounterpartyType; ref: string };
};

export type ExtractionProposalDto = { fieldKey: AgreementFieldKey; normalizedValue: unknown; confidence: ExtractionConfidence; warnings: string[]; requiresHumanConfirmation: true; page: number | null };

export type ExtractionRunDto = {
  runRef: string;
  artifactRef: string;
  status: ExtractionRunStatus;
  reasonCodes: string[];
  parserVersion: string;
  pageCount: number;
  charCount: number;
  proposals: ExtractionProposalDto[];
  createdAt: string;
  createdByUserRef: string;
};

export function toAgreementCounterpartyDto(counterparty: AgreementHeadDoc["counterparty"]): AgreementCounterpartyDto {
  return counterparty.type === "PARTNER"
    ? { type: "PARTNER", ref: counterparty.partnerRef, partnerAccountRefs: [...counterparty.partnerAccountRefs], platformScope: [...counterparty.platformScope] }
    : { type: "VENDOR", ref: counterparty.vendorRef, partnerAccountRefs: [], platformScope: [] };
}

export function toAgreementHeadDto(head: AgreementHeadDoc, counterpartyDisplayName: string | null): AgreementHeadDto {
  return {
    agreementRef: head.agreementRef,
    counterparty: toAgreementCounterpartyDto(head.counterparty),
    counterpartyDisplayName,
    status: head.status,
    latestVersion: head.latestVersion,
    openVersion: head.openVersion,
    activeVersion: head.activeVersion,
    lastEndedVersion: head.lastEndedVersion,
    docVersion: head.docVersion,
    createdAt: head.createdAt,
    createdByUserRef: head.createdByUserRef,
    updatedAt: head.updatedAt,
    updatedByUserRef: head.updatedByUserRef,
  };
}

const NOT_CONFIGURED_CODES: ReadonlySet<string> = new Set(["not_configured", "live_drive_disabled_in_tests"]);

export function toAgreementDocumentDto(doc: AgreementVersionDoc, options: { contractDetailVisible?: boolean } = {}): AgreementDocumentDto {
  const stored = doc.document;
  const ownFile = doc.source.contractArtifactRef !== null;
  const confirmed = doc.confirmation !== null;
  if (stored?.status === "STORED") {
    return {
      status: "STORED",
      fileName: stored.fileName,
      storedAt: stored.storedAt,
      hasLink: stored.driveLink !== null,
      ...(options.contractDetailVisible && stored.driveLink ? { link: stored.driveLink } : {}),
      attemptCount: stored.attemptCount,
      message: null,
      canStore: false,
    };
  }
  if (stored?.status === "FAILED") {
    const code = stored.lastFailureCode ?? "unknown";
    const notConfigured = NOT_CONFIGURED_CODES.has(code);
    return {
      status: notConfigured ? "NOT_CONFIGURED" : "FAILED",
      fileName: stored.fileName,
      storedAt: null,
      hasLink: false,
      attemptCount: stored.attemptCount,
      message: AGREEMENT_DOCUMENT_FAILURE_MESSAGES[code],
      canStore: confirmed && ownFile,
    };
  }
  if (!ownFile) return { status: "NOT_APPLICABLE", fileName: null, storedAt: null, hasLink: false, attemptCount: 0, message: NO_NEW_SIGNED_DOCUMENT_MESSAGE, canStore: false };
  return { status: "PENDING", fileName: null, storedAt: null, hasLink: false, attemptCount: 0, message: null, canStore: confirmed };
}

export function toAgreementVersionSummaryDto(doc: AgreementVersionDoc, options: { contractDetailVisible?: boolean } = {}): AgreementVersionSummaryDto {
  const effective: AgreementEffective | null = doc.effective;
  return {
    version: doc.version,
    status: doc.status,
    docVersion: doc.docVersion,
    sourceMode: doc.sourceMode,
    confirmed: doc.confirmation !== null,
    confirmedAt: doc.confirmation?.confirmedAt ?? null,
    confirmedByUserRef: doc.confirmation?.confirmedByUserRef ?? null,
    activatedAt: doc.activation?.activatedAt ?? null,
    activatedByUserRef: doc.activation?.activatedByUserRef ?? null,
    supersededVersion: doc.activation?.supersededVersion ?? null,
    supersededByVersion: doc.supersededByVersion,
    suspendedAt: doc.suspendedAt,
    suspendReason: doc.suspendReason,
    endedAt: doc.endedAt,
    endReason: doc.endReason,
    signedDate: effective?.signedDate ?? null,
    effectiveFrom: effective?.effectiveFrom ?? null,
    effectiveTo: effective?.effectiveTo ?? null,
    agreementType: doc.terms?.agreementType ?? null,
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
    updatedAt: doc.updatedAt,
    updatedByUserRef: doc.updatedByUserRef,
    document: toAgreementDocumentDto(doc, options),
  };
}

// State is always shown; component detail only when the caller has verified the identity category.
export function toIdentityStatusDto(snapshot: IdentityStatusSnapshot | null, options: { identityDetailVisible: boolean }): IdentityStatusDto | null {
  if (!snapshot) return null;
  const restricted: IdentityStatusDto["components"] = { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" };
  const detail = (components: IdentityComponents): IdentityStatusDto["components"] => ({ pan: components.pan, aadhaar: components.aadhaar, gst: components.gst, bank: components.bank });
  return { state: snapshot.state, components: options.identityDetailVisible ? detail(snapshot.components) : restricted, valuesVisible: false, capturedAt: snapshot.capturedAt };
}

function toDraftEntryDto(entry: AgreementDraftEntry): AgreementDraftEntryDto {
  return {
    value: entry.value,
    origin: entry.origin,
    decision: entry.decision,
    extractedValue: entry.extractedValue,
    decidedByUserRef: entry.decidedByUserRef,
    decidedAt: entry.decidedAt,
    provenance: { label: entry.provenance.label, extractionRunRef: entry.provenance.extractionRunRef, page: entry.provenance.page, confidence: entry.provenance.confidence },
  };
}

export function toAgreementVersionDto(doc: AgreementVersionDoc, options: { identityDetailVisible: boolean; contractDetailVisible?: boolean }): AgreementVersionDto {
  const draft: AgreementVersionDto["draft"] = {};
  for (const [key, entry] of Object.entries(doc.draft) as Array<[AgreementFieldKey, AgreementDraftEntry]>) draft[key] = toDraftEntryDto(entry);
  return {
    ...toAgreementVersionSummaryDto(doc, { contractDetailVisible: options.contractDetailVisible }),
    counterparty: toAgreementCounterpartyDto(doc.counterparty),
    source: { contractArtifactRef: doc.source.contractArtifactRef, extractionRunRef: doc.source.extractionRunRef, parserVersion: doc.source.parserVersion },
    draft,
    terms: doc.terms,
    contactSnapshot: doc.contactSnapshot,
    identityStatus: toIdentityStatusDto(doc.identityStatusSnapshot, options),
    fieldProvenance: doc.fieldProvenance,
  };
}

// Metadata is re-screened through the allowlist redactor on the way OUT as well (an event written
// before a redactor change can never leak through a newer read path).
export function toAgreementEventDto(event: AgreementEvent): AgreementEventDto {
  return { kind: event.kind, version: event.version, actorUserRef: event.actorUserRef, metadata: redactAgreementEventMetadata(event.metadata), createdAt: event.createdAt };
}

export function toContractArtifactDto(doc: ContractArtifactDoc): ContractArtifactDto {
  return {
    artifactRef: doc.artifactRef,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    sha256Prefix: doc.sha256.slice(0, 12),
    uploadedAt: doc.uploadedAt,
    uploadedByUserRef: doc.uploadedByUserRef,
    status: doc.status,
    counterparty: { type: doc.counterparty.type, ref: doc.counterparty.ref },
  };
}

export function toExtractionRunDto(doc: ExtractionRunDoc): ExtractionRunDto {
  return {
    runRef: doc.runRef,
    artifactRef: doc.artifactRef,
    status: doc.status,
    reasonCodes: [...doc.reasonCodes],
    parserVersion: doc.parserVersion,
    pageCount: doc.pageCount,
    charCount: doc.charCount,
    proposals: doc.proposals.map((proposal) => ({
      fieldKey: proposal.fieldKey,
      normalizedValue: proposal.normalizedValue,
      confidence: proposal.confidence,
      warnings: [...proposal.warnings],
      requiresHumanConfirmation: true,
      page: proposal.source.page,
    })),
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
  };
}

// --- Extraction result (service-level view of one run, shaped for the ACTOR's visibility) ---------------------------
// Ordinary proposals are visible to every actor authorized for the Agreement. Everything below the
// line is gated by the service BEFORE it reaches this builder:
//   - `restricted` (raw contract snippets/locators): only with the finance_contracts category;
//   - an identity field's VALUE: only with finance_contracts AND the counterparty's identity category.
// Without those, the identity field is listed as valueState RESTRICTED with no value and no result
// (a match/mismatch verdict would itself leak). Snippets are pre-redacted by the service.
export type ExtractionResultFieldDto = ExtractionProposalDto & { valueState: "VISIBLE" | "RESTRICTED" };

export type ExtractionSnippetDto = {
  fieldKey: AgreementFieldKey;
  page: number | null;
  locator: string | null;
  // null = withheld (the snippet of an identity field the actor may not see).
  rawSnippet: string | null;
  snippetState: "VISIBLE" | "RESTRICTED";
};

export type ExtractionResultDto = {
  agreementRef: string;
  run: Omit<ExtractionRunDto, "proposals">;
  reasons: Array<{ code: string; message: string }>;
  fields: ExtractionResultFieldDto[];
  contractDetailVisible: boolean;
  identityValuesVisible: boolean;
  restricted: { snippets: ExtractionSnippetDto[] } | null;
};

export type ExtractionResultInput = {
  agreementRef: string;
  run: ExtractionRunDoc;
  contractDetailVisible: boolean;
  identityValuesVisible: boolean;
  // fieldKey -> raw identity value; consulted ONLY when identityValuesVisible.
  identityValues: ReadonlyMap<string, string>;
  // Already-redacted snippet entries; consulted ONLY when contractDetailVisible.
  snippets: ReadonlyArray<{ fieldKey: AgreementFieldKey; page: number | null; locator: string | null; rawSnippet: string | null }>;
};

export function toExtractionResultDto(input: ExtractionResultInput): ExtractionResultDto {
  const { proposals, ...runSummary } = toExtractionRunDto(input.run);
  const fields: ExtractionResultFieldDto[] = proposals.map((proposal) => {
    if (!AGREEMENT_FIELD_BY_KEY[proposal.fieldKey].identityValue) return { ...proposal, valueState: "VISIBLE" };
    if (input.identityValuesVisible && input.contractDetailVisible) return { ...proposal, normalizedValue: input.identityValues.get(proposal.fieldKey) ?? null, valueState: "VISIBLE" };
    return { ...proposal, normalizedValue: null, valueState: "RESTRICTED" };
  });
  const snippets: ExtractionSnippetDto[] = input.contractDetailVisible
    ? input.snippets.map((snippet) => ({ fieldKey: snippet.fieldKey, page: snippet.page, locator: snippet.locator, rawSnippet: snippet.rawSnippet, snippetState: snippet.rawSnippet === null ? "RESTRICTED" : "VISIBLE" }))
    : [];
  return {
    agreementRef: input.agreementRef,
    run: runSummary,
    reasons: runSummary.reasonCodes.map((code) => ({ code, message: describeExtractionReason(code) })),
    fields,
    contractDetailVisible: input.contractDetailVisible,
    identityValuesVisible: input.identityValuesVisible && input.contractDetailVisible,
    restricted: input.contractDetailVisible ? { snippets } : null,
  };
}

// Step 14A: the public service surface of the Finance Agreements core.
// Routes, the reconciliation agent and the extraction agent import from here; internals
// (firestore helpers, draft builders) stay module-private. The HTTP mapper stays in ./http
// (it imports next/server; the services must stay importable without it) and the multipart upload
// reader stays in ./upload-request. The Partner Reviews commercial-policy adapter (./policy-adapter)
// is deliberately NOT exported here: only the server composition module (src/server/composition) imports it, to
// register it into Partner Reviews, and nothing that imports this barrel (every route) should be able to reach it.
export {
  attachExtractionProposals,
  confirmAgreementVersion,
  createAgreementDraft,
  decideField,
  getAgreementDetail,
  getDraftFieldsForReconciliation,
  listAgreementEvents,
  listAgreementsForCounterparty,
  listAgreementVersions,
  MAX_COUNTERPARTY_AGREEMENTS,
  type AttachExtractionOutcome,
  type CreateAgreementDraftOutcome,
  type ReconciliationDraftFields,
} from "./agreement-service";
export { activateAgreementVersion, AGREEMENT_DOCUMENT_NOT_STORED, createAgreementRevision, endAgreement, resumeAgreement, suspendAgreement } from "./agreement-lifecycle-service";
export { buildIdentityStatusSnapshot, computeIdentityStatus, deriveIdentityComponents } from "./identity-status";
export type { ReconciliationFieldEntry } from "./agreement-draft";
export type { AgreementDetailDto, AgreementEventDto, AgreementHeadDto, AgreementVersionDto, AgreementVersionSummaryDto } from "./client-dto";
// Step 14B.1: the ORIGINAL signed Agreement document (stored in Drive after confirmation) and its contextual Partner / Vendor projection.
// Routes: POST|GET /api/finance/agreements/[agreementRef]/document, GET /api/finance/counterparties/documents.
export {
  getAgreementDocumentStatus,
  listCounterpartyAgreementDocuments,
  MAX_COUNTERPARTY_DOCUMENT_ROWS,
  storeAgreementDocument,
  type AgreementDocumentStatusResultDto,
  type StoreAgreementDocumentOutcome,
} from "./agreement-document-service";
export type { AgreementDocumentDto, AgreementDocumentStatusDto, CounterpartyAgreementDocumentDto, CounterpartyAgreementDocumentsDto } from "./client-dto";
export { NO_NEW_SIGNED_DOCUMENT_MESSAGE } from "./client-dto";
export { DRIVE_NOT_CONFIGURED_MESSAGE } from "./document-storage/types";
// Contract upload + extraction services (routes: POST /api/finance/contracts/upload, POST /api/finance/contracts/extract, GET .../extraction).
export { getContractArtifactSummary, uploadContractArtifact, type UploadContractArtifactOutcome } from "./contract-service";
export { extractContract, getExtractionResult } from "./extraction-service";
export type { ContractArtifactDto, ExtractionResultDto, ExtractionResultFieldDto, ExtractionSnippetDto } from "./client-dto";
// Reconciliation / KYC status / master-data commands (routes: GET .../reconciliation, GET .../kyc-status, POST .../master-data, POST .../kyc).
export { getAgreementReconciliation, type AgreementReconciliationDto } from "./reconciliation-service";
export type { FieldReconciliationDto, ReconciliationAction, ReconciliationReason, ReconciliationState } from "./reconciliation-compare";
export { getAgreementKycStatus, type AgreementKycComponentStatus, type AgreementKycComponents, type AgreementKycState, type AgreementKycStatusDto } from "./kyc-status-service";
export {
  applyExtractedKycToCanonical,
  updateCounterpartyContactFromAgreement,
  type ApplyExtractedKycInput,
  type ApplyExtractedKycOutcome,
  type KycComponent,
  type MasterDataMode,
  type UpdateCounterpartyContactInput,
  type UpdateCounterpartyContactOutcome,
} from "./master-data-commands";
// Step 14B: workspace list, counterparty picker (search + preview) and permissions.
// Routes: GET /api/finance/agreements/workspace, GET /api/finance/counterparties/search, GET /api/finance/counterparties/preview, GET /api/finance/permissions.
export { listAgreementsWorkspace, AGREEMENT_HEAD_SCAN_CEILING } from "./agreement-workspace-service";
export { getCounterpartyPreview, searchCounterparties, type CounterpartySearchResponse } from "./counterparty-picker-service";
export { computeFinanceAgreementPermissions, getFinanceAgreementPermissions } from "./finance-permissions";
export type {
  AgreementWorkspaceDisclosureDto,
  AgreementWorkspaceDto,
  AgreementWorkspaceKycDto,
  AgreementWorkspacePrimaryActionDto,
  AgreementWorkspacePrimaryActionKind,
  AgreementWorkspaceQuery,
  AgreementWorkspaceRowDto,
  CounterpartyPartnerAccountDto,
  CounterpartyPreviewDto,
  CounterpartySearchResultDto,
  CounterpartyUnavailableFieldDto,
  FinanceAgreementPermissionsDto,
} from "./workspace-dto";
// Step 14B.1: Agreement-led counterparty onboarding (a new Partner / Vendor created FROM a signed Agreement through the OWNING services).
// Routes: POST /api/finance/onboarding/preview (ephemeral extraction), POST /api/finance/onboarding/duplicates (live-scope duplicate check),
// POST /api/finance/onboarding (create / resume the step ledger), GET /api/finance/onboarding?clientRequestId= (status).
export { checkOnboardingDuplicates, MAX_ONBOARDING_ACCOUNTS, MAX_ONBOARDING_DUPLICATE_CANDIDATES } from "./onboarding-duplicates";
export { previewOnboardingFromContract } from "./onboarding-preview-service";
export { createCounterpartyFromOnboarding, getOnboardingStatus } from "./onboarding-service";
export { ONBOARDING_BLOCKER_CODES, ONBOARDING_STEPS } from "./onboarding-dto";
export type {
  OnboardingBlockerCode,
  OnboardingDuplicateAccountInput,
  OnboardingDuplicateCandidateDto,
  OnboardingDuplicateSignal,
  OnboardingDuplicateStrength,
  OnboardingDuplicatesDto,
  OnboardingDuplicatesRequest,
  OnboardingMode,
  OnboardingOutcomeDto,
  OnboardingPreviewDto,
  OnboardingPreviewFieldDto,
  OnboardingStatusRequest,
  OnboardingStepName,
} from "./onboarding-dto";
export type { OnboardingAccountInput, OnboardingInput, OnboardingRequest } from "./onboarding-input";

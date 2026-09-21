// Step 14A: the public service surface of the Finance Agreements core.
// Routes, the reconciliation agent and the extraction agent import from here; internals
// (firestore helpers, draft builders) stay module-private. The HTTP mapper stays in ./http
// (it imports next/server; the services must stay importable without it) and the multipart upload
// reader stays in ./upload-request. The Partner Reviews commercial-policy adapter (./policy-adapter)
// is deliberately NOT exported here: its production registration is deferred, and nothing that imports
// this barrel (every route) should be able to reach it.
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
export { activateAgreementVersion, createAgreementRevision, endAgreement, resumeAgreement, suspendAgreement } from "./agreement-lifecycle-service";
export { buildIdentityStatusSnapshot, computeIdentityStatus, deriveIdentityComponents } from "./identity-status";
export type { ReconciliationFieldEntry } from "./agreement-draft";
export type { AgreementDetailDto, AgreementEventDto, AgreementHeadDto, AgreementVersionDto, AgreementVersionSummaryDto } from "./client-dto";
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

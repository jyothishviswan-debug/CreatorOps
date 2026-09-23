// EXECUTE_HARD_RESET Section 13: UI-facing view types only. Nothing here is a backend DTO shape - the adapter
// (agreement-create-adapter.ts) is the ONE place that maps accepted backend contracts into these. Pure data, no
// JSX, so it can be unit-tested the same way agreement-intake-logic/* already is.

export type AgreementCreateStep = 1 | 2 | 3 | 4 | 5;

export const AGREEMENT_CREATE_STEPS: ReadonlyArray<{ step: AgreementCreateStep; title: string; subtitle: string }> = [
  { step: 1, title: "Upload & Extract", subtitle: "Upload Agreement and extract details" },
  { step: 2, title: "Review & Verify", subtitle: "Check and complete information" },
  { step: 3, title: "Parties & KYC", subtitle: "Link or create Partner/Vendor" },
  { step: 4, title: "Terms & Targets", subtitle: "Commercial terms and targets" },
  { step: 5, title: "Confirm", subtitle: "Final review and create" },
];

export type ExtractionUiState = "idle" | "uploading" | "extracting" | "complete" | "partial" | "manual_review" | "error";

export type DocumentStorageState = "LOCAL_ONLY" | "PENDING_DURABLE_STORAGE" | "STORED" | "FAILED" | "NOT_CONFIGURED" | "NO_NEW_SIGNED_DOCUMENT";

export type AgreementDocumentView = {
  originalFileName: string;
  mimeType: "application/pdf";
  sizeBytes: number;
  pageCount: number | null;
  // A local object URL for a File still held in browser memory (this session's own selection) only - never a
  // server storage path. null when nothing can be previewed (e.g. a resumed draft with no File object in memory
  // and no authorized preview endpoint - see Section 7's own fallback rule).
  previewUrl: string | null;
  storageState: DocumentStorageState;
  storageMessage: string | null;
};

export type ReviewTabKey = "summary" | "parties" | "commercial" | "content" | "targets" | "other";

export type ExtractedFieldView = {
  key: string;
  label: string;
  displayValue: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  sourcePage: number | null;
  warning: string | null;
  requiresDecision: boolean;
};

export type AgreementPartyRoleView = "PRIMARY_COUNTERPARTY" | "CO_SERVICE_PROVIDER" | "PAYEE" | "PRESENTER" | "SIGNATORY" | "NOTICE_CONTACT" | "OTHER_CONTRACT_PARTY";

export type AgreementPartyView = {
  id: string;
  name: string;
  roles: AgreementPartyRoleView[];
  canonicalType: "PARTNER" | "VENDOR" | "UNMAPPED";
  canonicalRef: string | null;
};

export type AccountScopeView = {
  id: string;
  platform: string;
  displayName: string | null;
  handle: string | null;
  url: string | null;
  partnerAccountRef: string | null;
  state: "MATCHED" | "NEW" | "PARTNER_LEVEL" | "UNRESOLVED";
};

export type ContentObligationView = {
  id: string;
  label: string;
  quantity: number | null;
  period: string | null;
  contractWording: string | null;
  operationalMapping: "APPROVED_CONTENT" | "APPROVED_CURRENT_LINK" | "LFC" | "SFC" | "UNMAPPED";
};

export type IncentiveView = {
  applicable: "YES" | "NO" | "NEEDS_REVIEW";
  detailMode: "NONE" | "NARRATIVE" | "STRUCTURED_SLABS";
  narrative: string | null;
  slabs: Array<{ id: string; start: number | null; end: number | null; amountMinor: number | null }>;
};

export type PerformanceTargetView = {
  id: string;
  metricLabel: string;
  operator: string | null;
  targetDisplay: string | null;
  periodDisplay: string | null;
  anchorDisplay: string | null;
  consequenceDisplay: string | null;
  affectsPayment: false;
};

export type KeyClauseView = { key: string; label: string; summary: string; sourcePage: number | null; fullText: string | null };

export type AgreementCreateViewModel = {
  step: AgreementCreateStep;
  extractionState: ExtractionUiState;
  document: AgreementDocumentView | null;
  fields: ExtractedFieldView[];
  parties: AgreementPartyView[];
  accounts: AccountScopeView[];
  contentObligations: ContentObligationView[];
  incentive: IncentiveView;
  performanceTargets: PerformanceTargetView[];
  keyClauses: KeyClauseView[];
  warnings: string[];
};

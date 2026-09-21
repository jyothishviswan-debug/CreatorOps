import type { ExtractionConfidence } from "./extraction/extraction-types";
import type { CounterpartyType } from "./types";

// Step 14B.1: the browser-safe shapes of Agreement-led counterparty onboarding (types only - this file holds no runtime code).
// Nothing here can carry a restricted identity value, a contract snippet (unless the preview says so), an owner / scope internal
// or the identity of a record the actor may not see.

export const ONBOARDING_CREATED_VIA = "FINANCE_AGREEMENT_ONBOARDING" as const;

// --- Duplicate detection ---------------------------------------------------------------------------------------------------------
export type OnboardingDuplicateSignal = "EMAIL" | "PHONE" | "ACCOUNT_IDENTITY" | "DISPLAY_NAME";
export type OnboardingDuplicateStrength = "STRONG" | "SUPPORTING";

// One existing record the actor MAY see. Ordinary display data only.
export type OnboardingDuplicateCandidateDto = {
  type: CounterpartyType;
  ref: string;
  displayName: string;
  regions: string[];
  status: string;
  signals: OnboardingDuplicateSignal[];
  strength: OnboardingDuplicateStrength;
};

// status
//   none      every lookup ran and nothing matched - NOT proof that no duplicate exists (a record stored with a different email / phone
//             format can be missed), so the UI words it `No strong match found`, never "no duplicate"
//   possible  at least one match (an in-scope candidate, or a strong match outside the actor's access)
//   unknown   a lookup could not run: NEVER read this as "no duplicate"
export type OnboardingDuplicatesDto = {
  type: CounterpartyType;
  status: "none" | "possible" | "unknown";
  candidates: OnboardingDuplicateCandidateDto[];
  // true when a STRONG match exists that the actor cannot see. Carries no ref, name, count or signal. It blocks `create new`.
  strongMatchOutsideYourAccess: boolean;
  checkedAt: string;
};

export type OnboardingDuplicateAccountInput = { platform: string; handle?: string; profileUrl?: string; platformAccountId?: string };
export type OnboardingDuplicatesRequest = { type: CounterpartyType; displayName: string; email?: string; phone?: string; accounts?: OnboardingDuplicateAccountInput[] };

// --- Preview (ephemeral extraction before any counterparty exists) ---------------------------------------------------------------
export type OnboardingPreviewFieldDto = { value: string; confidence: ExtractionConfidence; page: number | null; warnings: string[] };

export type OnboardingPreviewDto = {
  counterpartyType: CounterpartyType;
  // The sanitized original file name.
  fileName: string;
  extraction: { status: "EXTRACTED" | "PARTIAL" | "MANUAL_REVIEW_REQUIRED"; reasons: Array<{ code: string; message: string }>; pageCount: number | null };
  // The proposed master profile (each null when the Agreement does not state it). Every value still needs a human decision.
  profile: {
    counterpartyName: OnboardingPreviewFieldDto | null;
    contactNumber: OnboardingPreviewFieldDto | null;
    emailAddress: OnboardingPreviewFieldDto | null;
    state: OnboardingPreviewFieldDto | null;
    collaboratorPageName: OnboardingPreviewFieldDto | null;
    collaboratorPageLink: OnboardingPreviewFieldDto | null;
  };
  // "instagram" / "youtube" when the page link names one, else null (a suggestion - never trusted by the server).
  detectedPlatform: "instagram" | "youtube" | null;
  agreement: {
    agreementNumber: OnboardingPreviewFieldDto | null;
    signedDate: OnboardingPreviewFieldDto | null;
    effectiveDate: OnboardingPreviewFieldDto | null;
    terminationDate: OnboardingPreviewFieldDto | null;
    // Which commercial fields the Agreement states (names only - the terms themselves are reviewed on the Agreement after it exists).
    commercialFieldsFound: string[];
  };
  // PRESENCE ONLY: whether the Agreement contained the identity detail. The values never leave the server.
  identityFound: { pan: boolean; aadhaar: boolean; gst: boolean; bank: boolean };
  // Raw contract snippets, only for an actor holding finance_contracts (identity values masked; an identity field's snippet is withheld).
  contractDetailVisible: boolean;
  snippets: Array<{ fieldKey: string; page: number | null; snippet: string }> | null;
  // What the actor may do next (real grants): a new counterparty needs the owning create right as well as manage_agreements.
  canCreateCounterparty: boolean;
  canCreatePartnerAccounts: boolean;
};

// --- Orchestration ---------------------------------------------------------------------------------------------------------------
export const ONBOARDING_STEPS = ["VALIDATED", "COUNTERPARTY_CREATED", "ACCOUNTS_CREATED", "AGREEMENT_DRAFT_CREATED"] as const;
export type OnboardingStepName = (typeof ONBOARDING_STEPS)[number];

export type OnboardingMode = "CREATE_NEW" | "USE_EXISTING";

// COMPLETED    every step done; agreementRef names the draft (open it in the normal intake)
// FAILED       a step failed; completedSteps are safe to keep, `retryable` says whether the SAME request can be sent again to resume
// IN_PROGRESS  another request for the same clientRequestId is running right now (retryable shortly)
export type OnboardingOutcomeDto = {
  outcome: "COMPLETED" | "FAILED" | "IN_PROGRESS";
  onboardingRef: string;
  clientRequestId: string;
  counterpartyType: CounterpartyType;
  mode: OnboardingMode;
  createdVia: typeof ONBOARDING_CREATED_VIA;
  completedSteps: OnboardingStepName[];
  failedStep: OnboardingStepName | null;
  retryable: boolean;
  // A stable machine code for a failure (counterparty_create_failed | account_create_failed | account_identity_collision | agreement_draft_failed | onboarding_in_progress | unexpected_error), else null.
  code: string | null;
  message: string | null;
  // true when the failure IS a strong duplicate signal (an Account identity that already belongs to another Partner).
  duplicateSignal: boolean;
  counterparty: { type: CounterpartyType; ref: string; displayName: string; created: boolean } | null;
  accounts: Array<{ platform: string; partnerAccountRef: string; created: boolean }>;
  agreementRef: string | null;
  // true when this response re-reports an onboarding that had already completed (nothing was written by this call).
  replayed: boolean;
};

// Typed blockers a create request can be refused with BEFORE anything is written (HTTP 409 with `blockers[].code`).
export const ONBOARDING_BLOCKER_CODES = [
  "counterparty_create_not_permitted",
  "account_management_not_permitted",
  "strong_match_outside_access",
  "duplicate_acknowledgement_required",
  "duplicate_reason_required",
  "account_identity_collision",
  "use_existing_not_a_candidate",
] as const;
export type OnboardingBlockerCode = (typeof ONBOARDING_BLOCKER_CODES)[number];

export type OnboardingStatusRequest = { onboardingRef?: string; clientRequestId?: string };

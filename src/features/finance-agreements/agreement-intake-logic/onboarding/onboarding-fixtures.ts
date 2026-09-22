import type { OnboardingDuplicatesDto, OnboardingDuplicateCandidateDto, OnboardingOutcomeDto, OnboardingPreviewDto, OnboardingPreviewFieldDto } from "@/server/finance-agreements/onboarding-dto";

// Test fixtures for the onboarding modules (plain DTOs; no server code).
export const previewField = (value: string, over: Partial<OnboardingPreviewFieldDto> = {}): OnboardingPreviewFieldDto => ({ value, confidence: "HIGH", page: 1, warnings: [], ...over });

export function previewDto(over: Partial<OnboardingPreviewDto> = {}, profile: Partial<OnboardingPreviewDto["profile"]> = {}): OnboardingPreviewDto {
  return {
    counterpartyType: "PARTNER",
    fileName: "signed-agreement.pdf",
    extraction: { status: "EXTRACTED", reasons: [], pageCount: 4 },
    profile: {
      counterpartyName: previewField("Asha Rao"),
      contactNumber: previewField("+91 98765 43210"),
      emailAddress: previewField("asha@example.com"),
      state: previewField("Karnataka"),
      collaboratorPageName: previewField("Asha Travels"),
      collaboratorPageLink: previewField("https://www.instagram.com/asha.travels"),
      ...profile,
    },
    detectedPlatform: "instagram",
    agreement: { agreementNumber: null, signedDate: null, effectiveDate: null, terminationDate: null, commercialFieldsFound: [] },
    identityFound: { pan: true, aadhaar: false, gst: false, bank: false },
    contractDetailVisible: false,
    snippets: null,
    canCreateCounterparty: true,
    canCreatePartnerAccounts: true,
    ...over,
  };
}

export const candidate = (over: Partial<OnboardingDuplicateCandidateDto> = {}): OnboardingDuplicateCandidateDto => ({
  type: "PARTNER",
  ref: "prt_existing1",
  displayName: "Asha Rao",
  regions: ["Karnataka"],
  status: "ACTIVE",
  signals: ["EMAIL"],
  strength: "STRONG",
  ...over,
});

export const duplicatesDto = (over: Partial<OnboardingDuplicatesDto> = {}): OnboardingDuplicatesDto => ({ type: "PARTNER", status: "none", candidates: [], strongMatchOutsideYourAccess: false, checkedAt: "2026-09-21T10:00:00.000Z", ...over });

export function outcomeDto(over: Partial<OnboardingOutcomeDto> = {}): OnboardingOutcomeDto {
  return {
    outcome: "COMPLETED",
    onboardingRef: `onb_${"a".repeat(64)}`,
    clientRequestId: "onboard-11111111-1111-1111-1111-111111111111",
    counterpartyType: "PARTNER",
    mode: "CREATE_NEW",
    createdVia: "FINANCE_AGREEMENT_ONBOARDING",
    completedSteps: ["VALIDATED", "COUNTERPARTY_CREATED", "ACCOUNTS_CREATED", "AGREEMENT_DRAFT_CREATED"],
    failedStep: null,
    retryable: false,
    code: null,
    message: null,
    duplicateSignal: false,
    counterparty: { type: "PARTNER", ref: "prt_new1", displayName: "Asha Rao", created: true },
    accounts: [{ platform: "instagram", partnerAccountRef: "pa_new1", created: true }],
    agreementRef: "agr_0123456789abcdef0123",
    replayed: false,
    ...over,
  };
}

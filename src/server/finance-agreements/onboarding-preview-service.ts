import { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { requirePartnersAccess } from "@/server/partners/partners-gate";
import { requireVendorsAccess } from "@/server/vendors/vendors-gate";

import { REJECTION_MESSAGES, sanitizeContractFileName } from "./contract-service";
import { sha256Hex, validateContractPdf } from "./contract-artifacts/validation";
import { redactIdentityFromText } from "./extraction-redaction";
import { describeExtractionReason } from "./extraction-reasons";
import { runExtractionPipeline, type PipelineOutcome } from "./extraction-run-builder";
import { isRestrictedExtractedField, type ExtractedFieldKey } from "./extraction/extraction-types";
import { requireContractSensitiveAccess, requireFinanceAgreementsAccess } from "./finance-agreements-gate";
import type { OnboardingPreviewDto, OnboardingPreviewFieldDto } from "./onboarding-dto";
import { formatIssues } from "./service-common";
import { counterpartyTypeSchema, financeAgreementsInvalidInputResult, financeAgreementsUnauthorizedResult, type FinanceAgreementsServiceResult } from "./types";

// Step 14B.1: the EPHEMERAL preview of a NEW counterparty, read from a signed Agreement before any Partner / Vendor exists.
//
// It runs the same pure extraction pipeline as the normal extraction (PDF validation, text, rules, classification) over the bytes of the
// request and answers a safe proposal DTO. It persists NOTHING: no artifact, no claim, no extraction run, no restricted record, no
// Agreement, no Partner / Vendor. After the counterparty exists the client sends the SAME file through the normal contract upload
// (idempotent by content) and extraction, so a restricted identity value never passes through the browser: KYC values flow server-side
// from the persisted restricted extraction through the existing master-data command.
//
//   gate     finance feature + manage_agreements (like the counterparty picker); the result also says whether the actor may CREATE the
//            counterparty (the owning create right), so a person who can only review is told before they go further
//   output   proposed profile fields (each with confidence / page / warnings), extraction status + reasons, the Agreement's own
//            number / dates, WHICH commercial fields were found (names only), and identity PRESENCE flags only
//   snippets raw contract text ONLY for an actor holding finance_contracts, with every identity value masked and an identity field's
//            own snippet withheld outright (this preview never returns an identity value to anyone)
//   scan     an image-only or unreadable PDF is MANUAL_REVIEW_REQUIRED with its reasons and no proposals - never invented values

export const previewOnboardingInputSchema = z
  .object({
    type: counterpartyTypeSchema,
    fileName: z.string().min(1).max(2000),
    bytes: z.instanceof(Uint8Array),
  })
  .strict();
export type PreviewOnboardingInput = z.input<typeof previewOnboardingInputSchema>;

const COMMERCIAL_FIELD_KEYS: readonly ExtractedFieldKey[] = [
  "currency",
  "paymentCycle",
  "fixedComponent",
  "monthlyRequiredQualifyingContentCount",
  "qualifyingUnit",
  "accountTransferFee",
  "advancePayment",
  "invoiceRequired",
  "invoiceDueTerms",
  "paymentDueTerms",
  "servicesMandated",
  "incentive",
  "lfcSfc",
  "performanceTargets",
];

const MAX_PREVIEW_SNIPPETS = 40;

// A suggestion only ("instagram" / "youtube") from the page link's host; the server never trusts it (the reviewer chooses the platform).
export function detectPlatformFromLink(link: string): "instagram" | "youtube" | null {
  const text = link.trim();
  if (text.length === 0) return null;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase();
    if (host === "instagram.com" || host.endsWith(".instagram.com") || host === "instagr.am") return "instagram";
    if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") return "youtube";
  } catch {
    // not a URL: no suggestion
  }
  return null;
}

function stringField(outcome: PipelineOutcome, key: ExtractedFieldKey): OnboardingPreviewFieldDto | null {
  const proposal = outcome.split.ordinary.find((item) => item.fieldKey === key);
  if (!proposal || typeof proposal.normalizedValue !== "string" || proposal.normalizedValue.length === 0) return null;
  return { value: proposal.normalizedValue, confidence: proposal.confidence, page: Number.isInteger(proposal.page) ? proposal.page : null, warnings: [...proposal.warnings] };
}

// Pure: the DTO for an already-run pipeline outcome (exported for unit tests).
export function buildOnboardingPreviewDto(input: {
  type: z.infer<typeof counterpartyTypeSchema>;
  fileName: string;
  outcome: PipelineOutcome;
  contractDetailVisible: boolean;
  canCreateCounterparty: boolean;
  canCreatePartnerAccounts: boolean;
}): OnboardingPreviewDto {
  const { outcome } = input;
  const present = new Set(outcome.split.ordinary.map((item) => item.fieldKey));
  const link = stringField(outcome, "collaboratorPageLink");

  // Raw snippets: contract-detail actors only; identity values (extracted or merely identity-shaped) are masked and an identity
  // field's own snippet is dropped.
  let snippets: OnboardingPreviewDto["snippets"] = null;
  if (input.contractDetailVisible) {
    const identityValues = outcome.split.restricted.identityValues.map((entry) => entry.normalizedValue);
    snippets = outcome.split.restricted.rawSnippets
      .filter((entry) => !isRestrictedExtractedField(entry.fieldKey))
      .slice(0, MAX_PREVIEW_SNIPPETS)
      .map((entry) => ({ fieldKey: entry.fieldKey, page: Number.isInteger(entry.page) ? entry.page : null, snippet: redactIdentityFromText(entry.rawSnippet, identityValues) }));
  }

  return {
    counterpartyType: input.type,
    fileName: input.fileName,
    extraction: {
      status: outcome.status,
      reasons: [...outcome.reasons, ...outcome.missingCore.map((key) => `missing_core:${key}`)].slice(0, 20).map((code) => ({ code, message: describeExtractionReason(code) })),
      pageCount: outcome.pdf.ok ? outcome.pdf.pageCount : (outcome.pdf.pageCount ?? null),
    },
    profile: {
      counterpartyName: stringField(outcome, "counterpartyName"),
      contactNumber: stringField(outcome, "contactNumber"),
      emailAddress: stringField(outcome, "emailAddress"),
      state: stringField(outcome, "state"),
      collaboratorPageName: stringField(outcome, "collaboratorPageName"),
      collaboratorPageLink: link,
    },
    detectedPlatform: link ? detectPlatformFromLink(link.value) : null,
    agreement: {
      agreementNumber: stringField(outcome, "agreementNumber"),
      signedDate: stringField(outcome, "signedDate"),
      effectiveDate: stringField(outcome, "effectiveDate"),
      terminationDate: stringField(outcome, "terminationDate"),
      commercialFieldsFound: COMMERCIAL_FIELD_KEYS.filter((key) => present.has(key)),
    },
    identityFound: { pan: present.has("panNumber"), aadhaar: present.has("aadhaarNumber"), gst: present.has("gstin"), bank: present.has("bankAccountNumber") || present.has("ifsc") },
    contractDetailVisible: input.contractDetailVisible,
    snippets,
    canCreateCounterparty: input.canCreateCounterparty,
    canCreatePartnerAccounts: input.canCreatePartnerAccounts,
  };
}

export async function previewOnboardingFromContract(actor: ActorContext | null, rawInput: unknown): Promise<FinanceAgreementsServiceResult<OnboardingPreviewDto>> {
  const access = await requireFinanceAgreementsAccess(actor, "manage_agreements");
  if (!access.ok) return financeAgreementsUnauthorizedResult(access.reason);

  const parsed = previewOnboardingInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeAgreementsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const validation = validateContractPdf(input.bytes);
  if (!validation.ok) return financeAgreementsInvalidInputResult(REJECTION_MESSAGES[validation.reason]);

  const [contract, canCreateCounterparty, canManageAccounts] = await Promise.all([
    requireContractSensitiveAccess(actor!),
    (input.type === "PARTNER" ? requirePartnersAccess(actor, "create") : requireVendorsAccess(actor, "create")).then((result) => result.ok),
    input.type === "PARTNER" ? requirePartnersAccess(actor, "manage_partner_accounts").then((result) => result.ok) : Promise.resolve(false),
  ]);

  // Never throws for a bad PDF (a failure is a MANUAL_REVIEW_REQUIRED outcome). Nothing below writes anywhere.
  const outcome = await runExtractionPipeline(input.bytes, sha256Hex(input.bytes));
  return {
    ok: true,
    data: buildOnboardingPreviewDto({ type: input.type, fileName: sanitizeContractFileName(input.fileName), outcome, contractDetailVisible: contract.ok, canCreateCounterparty, canCreatePartnerAccounts: canManageAccounts }),
  };
}

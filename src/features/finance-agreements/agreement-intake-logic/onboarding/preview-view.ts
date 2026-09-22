import type { AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { OnboardingPreviewDto, OnboardingPreviewFieldDto } from "@/server/finance-agreements/onboarding-dto";
import type { ExtractionConfidence } from "@/server/finance-agreements/types";

import { EXTRACTION_NOTE, extractionStatusChip, fieldLabel, formatPlatformName, formatUtcDate, SCAN_MANUAL_REVIEW_MESSAGE, type ChipSpec } from "../../format";
import { maskIdentityInText } from "../../identity-mask";

// Step 14B.1 onboarding: how the extraction PREVIEW reads on screen (pure).
//
// The first block of the wizard shows EXTRACTED AGREEMENT VALUES - what the reader found, each one still needing a human decision. It is not the
// Cross-verification table: there is no CreatorOps record yet, so nothing here is "Missing in CreatorOps". Identity details (PAN, Aadhaar, GSTIN,
// bank) appear as PRESENCE only ("PAN found in Agreement"); the preview DTO carries no identity value, and any raw contract text is masked again.

export type PreviewRow = { key: string; label: string; value: string | null; confidence: ExtractionConfidence | null; page: number | null; warnings: string[] };

const row = (key: string, label: string, field: OnboardingPreviewFieldDto | null): PreviewRow => ({ key, label, value: field ? field.value : null, confidence: field ? field.confidence : null, page: field ? field.page : null, warnings: field ? field.warnings : [] });

// The values the proposed master record is built from, in the order the record shows them.
export function previewRows(preview: OnboardingPreviewDto): PreviewRow[] {
  const { profile } = preview;
  return [
    row("counterpartyName", "Name", profile.counterpartyName),
    row("contactNumber", "Phone", profile.contactNumber),
    row("emailAddress", "Email", profile.emailAddress),
    row("state", "State", profile.state),
    row("collaboratorPageName", "Page or account name", profile.collaboratorPageName),
    row("collaboratorPageLink", "Page or account link", profile.collaboratorPageLink),
  ];
}

// The platform the page link names (a suggestion only), for the line under the link row.
export function detectedPlatformText(preview: OnboardingPreviewDto): string | null {
  return preview.detectedPlatform ? `The link looks like a ${formatPlatformName(preview.detectedPlatform)} page.` : null;
}

// Identity details the Agreement contains: PRESENCE only, never a value.
export function identityFoundLines(preview: OnboardingPreviewDto): string[] {
  const lines: string[] = [];
  if (preview.identityFound.pan) lines.push("PAN found in Agreement");
  if (preview.identityFound.aadhaar) lines.push("Aadhaar found in Agreement");
  if (preview.identityFound.gst) lines.push("GSTIN found in Agreement");
  if (preview.identityFound.bank) lines.push("Bank details found in Agreement");
  return lines;
}

export const IDENTITY_FOUND_NOTE = "These values are not shown here. After the record exists they are read from the Agreement on the server and completed in the KYC section.";

export function agreementFacts(preview: OnboardingPreviewDto): Array<{ label: string; value: string }> {
  const { agreement } = preview;
  const facts: Array<{ label: string; value: string }> = [];
  if (agreement.agreementNumber) facts.push({ label: "Agreement number", value: agreement.agreementNumber.value });
  if (agreement.signedDate) facts.push({ label: "Signed date", value: formatUtcDate(agreement.signedDate.value) });
  if (agreement.effectiveDate) facts.push({ label: "Effective date", value: formatUtcDate(agreement.effectiveDate.value) });
  if (agreement.terminationDate) facts.push({ label: "Termination date", value: formatUtcDate(agreement.terminationDate.value) });
  return facts;
}

// Which commercial terms the Agreement states (names only; the terms themselves are reviewed on the Agreement after it exists).
export function commercialFoundLabels(preview: OnboardingPreviewDto): string[] {
  return preview.agreement.commercialFieldsFound.map((key) => fieldLabel(key as AgreementFieldKey));
}

export type PreviewSummary = {
  chip: ChipSpec;
  pageCount: number | null;
  // The required scan message when nothing could be read; null otherwise.
  scanMessage: string | null;
  warnings: string[];
  note: string;
  // At least one proposed value was found.
  foundValues: boolean;
};

export function summarizePreview(preview: OnboardingPreviewDto): PreviewSummary {
  const noText = preview.extraction.reasons.some((reason) => reason.code === "no_extractable_text");
  const foundValues = previewRows(preview).some((item) => item.value !== null);
  const scanMessage = preview.extraction.status === "MANUAL_REVIEW_REQUIRED" && (noText || !foundValues) ? SCAN_MANUAL_REVIEW_MESSAGE : null;
  return {
    chip: extractionStatusChip(preview.extraction.status),
    pageCount: preview.extraction.pageCount,
    scanMessage,
    warnings: preview.extraction.reasons.filter((reason) => reason.code !== "no_extractable_text").map((reason) => reason.message),
    note: EXTRACTION_NOTE,
    foundValues,
  };
}

// The polite live-region text while and after the preview runs.
export function previewAnnouncement(input: { loading: boolean; preview: OnboardingPreviewDto | null; failure: string | null; fileName: string | null }): { tone: "info" | "success" | "warning" | "error"; text: string } | null {
  if (input.loading) return { tone: "info", text: `Reading ${input.fileName ?? "the Agreement"}… Nothing is saved.` };
  if (input.failure) return { tone: "error", text: input.failure };
  if (!input.preview) return null;
  const summary = summarizePreview(input.preview);
  if (summary.scanMessage) return { tone: "warning", text: summary.scanMessage };
  const count = previewRows(input.preview).filter((item) => item.value !== null).length;
  return { tone: input.preview.extraction.status === "PARTIAL" ? "warning" : "success", text: `Extraction finished: ${input.preview.extraction.status === "PARTIAL" ? "partial" : "complete"}, ${count} ${count === 1 ? "value" : "values"} proposed for the new record. Nothing has been created.` };
}

// Contract text (only for a person with contract access): masked once more here, whatever the server already did.
export function safeSnippets(preview: OnboardingPreviewDto): Array<{ key: string; page: number | null; text: string }> {
  return (preview.snippets ?? []).map((snippet, index) => ({ key: `${snippet.fieldKey}-${index}`, page: snippet.page, text: maskIdentityInText(snippet.snippet) }));
}

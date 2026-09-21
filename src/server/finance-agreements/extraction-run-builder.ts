import { sha256Hex, validateContractPdf } from "./contract-artifacts/validation";
import { EXTRACTION_REASON_ARTIFACT_INTEGRITY, EXTRACTION_REASON_PROPOSAL_DROPPED } from "./extraction-reasons";
import { classifyExtraction, splitRestricted, type ExtractionStatus, type SplitExtraction } from "./extraction/extraction-result";
import type { ExtractedFieldProposal, ExtractionWarning } from "./extraction/extraction-types";
import { extractAgreementFields } from "./extraction/field-extractors";
import { extractPdfText, type PdfTextResult } from "./extraction/pdf-text";
import {
  extractionProposalSchema,
  extractionRunDocSchema,
  MAX_EXTRACTION_PROPOSALS,
  restrictedExtractionDocSchema,
  type ExtractionProposal,
  type ExtractionRunDoc,
  type RestrictedExtractionDoc,
} from "./types";

// Step 14A: the PURE half of contract extraction - bytes -> a classified outcome -> the two
// documents a run produces (ordinary run + restricted record). No Firestore, no actor, no clock
// (the caller passes `now`). NEVER throws for a bad PDF: every failure is a MANUAL_REVIEW_REQUIRED
// outcome with a stable machine reason code and no proposals ("no partial garbage").
//
// Status means extraction COMPLETENESS only. Nothing produced here is operational: an ordinary
// proposal is data awaiting a human decision (requiresHumanConfirmation is always true).

export type PipelineOutcome = {
  pdf: PdfTextResult;
  fields: ExtractedFieldProposal[];
  warnings: ExtractionWarning[];
  status: ExtractionStatus;
  reasons: string[];
  missingCore: string[];
  split: SplitExtraction;
};

function failedOutcome(reason: "unreadable_pdf" | "no_extractable_text" | "encrypted" | "too_many_pages" | "timeout", extraReasons: string[] = []): PipelineOutcome {
  return {
    pdf: { ok: false, reason },
    fields: [],
    warnings: [],
    status: "MANUAL_REVIEW_REQUIRED",
    reasons: [reason, ...extraReasons],
    missingCore: [],
    split: splitRestricted([]),
  };
}

// bytes -> outcome. `expectedSha256` (the artifact record's digest) guards against a stored
// object that no longer matches its metadata.
export async function runExtractionPipeline(bytes: Uint8Array, expectedSha256: string): Promise<PipelineOutcome> {
  if (sha256Hex(bytes) !== expectedSha256) return failedOutcome("unreadable_pdf", [EXTRACTION_REASON_ARTIFACT_INTEGRITY]);
  if (!validateContractPdf(bytes).ok) return failedOutcome("unreadable_pdf");

  const pdf = await extractPdfText(bytes).catch((): PdfTextResult => ({ ok: false, reason: "unreadable_pdf" }));
  if (!pdf.ok) {
    const classification = classifyExtraction(pdf, []);
    return { pdf, fields: [], warnings: [], status: classification.status, reasons: [...classification.reasons], missingCore: [], split: splitRestricted([]) };
  }

  let fields: ExtractedFieldProposal[] = [];
  let warnings: ExtractionWarning[] = [];
  let ruleFailure = false;
  try {
    const extraction = extractAgreementFields(pdf.pages);
    fields = extraction.fields;
    warnings = extraction.warnings;
  } catch {
    ruleFailure = true;
  }
  const classification = classifyExtraction(pdf, fields, warnings);
  const reasons: string[] = [...classification.reasons];
  if (ruleFailure && !reasons.includes("extractor_rule_error")) reasons.push("extractor_rule_error");
  return { pdf, fields, warnings, status: classification.status, reasons, missingCore: classification.missingCore, split: splitRestricted(fields) };
}

function uniqueCodes(codes: readonly string[]): string[] {
  const out: string[] = [];
  for (const code of codes) {
    if (code.length >= 1 && code.length <= 100 && !out.includes(code)) out.push(code);
  }
  return out.slice(0, 20);
}

export type BuildExtractionDocsInput = {
  agreementRef: string;
  artifactRef: string;
  runRef: string;
  actorUserRef: string;
  now: string;
  parserVersion: string;
  outcome: PipelineOutcome;
};

export type ExtractionDocs = { run: ExtractionRunDoc; restricted: RestrictedExtractionDoc };

// The ordinary run (proposals WITHOUT raw snippets; identity fields value-less) and the restricted
// record (raw snippets + locators for every kept proposal, raw identity values) are built from the
// same kept-proposal list, so they can never disagree about which fields exist.
export function buildExtractionDocs(input: BuildExtractionDocsInput): ExtractionDocs {
  const { outcome } = input;
  const snippetByField = new Map<string, string>(outcome.split.restricted.rawSnippets.map((entry) => [entry.fieldKey, entry.rawSnippet] as const));
  const identityByField = new Map<string, string>(outcome.split.restricted.identityValues.map((entry) => [entry.fieldKey, entry.normalizedValue] as const));

  const proposals: ExtractionProposal[] = [];
  let dropped = 0;
  for (const ordinary of outcome.split.ordinary) {
    if (proposals.length >= MAX_EXTRACTION_PROPOSALS) {
      dropped += 1;
      continue;
    }
    const candidate = {
      fieldKey: ordinary.fieldKey,
      normalizedValue: ordinary.restricted ? null : (ordinary.normalizedValue ?? null),
      confidence: ordinary.confidence,
      warnings: ordinary.warnings.filter((warning) => warning.length >= 1 && warning.length <= 300).slice(0, 10),
      requiresHumanConfirmation: true as const,
      source: { page: ordinary.page },
    };
    const parsed = extractionProposalSchema.safeParse(candidate);
    if (parsed.success) proposals.push(parsed.data);
    else dropped += 1;
  }

  const restrictedFields: RestrictedExtractionDoc["fields"] = {};
  for (const proposal of proposals) {
    const snippet = snippetByField.get(proposal.fieldKey);
    const identityValue = identityByField.get(proposal.fieldKey);
    restrictedFields[proposal.fieldKey] = {
      rawSnippet: snippet ? snippet.slice(0, 2000) : null,
      locator: proposal.source.page === null ? null : `page ${proposal.source.page}`,
      rawValue: identityValue ? identityValue.slice(0, 1000) : null,
    };
  }

  // A dropped proposal means the pre-fill is incomplete: never report a clean EXTRACTED.
  let status = outcome.status;
  const extraReasons: string[] = [];
  if (dropped > 0) {
    extraReasons.push(EXTRACTION_REASON_PROPOSAL_DROPPED);
    if (status === "EXTRACTED") status = "PARTIAL";
  }
  const reasonCodes = uniqueCodes([...outcome.reasons, ...outcome.missingCore.map((key) => `missing_core:${key}`), ...extraReasons]);

  const run = extractionRunDocSchema.parse({
    runRef: input.runRef,
    agreementRef: input.agreementRef,
    artifactRef: input.artifactRef,
    status,
    reasonCodes,
    parserVersion: input.parserVersion,
    pageCount: outcome.pdf.ok ? outcome.pdf.pageCount : (outcome.pdf.pageCount ?? 0),
    charCount: outcome.pdf.ok ? outcome.pdf.totalChars : 0,
    proposals,
    createdAt: input.now,
    createdByUserRef: input.actorUserRef,
  });
  const restricted = restrictedExtractionDocSchema.parse({ runRef: input.runRef, agreementRef: input.agreementRef, artifactRef: input.artifactRef, fields: restrictedFields, createdAt: input.now });
  return { run, restricted };
}

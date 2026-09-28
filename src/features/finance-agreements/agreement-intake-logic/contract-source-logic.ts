import type { ContractArtifactDto, ExtractionResultDto, ExtractionSourceDto } from "@/server/finance-agreements/client-dto";
import type { ExtractionRunStatus } from "@/server/finance-agreements/types";

import { checkContractFile, EXTRACTION_NOTE, OCR_COMPLETED_MESSAGE, OCR_LOW_CONFIDENCE_MESSAGE, SCAN_MANUAL_REVIEW_MESSAGE, type ChipSpec, extractionStatusChip } from "../format";

// Step 14B intake, section 2 (`Contract source`): the pure decisions behind the upload / extract / attach controls.

export type FilePick = { file: File; error: null } | { file: null; error: string } | { file: null; error: null };

// A picked file: PDF only, non-empty, at most 10 MB (a client pre-check - the server is the truth and re-checks the bytes).
export function pickContractFile(file: File | null | undefined): FilePick {
  if (!file) return { file: null, error: null };
  const error = checkContractFile(file);
  return error ? { file: null, error } : { file, error: null };
}

export type ExtractionAnnouncement = { text: string; tone: "info" | "success" | "warning" };

// The polite live-region text for each stage, so screen-reader users hear the same progress a sighted user sees.
export function extractionAnnouncement(input: { phase: "idle" | "uploading" | "extracting"; extraction: ExtractionResultDto | null; attached: boolean; fileName: string | null }): ExtractionAnnouncement | null {
  if (input.phase === "uploading") return { text: `Uploading ${input.fileName ?? "the Agreement"}…`, tone: "info" };
  if (input.phase === "extracting") return { text: "Reading the Agreement…", tone: "info" };
  if (!input.extraction) return null;
  const { run, fields } = input.extraction;
  if (run.status === "MANUAL_REVIEW_REQUIRED") return { text: SCAN_MANUAL_REVIEW_MESSAGE, tone: "warning" };
  const suffix = input.attached ? " They are in the draft as pending values." : " Nothing has been added to the draft yet.";
  return { text: `Extraction finished: ${run.status === "PARTIAL" ? "partial" : "complete"}, ${fields.length} ${fields.length === 1 ? "value" : "values"} proposed.${suffix}`, tone: run.status === "PARTIAL" ? "warning" : "success" };
}

// OCR Completion stage (spec section 20/22): set only on a SUCCESSFUL OCR run (never on native
// text, never while manual review is still required) - "OCR completed…" or, when any page's
// confidence band was not USABLE, the low-confidence variant. Extracted as its own function so both
// `summarizeExtraction` (Step 2 review) and `ExtractionReviewPane` (Step 1, right after extraction
// returns) can share the exact same decision without duplicating it.
export function ocrMessageFromSource(source: ExtractionSourceDto, status: ExtractionRunStatus): string | null {
  if (source.kind !== "ocr" || status === "MANUAL_REVIEW_REQUIRED") return null;
  return source.ocrPageBands.some((page) => page.band !== "USABLE") ? OCR_LOW_CONFIDENCE_MESSAGE : OCR_COMPLETED_MESSAGE;
}

export type ExtractionSummary = {
  chip: ChipSpec;
  // Reason messages to show as warnings. The no-text/ocr_used reasons are replaced by scanMessage/ocrMessage, never shown twice.
  warnings: string[];
  scanMessage: string | null;
  ocrMessage: string | null;
  note: string;
  proposalCount: number;
  // Something could be attached: at least one proposal the actor may see.
  attachable: boolean;
};

export function summarizeExtraction(extraction: ExtractionResultDto): ExtractionSummary {
  const noText = extraction.reasons.some((reason) => reason.code === "no_extractable_text");
  const scanMessage = extraction.run.status === "MANUAL_REVIEW_REQUIRED" && (noText || extraction.fields.length === 0) ? SCAN_MANUAL_REVIEW_MESSAGE : null;
  const warnings = extraction.reasons.filter((reason) => reason.code !== "no_extractable_text" && reason.code !== "ocr_used").map((reason) => reason.message);
  const attachable = extraction.fields.some((field) => field.valueState === "VISIBLE");
  const ocrMessage = ocrMessageFromSource(extraction.run.source, extraction.run.status);
  return { chip: extractionStatusChip(extraction.run.status), warnings, scanMessage, ocrMessage, note: EXTRACTION_NOTE, proposalCount: extraction.fields.length, attachable };
}

export function artifactSummaryText(artifact: Pick<ContractArtifactDto, "fileName" | "sizeBytes" | "status">, formatSize: (bytes: number) => string): string {
  return `${artifact.fileName} · ${formatSize(artifact.sizeBytes)}`;
}

// Which controls the section offers (all derived from server booleans + state; nothing revealed then hidden).
export function contractControls(input: { canExtract: boolean; hasFile: boolean; busy: boolean; extraction: ExtractionResultDto | null; attached: boolean }): { showUpload: boolean; canRun: boolean; showAttach: boolean; canAttach: boolean } {
  const attachable = input.extraction ? summarizeExtraction(input.extraction).attachable : false;
  return {
    showUpload: input.canExtract,
    canRun: input.canExtract && input.hasFile && !input.busy,
    showAttach: input.canExtract && !!input.extraction && attachable && !input.attached,
    canAttach: input.canExtract && !!input.extraction && attachable && !input.attached && !input.busy,
  };
}

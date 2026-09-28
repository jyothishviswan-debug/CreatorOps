import type { ActorContext } from "@/server/authz/types";

import { toInvoiceExtractionPreviewDto, type InvoiceExtractionPreviewDto } from "./client-dto";
import { validateInvoicePdf, sha256Hex } from "./document-storage";
import { runOcrForInvoice } from "./extraction-ocr";
import { runInvoiceExtraction, type OcrRunOutcome } from "./extraction/pipeline";
import { loadAuthorizedInvoice, requireAuthoringAccess } from "./finance-invoices-gate";
import { formatIssues } from "./service-common";
import { financeInvoicesConflictResult, financeInvoicesInvalidInputResult, financeInvoicesUnauthorizedResult, previewInvoiceExtractionInputSchema, type FinanceInvoicesServiceResult } from "./types";

// Step 15C section 19/24/26: the trusted service wrapper around the pure, offline extraction
// pipeline (extraction/pipeline.ts). READ-ONLY and EPHEMERAL by design: nothing here writes to
// Firestore, nothing here persists an extraction run, and no Invoice field is ever confirmed by
// this call - every proposal it returns is exactly that, a proposal, until the actor explicitly
// edits/confirms the corresponding field client-side (the "user-touched" rule lives entirely in
// the browser for this step - see InvoiceCreatePage.tsx - because the Invoice draft here is a
// flat, client-held form, not a persisted per-field decision draft the way Agreement extraction's
// is; porting THAT heavier architecture was judged out of scope for this correction - the
// functional guarantee "a later extraction result never silently overwrites what a person already
// touched" is fully implemented, just at the client layer that actually holds the draft).
//
// Runs over the EXACT bytes the browser already staged locally for the (separate) document-attach
// call - so this never needs to read a document back out of storage, and the Invoice does not need
// a document attached yet to preview its extraction.
export async function previewInvoiceExtraction(actor: ActorContext | null, rawInput: unknown): Promise<FinanceInvoicesServiceResult<InvoiceExtractionPreviewDto>> {
  const access = await requireAuthoringAccess(actor, "manage_invoices");
  if (!access.ok) return financeInvoicesUnauthorizedResult(access.reason);

  const parsed = previewInvoiceExtractionInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeInvoicesInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const loaded = await loadAuthorizedInvoice(actor, input.invoiceRef, "manage_invoices");
  if (!loaded.ok) return loaded.error;
  if (loaded.authorized.head.status !== "DRAFT") return financeInvoicesConflictResult("Extraction can only be previewed on a draft invoice.");

  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(input.contentBase64, "base64");
  } catch {
    return financeInvoicesInvalidInputResult("The document content is not valid base64.");
  }
  const validation = validateInvoicePdf(bytes);
  if (!validation.ok) return financeInvoicesInvalidInputResult(`The document could not be read: ${validation.reason.replace(/_/g, " ")}.`);

  // OCR Completion stage: bridges extraction-ocr.ts's own OcrExtractionOutcome shape (a `pdf`
  // object, matching Agreement extraction's convention) onto pipeline.ts's simpler `pages` array -
  // both files stay independently natural rather than one distorting its shape for the other.
  const ocrRunner = async (input: Uint8Array, sha256: string): Promise<OcrRunOutcome> => {
    const outcome = await runOcrForInvoice(input, sha256);
    if (!outcome.ok) return outcome;
    return { ok: true, pages: outcome.pdf.pages, pageInfo: outcome.pageInfo, providerId: outcome.providerId, providerVersion: outcome.providerVersion, configVersion: outcome.configVersion };
  };

  const result = await runInvoiceExtraction(bytes, ocrRunner, sha256Hex(bytes));
  return { ok: true, data: toInvoiceExtractionPreviewDto(result) };
}

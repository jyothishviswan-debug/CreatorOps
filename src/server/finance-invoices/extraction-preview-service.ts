import type { ActorContext } from "@/server/authz/types";

import { toInvoiceExtractionPreviewDto, type InvoiceExtractionPreviewDto } from "./client-dto";
import { validateInvoicePdf } from "./document-storage";
import { runInvoiceExtraction } from "./extraction/pipeline";
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

  const result = await runInvoiceExtraction(bytes);
  return { ok: true, data: toInvoiceExtractionPreviewDto(result) };
}

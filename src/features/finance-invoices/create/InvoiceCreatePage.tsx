"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { attachInvoiceDocument, createInvoiceDraft, previewInvoiceEligibility, previewInvoiceExtraction, reconcileInvoice, reviseInvoiceDraft } from "../api-client";
import { todayUtcDate } from "../format";
import type { InvoiceDetailDto, InvoiceExtractedFieldProposalDto, InvoiceVersionDto } from "@/server/finance-invoices/client-dto";
import type { InvoicePermissionsDto } from "@/server/finance-invoices/client-dto";
import type { PreviewInvoiceEligibilityDto } from "@/server/finance-invoices/invoice-service";

import { ConfirmStep } from "./ConfirmStep";
import { applyInvoiceExtractionPrefill, emptyInvoiceDetailsForm, reviseFieldsFromForm, type AppliedExtractionKey, type CreateStage, type InvoiceDetailsForm, type TouchableInvoiceField } from "./create-view";
import { InvoiceDetailsStep, type ExtractionUiStatus, type StagedDocument } from "./InvoiceDetailsStep";
import { ReconciliationStep } from "./ReconciliationStep";
import { SourcePayableStep } from "./SourcePayableStep";

const STAGE_SUBTITLES: Record<CreateStage, string> = {
  1: "Choose a Payable that is ready for invoicing.",
  2: "Enter the supplier invoice details and attach the original document.",
  3: "Compare the Invoice with the pinned Payable and resolve any differences.",
  4: "Review the Invoice before creating it as Draft.",
};

// Step 16B: /finance/invoices/new - a focused 4-stage horizontal workflow (Source Payable -> Invoice
// Details -> Reconciliation -> Confirm), never a vertical stepper.
//
// PERSISTENCE MODEL (a genuine Step-16A backend constraint, not a shortcut): `createInvoiceDraft`
// only ever takes a `payableRef` - there is no single "create with full detail" command. Stage 1
// stays read-only (selection + `previewInvoiceEligibility`, which writes nothing). The canonical
// Invoice record is created, and its declared fields are first saved, together on Stage 2's
// "Continue" (create once, idempotently, then `reviseInvoiceDraft` with everything entered, then
// `attachInvoiceDocument` if a file was staged) - only then can the server compute the REAL
// reconciliation Stage 3 shows (reconciliation is computed server-side; there is no dry-run
// endpoint). Stage 4's "Create Invoice" therefore finalizes and opens the already-created Draft -
// consistent with the copy it shows ("The Invoice will be created as Draft"): nothing here ever
// implies Submitted or Approved.
export function InvoiceCreatePage({ permissions }: { permissions: InvoicePermissionsDto }) {
  const router = useRouter();
  const [stage, setStage] = useState<CreateStage>(1);

  const [selectedPayableRef, setSelectedPayableRef] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewInvoiceEligibilityDto | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [detailsForm, setDetailsForm] = useState<InvoiceDetailsForm>(emptyInvoiceDetailsForm("INR"));
  const [stagedDocument, setStagedDocument] = useState<StagedDocument | null>(null);

  // Step 15C section 19/24/26: extraction state. `touchedFieldsRef` is the "user-touched" guard -
  // a REF, not state, so an in-flight extraction call (async, can resolve well after the user has
  // already started typing) always reads the LATEST touched set, never a stale closure's. Every
  // call to `handleDetailsChange` below marks its changed keys touched BEFORE updating form state,
  // so a race between "user types" and "extraction resolves" can never let the extraction win.
  const touchedFieldsRef = useRef<Set<TouchableInvoiceField>>(new Set());
  const [extractionStatus, setExtractionStatus] = useState<ExtractionUiStatus>("idle");
  // The fields `applyExtractionPrefill` ACTUALLY wrote into the form (never every key the server
  // merely proposed, whether applied or not - see AppliedExtractionKey's own doc comment in
  // create-view.ts). This is what drives the "Extracted" tag. Set from INSIDE the same
  // `setDetailsForm` updater that computes it, so it is always derived from the identical,
  // correctly-latest `current` form the updater read - never a separate, possibly-stale closure
  // over `detailsForm` (real React state, not a ref - a ref's `.current` must never be read during
  // render, which is exactly where this value is consumed, in the JSX below).
  const [appliedExtractionKeys, setAppliedExtractionKeys] = useState<ReadonlySet<AppliedExtractionKey>>(new Set());
  const [extractionError, setExtractionError] = useState<string | null>(null);

  const [invoice, setInvoice] = useState<InvoiceDetailDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [reconciledVersion, setReconciledVersion] = useState<InvoiceVersionDto | null>(null);
  const [reconcileLoading, setReconcileLoading] = useState(false);
  const [reconcileError, setReconcileError] = useState<string | null>(null);

  const [finishing, setFinishing] = useState(false);

  async function selectPayable(payableRef: string) {
    setSelectedPayableRef(payableRef);
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    const result = await previewInvoiceEligibility(payableRef);
    setPreviewLoading(false);
    if (!result.ok) {
      setPreviewError(result.message);
      return;
    }
    setPreview(result.data);
    if (result.data.pin) setDetailsForm((current) => (current.currency ? current : { ...current, currency: result.data.pin!.payableCurrency }));
  }

  function goToStage2() {
    if (preview?.pin) setDetailsForm((current) => ({ ...current, currency: current.currency || preview.pin!.payableCurrency }));
    setStage(2);
  }

  // The ONLY path that mutates form state from a USER edit - every key it touches is marked
  // touched FIRST, so a still-in-flight extraction result can never overwrite it (see
  // touchedFieldsRef's own comment above).
  function handleDetailsChange(change: Partial<InvoiceDetailsForm>) {
    for (const key of Object.keys(change)) touchedFieldsRef.current.add(key as TouchableInvoiceField);
    setDetailsForm((current) => ({ ...current, ...change }));
  }

  // Prefills ONLY the fields the user has not already touched, via the PURE (unit-tested)
  // applyInvoiceExtractionPrefill in create-view.ts. Never called from handleDetailsChange itself -
  // this is the one and only path that mutates form state WITHOUT marking fields touched.
  function applyExtractionPrefill(fields: InvoiceExtractedFieldProposalDto[]) {
    setDetailsForm((current) => {
      const { form, appliedKeys } = applyInvoiceExtractionPrefill(current, fields, touchedFieldsRef.current);
      setAppliedExtractionKeys(appliedKeys);
      return form;
    });
  }

  // Stages the file locally (no server call yet - InvoiceDetailsStep already does this), then runs
  // extraction over the SAME bytes. Creates the Draft first if one does not exist yet (idempotent -
  // `createInvoiceDraft` is safe to call again from `saveDetailsAndContinue`, which checks `invoice`
  // state before creating; this never creates a second Draft, see that function's own comment).
  async function onDocumentStaged(document: StagedDocument) {
    setStagedDocument(document);
    setExtractionStatus("extracting");
    setExtractionError(null);

    // Received date is never extracted from the document itself (it records when WE received it,
    // not a date the invoice declares) - default it to today the moment a file is staged, exactly
    // like a person would fill it in by hand. Respects the same touched-field guard as every other
    // field, so a value the user already set (on this document or a prior one) is never overwritten.
    if (!touchedFieldsRef.current.has("receivedDate")) {
      setDetailsForm((current) => (current.receivedDate ? current : { ...current, receivedDate: todayUtcDate() }));
    }

    let current = invoice;
    if (!current) {
      if (!selectedPayableRef) {
        setExtractionStatus("failed");
        setExtractionError("Select a Payable before attaching a document.");
        return;
      }
      const created = await createInvoiceDraft(selectedPayableRef);
      if (!created.ok) {
        setExtractionStatus("failed");
        setExtractionError(created.message);
        return;
      }
      current = created.data.data;
      setInvoice(current);
    }

    const result = await previewInvoiceExtraction(current.head.invoiceRef, { contentBase64: document.contentBase64 });
    if (!result.ok) {
      setExtractionStatus("failed");
      setExtractionError(result.message);
      return;
    }
    setExtractionStatus(result.data.status);
    applyExtractionPrefill(result.data.fields);
  }

  function onClearStagedDocument() {
    setStagedDocument(null);
    setExtractionStatus("idle");
    setAppliedExtractionKeys(new Set());
    setExtractionError(null);
  }

  // Stage 2 -> 3: create the Draft if it does not exist yet, save every declared field, attach a
  // staged document, then load the freshly computed reconciliation for Stage 3.
  async function saveDetailsAndContinue() {
    if (!selectedPayableRef) return;
    const parsed = reviseFieldsFromForm(detailsForm);
    if (!parsed.ok) {
      setSaveError(parsed.errors.join(" "));
      return;
    }
    setSaving(true);
    setSaveError(null);

    let current = invoice;
    if (!current) {
      const created = await createInvoiceDraft(selectedPayableRef);
      if (!created.ok) {
        setSaving(false);
        setSaveError(created.message);
        return;
      }
      current = created.data.data;
      setInvoice(current);
    }

    const revised = await reviseInvoiceDraft(current.head.invoiceRef, { expectedDocVersion: current.head.docVersion, ...parsed.fields, reason: "Invoice details entered." });
    if (!revised.ok) {
      setSaving(false);
      setSaveError(revised.message);
      return;
    }
    current = revised.data;
    setInvoice(current);

    if (stagedDocument) {
      const attached = await attachInvoiceDocument(current.head.invoiceRef, { expectedDocVersion: current.head.docVersion, fileName: stagedDocument.fileName, contentBase64: stagedDocument.contentBase64 });
      if (!attached.ok) {
        setSaving(false);
        setSaveError(attached.message);
        return;
      }
      current = attached.data;
      setInvoice(current);
    }

    setSaving(false);
    await loadReconciliation(current.head.invoiceRef);
    setStage(3);
  }

  async function loadReconciliation(invoiceRef: string) {
    setReconcileLoading(true);
    setReconcileError(null);
    const result = await reconcileInvoice(invoiceRef);
    setReconcileLoading(false);
    if (!result.ok) {
      setReconcileError(result.message);
      return;
    }
    setReconciledVersion(result.data);
  }

  function onFinish() {
    if (!invoice) return;
    setFinishing(true);
    router.push(`/finance/invoices/${encodeURIComponent(invoice.head.invoiceRef)}`);
  }

  const canContinueFromSource = Boolean(selectedPayableRef && preview?.eligible);
  const continueLabel = stage === 2 ? (saving ? "Saving…" : "Continue") : "Continue";

  function onContinue() {
    if (stage === 1 && canContinueFromSource) {
      goToStage2();
      return;
    }
    if (stage === 2) {
      void saveDetailsAndContinue();
      return;
    }
    if (stage === 3) {
      setStage(4);
    }
  }

  function onBack() {
    if (stage === 2) setStage(1);
    else if (stage === 3) setStage(2);
    else if (stage === 4) setStage(3);
  }

  return (
    <div className="page">
      <div className="head">
        <div>
          <div className="eyebrow">FINANCE / INVOICES / NEW INVOICE</div>
          <h1>Create Invoice</h1>
          <p>{STAGE_SUBTITLES[stage]}</p>
        </div>
        <div className="actions">
          <Link href="/finance/invoices" className="btn">
            Cancel
          </Link>
          {stage > 1 && stage < 4 && (
            <button type="button" className="btn" onClick={onBack}>
              Back
            </button>
          )}
          {stage < 4 && (
            <button type="button" className="btn primary" disabled={stage === 1 ? !canContinueFromSource || previewLoading : saving} onClick={onContinue}>
              {continueLabel}
            </button>
          )}
        </div>
      </div>

      {saveError && (
        <div className="banner" role="alert" style={{ marginBottom: 14 }}>
          {saveError}
        </div>
      )}

      {stage === 1 && <SourcePayableStep selectedPayableRef={selectedPayableRef} onSelect={(ref) => void selectPayable(ref)} preview={preview} previewLoading={previewLoading} previewError={previewError} />}

      {stage === 2 && (
        <InvoiceDetailsStep
          form={detailsForm}
          onChange={handleDetailsChange}
          existingDocument={invoice?.selectedVersion?.document ?? null}
          stagedDocument={stagedDocument}
          onStageDocument={(document) => void onDocumentStaged(document)}
          onClearStagedDocument={onClearStagedDocument}
          preview={preview}
          extractionStatus={extractionStatus}
          appliedExtractionKeys={appliedExtractionKeys}
          extractionError={extractionError}
        />
      )}

      {stage === 3 && <ReconciliationStep version={reconciledVersion} loading={reconcileLoading} error={reconcileError} amountsVisible={permissions.canViewAmounts} />}

      {stage === 4 && invoice && <ConfirmStep detail={invoice} onFinish={onFinish} navigating={finishing} />}
    </div>
  );
}

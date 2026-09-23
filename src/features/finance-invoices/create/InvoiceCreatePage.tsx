"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { attachInvoiceDocument, createInvoiceDraft, previewInvoiceEligibility, reconcileInvoice, reviseInvoiceDraft } from "../api-client";
import type { InvoiceDetailDto, InvoiceVersionDto } from "@/server/finance-invoices/client-dto";
import type { InvoicePermissionsDto } from "@/server/finance-invoices/client-dto";
import type { PreviewInvoiceEligibilityDto } from "@/server/finance-invoices/invoice-service";

import { ConfirmStep } from "./ConfirmStep";
import { emptyInvoiceDetailsForm, reviseFieldsFromForm, type CreateStage, type InvoiceDetailsForm } from "./create-view";
import { InvoiceDetailsStep, type StagedDocument } from "./InvoiceDetailsStep";
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
          onChange={(change) => setDetailsForm((current) => ({ ...current, ...change }))}
          existingDocument={invoice?.selectedVersion?.document ?? null}
          stagedDocument={stagedDocument}
          onStageDocument={setStagedDocument}
          onClearStagedDocument={() => setStagedDocument(null)}
          preview={preview}
        />
      )}

      {stage === 3 && <ReconciliationStep version={reconciledVersion} loading={reconcileLoading} error={reconcileError} amountsVisible={permissions.canViewAmounts} />}

      {stage === 4 && invoice && <ConfirmStep detail={invoice} onFinish={onFinish} navigating={finishing} />}
    </div>
  );
}

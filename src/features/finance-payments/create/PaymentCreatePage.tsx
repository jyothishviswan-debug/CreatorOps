"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { PaymentPermissionsDto } from "@/server/finance-payments/client-dto";
import type { InvoicePaymentSettlementDto, PaymentDetailDto } from "@/server/finance-payments/client-dto";

import { createPaymentDraft, getInvoicePaymentSettlement, revisePaymentDraft } from "../api-client";
import { todayUtcDate } from "../format";
import { ConfirmStep } from "./ConfirmStep";
import { emptyPaymentDetailsForm, reviseFieldsFromForm, type CreateStage, type PaymentDetailsForm } from "./create-view";
import { PaymentDetailsStep } from "./PaymentDetailsStep";
import { SourceInvoiceStep } from "./SourceInvoiceStep";

const STAGE_SUBTITLES: Record<CreateStage, string> = {
  1: "Choose an approved Invoice with an outstanding balance.",
  2: "Enter the details of the money movement.",
  3: "Review the Payment before recording it.",
};

// Step 17B: /finance/payments/new - a focused 3-stage horizontal workflow (Source Invoice ->
// Payment Details -> Confirm), never a vertical stepper.
//
// PERSISTENCE MODEL (a genuine Step-17A backend constraint, not a shortcut): `createPaymentDraft`
// is NOT idempotent by design (one approved Invoice may found one OR MORE Payments - partial
// payments, split transfers, retries), and it only ever takes an `invoiceRef` - there is no preview/
// dry-run command the way Invoices' own `previewInvoiceEligibility` is. Stage 1 therefore stays
// PURELY READ-ONLY (selection only, via Invoices' own detail/settlement reads - see
// SourceInvoiceStep.tsx) and the Draft is created exactly ONCE, on Stage 1 -> Stage 2's "Continue".
// Stage 2's fields are then saved with `revisePaymentDraft` on Stage 2 -> Stage 3's "Continue".
// Stage 3's "Create Payment" therefore finalizes nothing further - it opens the already-created,
// already-declared Draft, consistent with the copy it shows ("This Payment will be created as
// Draft."): nothing here ever implies Recorded or Confirmed.
// `permissions` is accepted (mirroring every other Finance create page's own signature - see
// InvoiceCreatePage.tsx) even though this flow does not currently branch on it: amountsVisible is
// read per-screen from the DTOs already in hand (InvoiceDetailDto.amountsVisible,
// InvoicePaymentSettlementDto.amountsVisible, PaymentDetailDto.amountsVisible), never from a
// separately-passed permission flag, so there is no risk of it drifting from what the server
// actually withheld.
export function PaymentCreatePage({ permissions }: { permissions: PaymentPermissionsDto }) {
  void permissions;
  const router = useRouter();
  const [stage, setStage] = useState<CreateStage>(1);

  const [selectedInvoiceRef, setSelectedInvoiceRef] = useState<string | null>(null);
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [payment, setPayment] = useState<PaymentDetailDto | null>(null);
  const [settlement, setSettlement] = useState<InvoicePaymentSettlementDto | null>(null);
  const [settlementBeforeConfirm, setSettlementBeforeConfirm] = useState<InvoicePaymentSettlementDto | null>(null);

  const [detailsForm, setDetailsForm] = useState<PaymentDetailsForm>(emptyPaymentDetailsForm(null, todayUtcDate()));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [finishing, setFinishing] = useState(false);

  function handleDetailsChange(change: Partial<PaymentDetailsForm>) {
    setDetailsForm((current) => ({ ...current, ...change }));
  }

  async function goToStage2() {
    if (!selectedInvoiceRef) return;
    setCreatingDraft(true);
    setCreateError(null);
    const [created, settlementResult] = await Promise.all([createPaymentDraft(selectedInvoiceRef), getInvoicePaymentSettlement(selectedInvoiceRef)]);
    setCreatingDraft(false);
    if (!created.ok) {
      setCreateError(created.message);
      return;
    }
    setPayment(created.data);
    if (settlementResult.ok) {
      setSettlement(settlementResult.data);
      setDetailsForm(emptyPaymentDetailsForm(settlementResult.data.summary.remainingMinor, todayUtcDate()));
    } else {
      setDetailsForm(emptyPaymentDetailsForm(null, todayUtcDate()));
    }
    setStage(2);
  }

  async function saveDetailsAndContinue() {
    if (!payment) return;
    const parsed = reviseFieldsFromForm(detailsForm);
    if (!parsed.ok) {
      setSaveError(parsed.errors.join(" "));
      return;
    }
    setSaving(true);
    setSaveError(null);
    const revised = await revisePaymentDraft(payment.head.paymentRef, { expectedDocVersion: payment.head.docVersion, ...parsed.fields, reason: "Payment details entered." });
    setSaving(false);
    if (!revised.ok) {
      setSaveError(revised.message);
      return;
    }
    setPayment(revised.data);
    // The settlement snapshot captured just before this Payment's amount was declared - what
    // Stage 3's "Confirmed paid before" / "Remaining if/when confirmed" reads. Never re-fetched
    // after this point (this stage never mutates settlement; only a future Confirm action does).
    setSettlementBeforeConfirm(settlement);
    setStage(3);
  }

  function onFinish() {
    if (!payment) return;
    setFinishing(true);
    router.push(`/finance/payments/${encodeURIComponent(payment.head.paymentRef)}`);
  }

  const canContinueFromSource = Boolean(selectedInvoiceRef);
  const continueLabel = stage === 1 ? (creatingDraft ? "Creating…" : "Continue") : stage === 2 ? (saving ? "Saving…" : "Continue") : "Continue";

  function onContinue() {
    if (stage === 1 && canContinueFromSource) {
      void goToStage2();
      return;
    }
    if (stage === 2) {
      void saveDetailsAndContinue();
    }
  }

  function onBack() {
    if (stage === 2) setStage(1);
    else if (stage === 3) setStage(2);
  }

  return (
    <div className="page">
      <div className="head">
        <div>
          <div className="eyebrow">FINANCE / PAYMENTS / RECORD PAYMENT</div>
          <h1>Record Payment</h1>
          <p>{STAGE_SUBTITLES[stage]}</p>
        </div>
        <div className="actions">
          <Link href="/finance/payments" className="btn">
            Cancel
          </Link>
          {stage > 1 && stage < 3 && (
            <button type="button" className="btn" onClick={onBack}>
              Back
            </button>
          )}
          {stage < 3 && (
            <button type="button" className="btn primary" disabled={stage === 1 ? !canContinueFromSource || creatingDraft : saving} onClick={onContinue}>
              {continueLabel}
            </button>
          )}
        </div>
      </div>

      {createError && (
        <div className="banner" role="alert" style={{ marginBottom: 14 }}>
          {createError}
        </div>
      )}
      {saveError && (
        <div className="banner" role="alert" style={{ marginBottom: 14 }}>
          {saveError}
        </div>
      )}

      {stage === 1 && <SourceInvoiceStep selectedInvoiceRef={selectedInvoiceRef} onSelect={setSelectedInvoiceRef} />}

      {stage === 2 && payment && <PaymentDetailsStep form={detailsForm} onChange={handleDetailsChange} currency={payment.head.currency} settlement={settlement} />}

      {stage === 3 && payment && <ConfirmStep detail={payment} settlementBefore={settlementBeforeConfirm} onFinish={onFinish} navigating={finishing} />}
    </div>
  );
}

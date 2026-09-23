"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { createPayable, previewPayableSource, type PayableSourceRequestInput } from "../api-client";
import type { PayableDetailDto, PayablePermissionsDto, PayableSourcePreviewDto } from "@/server/finance-payables/client-dto";
import type { PayableCounterpartyType } from "@/server/finance-payables/types";

import { canCreatePayable, sourceReadiness, type CreateStage } from "./create-view";
import { ConfirmCreateStep } from "./ConfirmCreateStep";
import { ReviewAmountStep } from "./ReviewAmountStep";
import { SourceStep } from "./SourceStep";

const STAGE_SUBTITLES: Record<CreateStage, string> = {
  1: "Choose the commercial source and period. CreatorOps will use the pinned Agreement and finalized evidence to prepare the payable.",
  2: "Review the amount breakdown CreatorOps determined from the pinned evidence.",
  3: "Review all details and confirm to create the Payable. You can go back and edit any section if needed.",
};

export type SourceSelection = {
  counterpartyType: PayableCounterpartyType | null;
  counterpartyRef: string;
  counterpartyDisplayName: string;
  commercialPeriod: string;
  agreementRef: string;
};

const EMPTY_SELECTION: SourceSelection = { counterpartyType: null, counterpartyRef: "", counterpartyDisplayName: "", commercialPeriod: "", agreementRef: "" };

function toRequestInput(selection: SourceSelection): PayableSourceRequestInput | null {
  if (!selection.counterpartyType || !selection.counterpartyRef || !selection.commercialPeriod) return null;
  if (selection.counterpartyType === "VENDOR" && !selection.agreementRef) return null;
  return {
    counterpartyType: selection.counterpartyType,
    counterpartyRef: selection.counterpartyRef,
    commercialPeriod: selection.commercialPeriod,
    ...(selection.counterpartyType === "VENDOR" ? { agreementRef: selection.agreementRef } : {}),
  };
}

// Step 15B: /finance/payables/new - a three-stage IN-PAGE workflow (Source -> Review amount -> Confirm),
// never a vertical stepper. `payable` is created lazily: the wizard stays a read-only preview through
// Stage 1/2 until either a manual adjustment is added (which needs a real Payable to attach to) or the
// person reaches Confirm and clicks "Create Payable" - `createPayable` is idempotent by business key, so
// calling it more than once for the same basis can never create a duplicate.
export function PayableCreatePage({ permissions }: { permissions: PayablePermissionsDto }) {
  const router = useRouter();
  const [stage, setStage] = useState<CreateStage>(1);
  const [selection, setSelection] = useState<SourceSelection>(EMPTY_SELECTION);
  const [preview, setPreview] = useState<PayableSourcePreviewDto | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [payable, setPayable] = useState<PayableDetailDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function runPreview(next: SourceSelection) {
    const input = toRequestInput(next);
    if (!input) {
      setPreview(null);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    const result = await previewPayableSource(input);
    setPreviewLoading(false);
    if (!result.ok) {
      if (result.aborted) return;
      setPreviewError(result.message);
      setPreview(null);
      return;
    }
    setPreview(result.data);
  }

  function updateSelection(change: Partial<SourceSelection>) {
    const next = { ...selection, ...change };
    setSelection(next);
    setPayable(null);
    void runPreview(next);
  }

  // Idempotent: the second call for the same basis returns the SAME canonical Payable (200, outcome
  // "existing"), never a duplicate.
  async function ensurePayableCreated(): Promise<PayableDetailDto | null> {
    if (payable) return payable;
    const input = toRequestInput(selection);
    if (!input) return null;
    setCreating(true);
    setCreateError(null);
    const result = await createPayable(input);
    setCreating(false);
    if (!result.ok) {
      setCreateError(result.message);
      return null;
    }
    setPayable(result.data);
    return result.data;
  }

  function onAdjustmentApplied(updated: PayableDetailDto) {
    setPayable(updated);
  }

  async function onCreate() {
    const created = await ensurePayableCreated();
    if (created) router.push(`/finance/payables/${encodeURIComponent(created.head.payableRef)}`);
  }

  const readiness = sourceReadiness(preview);
  const canContinueFromSource = readiness.canContinue && toRequestInput(selection) !== null;

  return (
    <div className="page">
      <div className="head">
        <div>
          <div className="eyebrow">FINANCE / PAYABLES / NEW PAYABLE</div>
          <h1>Create Payable</h1>
          <p>{STAGE_SUBTITLES[stage]}</p>
        </div>
        <div className="actions">
          <Link href="/finance/payables" className="btn">
            Cancel
          </Link>
          {stage > 1 && (
            <button type="button" className="btn" onClick={() => setStage((stage - 1) as CreateStage)}>
              Back
            </button>
          )}
          {stage < 3 && (
            <button type="button" className="btn primary" disabled={stage === 1 ? !canContinueFromSource : previewLoading} onClick={() => setStage((stage + 1) as CreateStage)}>
              Continue
            </button>
          )}
        </div>
      </div>

      {stage === 1 && <SourceStep selection={selection} onChange={updateSelection} preview={preview} loading={previewLoading} error={previewError} readiness={readiness} />}

      {stage === 2 && preview && (
        <ReviewAmountStep preview={preview} payable={payable} onEnsurePayable={ensurePayableCreated} onAdjustmentApplied={onAdjustmentApplied} creating={creating} createError={createError} canAdjust={permissions.canAdjust} amountsVisible={permissions.canViewAmounts} />
      )}

      {stage === 3 && preview && (
        <ConfirmCreateStep
          preview={preview}
          payable={payable}
          canCreate={canCreatePayable(preview)}
          creating={creating}
          createError={createError}
          onCreate={onCreate}
          onGoToStage={(target) => setStage(target)}
        />
      )}
    </div>
  );
}

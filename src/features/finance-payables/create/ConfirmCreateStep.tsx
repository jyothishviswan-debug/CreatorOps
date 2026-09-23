"use client";

import type { PayableDetailDto, PayableSourcePreviewDto } from "@/server/finance-payables/client-dto";

import { commercialPeriodLabel, determinationChip, sourceRefLabel, sourceTypeLabel } from "../format";
import { breakdownRows, breakdownTotalText, confirmReadiness, DRAFT_LIFECYCLE_WORDING, type CreateStage } from "./create-view";

// Step 15B: Create Payable - Stage 3 (Confirm). A balanced two-column review, never one long summary
// card: left ~8/12 (summary + breakdown + provenance), right ~4/12 (readiness + lifecycle + create
// action). Lifecycle wording never invents "approved"/"submitted"/"paid" - only what Step 15A actually
// creates: DRAFT.
export function ConfirmCreateStep({
  preview,
  payable,
  canCreate,
  creating,
  createError,
  onCreate,
  onGoToStage,
}: {
  preview: PayableSourcePreviewDto;
  payable: PayableDetailDto | null;
  canCreate: boolean;
  creating: boolean;
  createError: string | null;
  onCreate: () => void;
  onGoToStage: (stage: CreateStage) => void;
}) {
  const currency = preview.currency ?? "INR";
  const selectedVersion = payable?.selectedVersion ?? null;
  const rows = selectedVersion
    ? breakdownRows({ lines: selectedVersion.lines, unresolved: selectedVersion.unresolved, currency, amountsVisible: preview.amountsVisible })
    : breakdownRows({ lines: preview.lines, unresolved: preview.unresolved, currency, amountsVisible: preview.amountsVisible });
  const total = selectedVersion ? selectedVersion.totalAmountMinorSigned : preview.totalAmountMinorSigned;
  const readiness = confirmReadiness(preview);
  const alreadyCreated = payable !== null;

  return (
    <div className="grid">
      <section className="panel s8">
        <div className="panelhead">
          <div>
            <h2>Payable summary</h2>
          </div>
        </div>
        <div className="panelbody">
          <div className="kv">
            <span>Counterparty</span>
            <b>{preview.counterparty.displayName ?? preview.counterparty.ref}</b>
          </div>
          <div className="kv">
            <span>Commercial period</span>
            <b>{commercialPeriodLabel(preview.commercialPeriod.periodKey)}</b>
          </div>
          <div className="kv">
            <span>Agreement / source</span>
            <b>{preview.agreementRef ? sourceRefLabel({ agreementRef: preview.agreementRef, agreementVersion: preview.agreementVersion ?? 0, reviewRef: preview.reviewRef, reviewVersion: preview.reviewVersion }) : "—"}</b>
          </div>
          <div className="kv">
            <span>Source type</span>
            <b>{sourceTypeLabel(preview.sourceType ?? "AGREEMENT_ONLY")}</b>
          </div>
          <div className="kv">
            <span>Currency</span>
            <b>{currency}</b>
          </div>
          <div className="kv">
            <span>Determination</span>
            <b>{determinationChip(preview.determinationState).label}</b>
          </div>
          <div className="kv">
            <span>Total</span>
            <b>{breakdownTotalText(total, currency, preview.amountsVisible)}</b>
          </div>

          <h3 style={{ margin: "18px 0 8px" }}>Amount breakdown</h3>
          <div className="tablewrap">
            <table className="compact">
              <thead>
                <tr>
                  <th scope="col">Component</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td>{row.component}</td>
                    <td>{row.amountText}</td>
                    <td>
                      <span className={row.status.tone === "default" ? "pill" : `pill ${row.status.tone}`}>{row.status.label}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="panel s4">
        <div className="panelhead">
          <div>
            <h2>Readiness</h2>
          </div>
        </div>
        <div className="panelbody">
          <ul className="checklist">
            {readiness.map((item) => (
              <li key={item.label}>
                <span aria-hidden="true">{item.met ? "✓" : "•"}</span>
                <span>{item.label}</span>
              </li>
            ))}
          </ul>

          <p className="foundationnote" style={{ margin: "16px 0" }}>
            {alreadyCreated ? `Payable ${payable!.head.payableRef} was created as Draft.` : DRAFT_LIFECYCLE_WORDING}
          </p>

          {!canCreate && (
            <div className="banner" role="alert" style={{ marginBottom: 14 }}>
              <b>Cannot create this Payable.</b> The source is blocked.{" "}
              <button type="button" className="btn" onClick={() => onGoToStage(1)}>
                Back to Source
              </button>
            </div>
          )}

          {createError && (
            <div className="banner" role="alert" style={{ marginBottom: 14 }}>
              {createError}
            </div>
          )}

          <button type="button" className="btn primary" style={{ width: "100%" }} disabled={!canCreate || creating} onClick={onCreate}>
            {creating ? "Creating…" : alreadyCreated ? "Open Payable" : "Create Payable"}
          </button>
        </div>
      </section>
    </div>
  );
}

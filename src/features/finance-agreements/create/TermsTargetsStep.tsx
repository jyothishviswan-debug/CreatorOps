"use client";

// EXECUTE_HARD_RESET Section 18/21: Terms & Targets. Field width follows content length (a date sits several-
// per-row; a clause/structured field always takes the full row) - the live-tested fix that resolved the
// "fluctuating card height" problem carries forward unchanged. Targets stay a separate panel from
// payment-affecting terms (Section 21).
import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import { useIntake } from "../agreement-intake-logic/intake-context";

import { FieldEditRow } from "./FieldEditRow";

const SHORT_KEYS = ["agreementNumber", "signedDate", "effectiveDate", "terminationDate", "currency", "paymentCycle", "invoiceRequired", "monthlyRequiredQualifyingContentCount", "qualifyingUnit"] as const;
const MEDIUM_KEYS = ["fixedComponent", "accountTransferFee", "advancePayment"] as const;
const LONG_KEYS = ["renewalTerms", "noticeTerms", "terminationTerms", "invoiceDueTerms", "paymentDueTerms", "contentObligations", "lfcSfc", "servicesMandated", "incentive", "monetisationTerms"] as const;

function FieldGrid({ keys, known, span }: { keys: readonly AgreementFieldKey[]; known: Set<AgreementFieldKey>; span: "s4" | "s6" | "s12" }) {
  const present = keys.filter((key) => known.has(key));
  if (present.length === 0) return null;
  return (
    <div className="grid" style={{ marginBottom: 4 }}>
      {present.map((key) => (
        <div key={key} className={span}>
          <FieldEditRow fieldKey={key} />
        </div>
      ))}
    </div>
  );
}

export function TermsTargetsStep() {
  const { hasDraft, fields } = useIntake();
  if (!hasDraft) return null;
  const known = new Set(fields.commercial_terms.map((m) => m.fieldKey));
  const shortOf = (keys: readonly AgreementFieldKey[]) => keys.filter((key) => SHORT_KEYS.includes(key as (typeof SHORT_KEYS)[number]));
  const mediumOf = (keys: readonly AgreementFieldKey[]) => keys.filter((key) => MEDIUM_KEYS.includes(key as (typeof MEDIUM_KEYS)[number]));
  const longOf = (keys: readonly AgreementFieldKey[]) => keys.filter((key) => LONG_KEYS.includes(key as (typeof LONG_KEYS)[number]));

  const ADMIN: AgreementFieldKey[] = ["agreementNumber", "signedDate", "effectiveDate", "terminationDate", "renewalTerms", "noticeTerms", "terminationTerms"];
  const CYCLE_FEE: AgreementFieldKey[] = ["currency", "paymentCycle", "invoiceRequired", "fixedComponent", "accountTransferFee", "advancePayment", "invoiceDueTerms", "paymentDueTerms"];
  const CONTENT: AgreementFieldKey[] = ["monthlyRequiredQualifyingContentCount", "qualifyingUnit", "contentObligations", "lfcSfc"];
  const OTHER: AgreementFieldKey[] = ["servicesMandated", "incentive", "monetisationTerms"];
  const targetKeys = fields.performance_targets.map((m) => m.fieldKey);

  return (
    <>
      <section className="panel">
        <div className="panelhead">
          <h2>Terms</h2>
          <p>Dates, currency/cycle/fees, content obligations, services and incentive.</p>
        </div>
        <div className="panelbody">
          <h3 style={{ marginBottom: 8 }}>Agreement administration</h3>
          <FieldGrid keys={shortOf(ADMIN)} known={known} span="s4" />
          <FieldGrid keys={longOf(ADMIN)} known={known} span="s12" />

          <h3 style={{ margin: "22px 0 8px" }}>Currency, cycle &amp; fees</h3>
          <FieldGrid keys={shortOf(CYCLE_FEE)} known={known} span="s4" />
          <FieldGrid keys={mediumOf(CYCLE_FEE)} known={known} span="s6" />
          <FieldGrid keys={longOf(CYCLE_FEE)} known={known} span="s12" />

          <h3 style={{ margin: "22px 0 8px" }}>Content obligations</h3>
          <FieldGrid keys={shortOf(CONTENT)} known={known} span="s4" />
          <FieldGrid keys={longOf(CONTENT)} known={known} span="s12" />

          <h3 style={{ margin: "22px 0 8px" }}>Services, incentive &amp; monetisation</h3>
          <FieldGrid keys={longOf(OTHER)} known={known} span="s12" />
        </div>
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panelhead">
          <h2>Performance Targets</h2>
          <p>Warning-only - kept separate from payment-affecting terms.</p>
        </div>
        <div className="panelbody">
          <div className="grid">
            {targetKeys.map((key) => (
              <div key={key} className="s12">
                <FieldEditRow fieldKey={key} />
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

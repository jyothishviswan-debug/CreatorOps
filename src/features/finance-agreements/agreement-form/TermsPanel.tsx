"use client";

// FINAL_EXECUTION Panel 4 - Agreement Terms. Section 15: dates/administration, currency/cycle/fees, content
// obligations, services mandated, incentive Yes/No, monetisation, LFC/SFC - ONE Foundation panel, compact
// subgroups. Fields render through the generic FieldRow (registry-driven, so contentObligations /
// monetisationTerms / the incentive narrative just work).
//
// Field width follows content length (Section 7): a short, single-value field (a date, a code, a count) sits
// several-per-row; a clause/structured field (extracted legal text, a repeatable table) always takes the full
// row. Mixing the two at equal width is what produced the "some cards look oversized, some have dead space"
// layout - a one-line date card and a five-line extracted-clause card were forced to the same half-width column,
// so the row's height followed the taller one and the shorter card sat in a mostly empty box beside it.
import { useIntake } from "../agreement-intake-logic/intake-context";
import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import { FieldRow } from "./FieldRow";
import { SectionCard } from "./SectionCard";

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
          <FieldRow fieldKey={key} />
        </div>
      ))}
    </div>
  );
}

export function TermsPanel() {
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

  return (
    <SectionCard title="Agreement Terms" description="Dates, currency/cycle/fees, content obligations, services and incentive - grouped compactly in one place.">
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
    </SectionCard>
  );
}

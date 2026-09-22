"use client";

// FINAL_EXECUTION Panel 4 - Agreement Terms. Section 15: dates/administration, currency/cycle/fees, content
// obligations, services mandated, incentive Yes/No, monetisation, LFC/SFC - ONE Foundation panel, compact
// subgroups. Fields render through the generic FieldRow (registry-driven, so contentObligations /
// monetisationTerms / the incentive narrative just work).
import { useIntake } from "../agreement-intake-logic/intake-context";

import { FieldRow } from "./FieldRow";
import { SectionCard } from "./SectionCard";

const DATE_KEYS = ["agreementNumber", "signedDate", "effectiveDate", "terminationDate", "renewalTerms", "noticeTerms", "terminationTerms"] as const;
const CYCLE_FEE_KEYS = ["currency", "paymentCycle", "fixedComponent", "accountTransferFee", "advancePayment", "invoiceRequired", "invoiceDueTerms", "paymentDueTerms"] as const;
const CONTENT_KEYS = ["monthlyRequiredQualifyingContentCount", "qualifyingUnit", "contentObligations", "lfcSfc"] as const;
const OTHER_KEYS = ["servicesMandated", "incentive", "monetisationTerms"] as const;

export function TermsPanel() {
  const { hasDraft, fields } = useIntake();
  if (!hasDraft) return null;
  const known = new Set(fields.commercial_terms.map((m) => m.fieldKey));

  return (
    <SectionCard title="Agreement Terms" description="Dates, currency/cycle/fees, content obligations, services and incentive - grouped compactly in one place.">
      <h3 style={{ marginBottom: 8 }}>Agreement administration</h3>
      <div className="grid">
        {DATE_KEYS.filter((k) => known.has(k)).map((key) => (
          <div key={key} className="s6">
            <FieldRow fieldKey={key} />
          </div>
        ))}
      </div>

      <h3 style={{ margin: "22px 0 8px" }}>Currency, cycle &amp; fees</h3>
      <div className="grid">
        {CYCLE_FEE_KEYS.filter((k) => known.has(k)).map((key) => (
          <div key={key} className="s6">
            <FieldRow fieldKey={key} />
          </div>
        ))}
      </div>

      <h3 style={{ margin: "22px 0 8px" }}>Content obligations</h3>
      <div className="grid">
        {CONTENT_KEYS.filter((k) => known.has(k)).map((key) => (
          <div key={key} className="s12">
            <FieldRow fieldKey={key} />
          </div>
        ))}
      </div>

      <h3 style={{ margin: "22px 0 8px" }}>Services, incentive &amp; monetisation</h3>
      <div className="grid">
        {OTHER_KEYS.filter((k) => known.has(k)).map((key) => (
          <div key={key} className="s12">
            <FieldRow fieldKey={key} />
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

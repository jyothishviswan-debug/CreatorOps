"use client";

// FINAL_BUILD_PROMPT Section 8: Terms & Targets - a balanced two-column composition (left: Commercial Terms,
// Content & Platforms, Performance Targets; right: Incentive, Term & Validity, Monetisation when present),
// dense rows for short controls, full width only for clauses/structured tables. No Tax & Compliance subsection:
// the registry has no invoicingEntity/TDS fields to back one, and Section 8 itself says "only use actual
// product/backend-supported fields."
//
// Every field here now renders as a real, pre-filled control (FieldEditRow) rather than a decision card gated
// behind a click. acceptPrefilledFields buffers every untouched-but-valued PENDING field as ACCEPTED once, on
// arrival at this step, using the same setLocalEdit/flushBuffered pipeline Save Draft and Confirm Agreement
// already use - nothing is sent to the server here; a field the person then edits is buffered as CORRECTED the
// normal way, overwriting the auto-accept.
import { useEffect, useRef } from "react";

import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import { useIntake } from "../agreement-intake-logic/intake-context";
import type { FieldViewModel } from "../field-view-model";

import { FieldEditRow } from "./FieldEditRow";

const SHORT_KEYS = ["agreementNumber", "signedDate", "effectiveDate", "terminationDate", "currency", "paymentCycle", "invoiceRequired", "monthlyRequiredQualifyingContentCount", "qualifyingUnit"] as const;

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

function useAcceptPrefilledFields(models: readonly FieldViewModel[]) {
  const { localEdits, setLocalEdit } = useIntake();
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current || models.length === 0) return;
    touched.current = true;
    for (const model of models) {
      if (model.decision === "PENDING" && model.hasValue && !model.needsMapping && localEdits[model.fieldKey] === undefined) {
        setLocalEdit(model.fieldKey, model.value, "ACCEPTED");
      }
    }
    // Runs once per model set (a fresh draft, or extraction that populated new entries); a person's own later
    // edits are never overwritten because setLocalEdit above never fires for a fieldKey already buffered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);
}

export function TermsTargetsStep() {
  const { hasDraft, fields } = useIntake();
  useAcceptPrefilledFields([...fields.commercial_terms, ...fields.performance_targets]);
  if (!hasDraft) return null;
  const known = new Set(fields.commercial_terms.map((m) => m.fieldKey));
  const shortOf = (keys: readonly AgreementFieldKey[]) => keys.filter((key) => SHORT_KEYS.includes(key as (typeof SHORT_KEYS)[number]));
  const longOf = (keys: readonly AgreementFieldKey[]) => keys.filter((key) => !SHORT_KEYS.includes(key as (typeof SHORT_KEYS)[number]));

  const COMMERCIAL: AgreementFieldKey[] = ["currency", "paymentCycle", "fixedComponent", "accountTransferFee", "invoiceRequired", "advancePayment", "invoiceDueTerms", "paymentDueTerms"];
  const CONTENT: AgreementFieldKey[] = ["monthlyRequiredQualifyingContentCount", "qualifyingUnit", "contentObligations", "lfcSfc", "servicesMandated"];
  const ADMIN: AgreementFieldKey[] = ["agreementNumber", "signedDate", "effectiveDate", "terminationDate", "renewalTerms", "noticeTerms", "terminationTerms"];
  const OTHER: AgreementFieldKey[] = ["incentive", "monetisationTerms"];
  const targetKeys = fields.performance_targets.map((m) => m.fieldKey);

  return (
    <div className="grid">
      <div className="s7">
        <section className="panel">
          <div className="panelhead">
            <h2>Commercial Terms</h2>
            <p>Payment cycle, amounts and due timing.</p>
          </div>
          <div className="panelbody">
            <FieldGrid keys={shortOf(COMMERCIAL)} known={known} span="s4" />
            <FieldGrid keys={longOf(COMMERCIAL).filter((k) => k === "fixedComponent" || k === "accountTransferFee" || k === "advancePayment")} known={known} span="s6" />
            <FieldGrid keys={longOf(COMMERCIAL).filter((k) => k === "invoiceDueTerms" || k === "paymentDueTerms")} known={known} span="s12" />
          </div>
        </section>

        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panelhead">
            <h2>Content &amp; Platforms</h2>
            <p>Qualifying content, LFC/SFC and services mandated.</p>
          </div>
          <div className="panelbody">
            <FieldGrid keys={shortOf(CONTENT)} known={known} span="s4" />
            <FieldGrid keys={longOf(CONTENT)} known={known} span="s12" />
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
      </div>

      <div className="s5">
        <section className="panel">
          <div className="panelhead">
            <h2>Incentive</h2>
          </div>
          <div className="panelbody">
            <FieldGrid keys={OTHER.filter((k) => k === "incentive")} known={known} span="s12" />
          </div>
        </section>

        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panelhead">
            <h2>Term &amp; Validity</h2>
          </div>
          <div className="panelbody">
            <FieldGrid keys={shortOf(ADMIN)} known={known} span="s6" />
            <FieldGrid keys={longOf(ADMIN)} known={known} span="s12" />
          </div>
        </section>

        {known.has("monetisationTerms") && (
          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panelhead">
              <h2>Monetisation / Revenue</h2>
            </div>
            <div className="panelbody">
              <FieldGrid keys={OTHER.filter((k) => k === "monetisationTerms")} known={known} span="s12" />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

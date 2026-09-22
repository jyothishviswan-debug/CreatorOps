"use client";

// Step 14C.3, IA section 5 "Agreement terms": dates, commercial terms, qualifying content, LFC/SFC, the Agreement's
// due-terms clauses, and additional/internal details, grouped compactly - one visible step for what were two registry
// field groups (commercial_terms, additional_details). The Agreement type is read-only, worked out by the server.
import { useMemo } from "react";

import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import { fieldsInSubsection, SUBSECTION_LABELS, unresolvedCount } from "../field-view-model";
import { agreementTypeLabel, NO_VALUE_TEXT, type ChipSpec } from "../format";
import { agreementTypeHint, commercialIssues, issuesByField, resolveField, terminationDateIssue, type FieldResolver } from "../agreement-intake-logic/editors/commercial-logic";
import { useIntake } from "../agreement-intake-logic/intake-context";

import { FieldGroupHeading, FieldRow } from "./FieldRow";
import { SectionCard } from "./SectionCard";

const HINTS: Partial<Record<AgreementFieldKey, string>> = {
  agreementNumber: "The reference printed on the Agreement, if it has one.",
  signedDate: "The date the Agreement was signed, if stated.",
  effectiveDate: "The date the terms start. Required to confirm.",
  terminationDate: "Leave it Unavailable if the Agreement has no end date.",
  currency: "Any amount in this Agreement needs a currency.",
  fixedComponent: "The fixed amount, typed in rupees and stored as an exact integer amount.",
  monthlyRequiredQualifyingContentCount: "How many pieces of qualifying content the Agreement requires each month.",
  qualifyingUnit: "Only the two supported operational values can be used. Anything else the Agreement says (Audio Visual Content, Reel, Video, …) needs mapping - it is never converted silently.",
  incentive: "Add one slab for each band the Agreement describes.",
  lfcSfc: "LFC = Long-Form Content, SFC = Short-Form Content. Record this only when the Agreement states the rule explicitly, per content format.",
  servicesMandated: "The clause text as it appears in the Agreement.",
  remarks: "Internal notes for your team.",
  onboardingProcessCompleted: "Whether onboarding for this Partner or Vendor is complete.",
};

export function AgreementTermsSection() {
  const intake = useIntake();
  const { fields, getField, localEdits, version } = intake;
  const models = fields.commercial_terms;
  const additionalModels = fieldsInSubsection(fields.additional_details, "admin").filter((model) => model.decidable);

  const resolve: FieldResolver = useMemo(() => (fieldKey) => resolveField(fieldKey, getField(fieldKey), localEdits[fieldKey]), [getField, localEdits]);
  const issues = useMemo(() => commercialIssues(resolve), [resolve]);
  const notesByField = useMemo(() => issuesByField(issues), [issues]);
  const dateOrder = terminationDateIssue(resolve);

  const dateModels = fieldsInSubsection(models, "dates");
  const commercialModels = fieldsInSubsection(models, "commercial");
  const open = unresolvedCount(models) + unresolvedCount(additionalModels);
  const chip: ChipSpec = open > 0 ? { label: `${open} to decide`, tone: "orange" } : { label: "All decided", tone: "default" };

  const confirmedType = version?.confirmed ? (version.terms?.agreementType ?? null) : null;
  const shownType = confirmedType ?? agreementTypeHint(resolve);
  const isFinal = confirmedType !== null;

  const effectiveText = (): string | null => {
    const resolved = resolve("effectiveDate");
    return resolved.state === "value" && typeof resolved.value === "string" ? resolved.value : null;
  };

  return (
    <SectionCard sectionKey="terms" title="Agreement terms" description="These terms shape the Agreement, and the payment-affecting ones apply once it is confirmed." chip={chip}>
      <FieldGroupHeading>{SUBSECTION_LABELS.dates}</FieldGroupHeading>
      {dateModels.map((model) => (
        <FieldRow
          key={model.fieldKey}
          fieldKey={model.fieldKey}
          hint={HINTS[model.fieldKey]}
          notes={model.fieldKey === "terminationDate" && dateOrder ? [dateOrder] : undefined}
          extraValidate={
            model.fieldKey === "terminationDate"
              ? (value) => {
                  const effective = effectiveText();
                  return typeof value === "string" && effective && value < effective ? "The termination date cannot precede the effective date." : null;
                }
              : undefined
          }
        />
      ))}

      <FieldGroupHeading>{SUBSECTION_LABELS.commercial}</FieldGroupHeading>
      {commercialModels.map((model) => (
        <FieldRow key={model.fieldKey} fieldKey={model.fieldKey} hint={HINTS[model.fieldKey]} notes={notesByField[model.fieldKey]} />
      ))}

      <FieldGroupHeading>Additional details</FieldGroupHeading>
      {additionalModels.map((model) => (
        <FieldRow key={model.fieldKey} fieldKey={model.fieldKey} hint={HINTS[model.fieldKey]} />
      ))}
      <div style={{ borderTop: "1px solid #edf0f3", padding: "14px 0", display: "grid", gap: 4 }}>
        <div className="field">
          <label>Agreement type</label>
          <p style={{ margin: 0, fontSize: 13 }}>{shownType ? agreementTypeLabel(shownType) : NO_VALUE_TEXT}</p>
        </div>
        <small className="muted">{isFinal ? "Set from the confirmed terms - it cannot be edited." : "Worked out from the commercial terms once you confirm. A type found in the Agreement's own text is never used."}</small>
      </div>
    </SectionCard>
  );
}

"use client";

// Step 14B intake, section 6 `Commercial terms`: the payment-affecting terms of the Agreement, plus the dates and clauses that
// frame them. Registry-driven: every field is one FieldRow (its status, what the Agreement holds and where that came from, the
// unaccepted proposal, the four decision controls and the type-specific editor). Reads everything from useIntake().
import { useMemo } from "react";

import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import { fieldsInSubsection, SUBSECTION_LABELS, unresolvedCount } from "../field-view-model";
import type { ChipSpec } from "../format";
import { commercialIssues, issuesByField, resolveField, terminationDateIssue, type FieldResolver } from "./editors/commercial-logic";
import { FieldRow } from "./editors/FieldRow";
import { useIntake } from "./intake-context";
import { SectionCard } from "./SectionCard";

const HINTS: Partial<Record<AgreementFieldKey, string>> = {
  agreementNumber: "The reference printed on the Agreement, if it has one.",
  signedDate: "The date the Agreement was signed, if stated.",
  effectiveDate: "The date the terms start. Required to confirm.",
  terminationDate: "Leave it Unavailable if the Agreement has no end date.",
  currency: "Any amount in this Agreement needs a currency.",
  fixedComponent: "The fixed amount, typed in rupees and stored as an exact integer amount.",
  monthlyRequiredQualifyingContentCount: "How many pieces of qualifying content the Agreement requires each month.",
  qualifyingUnit: "Only Approved Content or Approved current link can be used. Anything else the Agreement says is mapped by you, never automatically.",
  incentive: "Add one slab for each band the Agreement describes.",
  lfcSfc: "Record LFC / SFC only when the Agreement states the rule explicitly.",
  servicesMandated: "The clause text as it appears in the Agreement. Long text wraps.",
};

const SUBSECTION_STYLE = { display: "grid", gap: 0, marginTop: 6 } as const;
const H3_STYLE = { fontSize: 13, margin: "18px 0 2px" } as const;

export function CommercialTermsSection() {
  const intake = useIntake();
  const { fields, getField, localEdits } = intake;
  const models = fields.commercial_terms;

  const resolve: FieldResolver = useMemo(() => (fieldKey) => resolveField(fieldKey, getField(fieldKey), localEdits[fieldKey]), [getField, localEdits]);
  const issues = useMemo(() => commercialIssues(resolve), [resolve]);
  const notesByField = useMemo(() => issuesByField(issues), [issues]);
  const dateOrder = terminationDateIssue(resolve);

  const dateModels = fieldsInSubsection(models, "dates");
  const commercialModels = fieldsInSubsection(models, "commercial");
  const open = unresolvedCount(models);
  const chip: ChipSpec = open > 0 ? { label: `${open} to decide`, tone: "orange" } : { label: "All decided", tone: "default" };

  const effectiveText = (): string | null => {
    const resolved = resolve("effectiveDate");
    return resolved.state === "value" && typeof resolved.value === "string" ? resolved.value : null;
  };

  return (
    <SectionCard
      sectionKey="commercial_terms"
      description="These terms affect payment once the Agreement is confirmed. Decide every field: use a value, enter one, or mark it Not applicable or Unavailable."
      chip={chip}
    >
      <div style={SUBSECTION_STYLE}>
        <h3 style={{ ...H3_STYLE, marginTop: 0 }}>{SUBSECTION_LABELS.dates}</h3>
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

        <h3 style={H3_STYLE}>{SUBSECTION_LABELS.commercial}</h3>
        {commercialModels.map((model) => (
          <FieldRow
            key={model.fieldKey}
            fieldKey={model.fieldKey}
            hint={HINTS[model.fieldKey]}
            notes={notesByField[model.fieldKey]}
            explicitGateLabel={model.fieldKey === "lfcSfc" ? "The Agreement states LFC / SFC rules explicitly" : undefined}
          />
        ))}
      </div>
    </SectionCard>
  );
}

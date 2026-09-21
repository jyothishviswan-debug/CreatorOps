"use client";

// Step 14B intake, section 9 `Additional details`: onboarding flag and internal remarks (both decided like any field), plus the
// Agreement type - shown READ-ONLY. The type is worked out by the server from the confirmed commercial structure; an extractor's
// guess is never trusted and the person cannot set it. The value shown before confirm is a hint to review, not the final type.
import { useMemo } from "react";

import { StatusChip } from "../components/StatusChip";
import { fieldsInSubsection } from "../field-view-model";
import { agreementTypeLabel, NO_VALUE_TEXT } from "../format";
import { agreementTypeHint, resolveField, type FieldResolver } from "./editors/commercial-logic";
import { FieldRow } from "./editors/FieldRow";
import { useIntake } from "./intake-context";
import { SectionCard } from "./SectionCard";

const ROW_STYLE = { borderTop: "1px solid #edf0f3", padding: "14px 0", display: "grid", gap: 6, minWidth: 0 } as const;

export function AdditionalDetailsSection() {
  const { fields, getField, localEdits, version } = useIntake();
  const models = fieldsInSubsection(fields.additional_details, "admin");
  const decidable = models.filter((model) => model.decidable);

  const resolve: FieldResolver = useMemo(() => (fieldKey) => resolveField(fieldKey, getField(fieldKey), localEdits[fieldKey]), [getField, localEdits]);
  const confirmedType = version?.confirmed ? (version.terms?.agreementType ?? null) : null;
  const shownType = confirmedType ?? agreementTypeHint(resolve);
  const isFinal = confirmedType !== null;

  return (
    <SectionCard sectionKey="additional_details" description="Internal details kept with the Agreement.">
      {decidable.map((model) => (
        <FieldRow
          key={model.fieldKey}
          fieldKey={model.fieldKey}
          hint={model.fieldKey === "remarks" ? "Internal notes for your team." : model.fieldKey === "onboardingProcessCompleted" ? "Whether the onboarding process for this Partner or Vendor has been completed." : undefined}
        />
      ))}

      <div style={ROW_STYLE} data-testid="agreement-type">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Agreement type</span>
          <StatusChip label={isFinal ? "Set from the confirmed terms" : "Worked out by the system"} tone={isFinal ? "blue" : "gray"} />
        </div>
        <p style={{ margin: 0, fontSize: 12, overflowWrap: "anywhere" }}>{shownType ? agreementTypeLabel(shownType) : NO_VALUE_TEXT}</p>
        <small className="muted">
          {isFinal
            ? "Derived from the confirmed commercial terms. It cannot be edited."
            : "Worked out from the commercial terms when you confirm. Review it once you have decided them - you cannot set it here, and a type found in the Agreement text is never used."}
        </small>
      </div>
    </SectionCard>
  );
}

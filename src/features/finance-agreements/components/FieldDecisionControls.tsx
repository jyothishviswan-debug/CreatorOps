"use client";

// Step 14B: the per-field decision affordance - Use extracted / Enter value / Not applicable / Unavailable
// plus the field's current decision state. Pure props + callbacks: no fetching, no state of its own. The parent
// owns the value editor: "Enter value" only ASKS the parent to open it (it never sends a decision without a value).
//
// Built on the accepted `.segment` idiom (a group of toggle buttons). The decision is never conveyed by colour
// alone: the pressed button is announced with aria-pressed and the state chip carries text.
import type { AgreementFieldKey } from "@/server/finance-agreements/fields";
import { AGREEMENT_FIELD_BY_KEY } from "@/server/finance-agreements/fields";
import type { AgreementEntryDecision, AgreementFieldOrigin } from "@/server/finance-agreements/types";

import { DISABLED_BUTTON_STYLE } from "../format";

import { decisionActionsFor, decisionStateChip, type DecisionKind } from "./field-decision-logic";
import { StatusChip } from "./StatusChip";

export type FieldDecisionControlsProps = {
  fieldKey: AgreementFieldKey;
  // The human field label (used in the group's accessible name).
  label: string;
  // The current decision of the draft entry; null = no entry yet.
  decision: AgreementEntryDecision | null;
  // Where the candidate value came from (labels the "keep" action); null when there is none.
  origin: AgreementFieldOrigin | null;
  // There is a candidate value (extracted / master-data / manual) that "Use ..." can accept.
  hasValue: boolean;
  // A save for this field is in flight, or the version is read-only.
  busy?: boolean;
  disabled?: boolean;
  // ACCEPTED (keep the candidate / acknowledge), NOT_APPLICABLE and UNAVAILABLE carry no value.
  onDecide: (decision: Exclude<DecisionKind, "CORRECTED">) => void;
  // The person chose to type a value: the parent opens its editor and later sends CORRECTED with the value.
  onEnterValue: () => void;
  // Hide the state chip when the parent already shows it. Default true.
  showState?: boolean;
};

export function FieldDecisionControls({ fieldKey, label, decision, origin, hasValue, busy = false, disabled = false, onDecide, onEnterValue, showState = true }: FieldDecisionControlsProps) {
  const actions = decisionActionsFor({ fieldKey, decision, origin, hasValue });
  const field = AGREEMENT_FIELD_BY_KEY[fieldKey];
  const inert = busy || disabled;

  if (actions.length === 0) return showState ? <StatusChip chip={{ label: "Computed", tone: "gray" }} title="The system supplies this value" /> : null;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, minWidth: 0 }}>
      <div className="segment" role="group" aria-label={`Decision for ${label}`} style={{ marginLeft: 0, flexWrap: "wrap" }}>
        {actions.map((action) => (
          <button
            key={action.kind}
            type="button"
            className={action.pressed ? "active" : undefined}
            aria-pressed={action.pressed}
            disabled={inert}
            style={inert ? DISABLED_BUTTON_STYLE : undefined}
            onClick={() => {
              if (action.decision === "CORRECTED") onEnterValue();
              else onDecide(action.decision);
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
      {showState && <StatusChip chip={decisionStateChip(decision, { explicitDecisionRequired: field.explicitDecisionRequired })} status={decision ?? "NONE"} />}
    </div>
  );
}

// Step 14B: the shared presentational components of the Finance Agreements UI. One import path for the
// workspace, intake and detail screens.
export { ChipList } from "./ChipList";
export { Combobox, type ComboboxOption, type ComboboxProps, type ComboboxSearchResult } from "./Combobox";
export { ConfidenceBadge } from "./ConfidenceBadge";
export { FieldDecisionControls, type FieldDecisionControlsProps } from "./FieldDecisionControls";
export { KeyValueRow } from "./KeyValueRow";
export { MaskedValue } from "./MaskedValue";
export { SourceBadge } from "./SourceBadge";
export { StatusChip } from "./StatusChip";
export { decisionActionsFor, decisionStateChip, keepValueLabel, type DecisionAction, type DecisionActionKind, type DecisionKind } from "./field-decision-logic";
export { comboboxKeyAction, comboboxStatusText, createRequestGate, shouldSearch, stepActiveIndex } from "./combobox-logic";

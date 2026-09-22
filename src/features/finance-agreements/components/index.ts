// Step 14B / 14C.3: the shared presentational components of the Finance Agreements UI. One import path for the
// workspace, Agreement form and detail screens. ConfidenceBadge and FieldDecisionControls were removed in the
// 14C.3 hard reset (a Confidence badge and a multi-button decision segment were rejected UI patterns) - the pure
// decisionActionsFor/decisionStateChip rules they used stay, since field-view-model.ts still needs them.
export { ChipList } from "./ChipList";
export { Combobox, type ComboboxOption, type ComboboxProps, type ComboboxSearchResult } from "./Combobox";
export { KeyValueRow } from "./KeyValueRow";
export { MaskedValue } from "./MaskedValue";
export { SourceBadge } from "./SourceBadge";
export { StatusChip } from "./StatusChip";
export { decisionActionsFor, decisionStateChip, keepValueLabel, type DecisionAction, type DecisionActionKind, type DecisionKind } from "./field-decision-logic";
export { comboboxKeyAction, comboboxStatusText, createRequestGate, shouldSearch, stepActiveIndex } from "./combobox-logic";

// Step 14B: the pure view-model layer of the Finance Agreements UI - ONE import path for the workspace, the intake form and the
// detail page. Everything exported here is framework-free and unit-tested.
//   (a) agreement-for            the four `Agreement for` choices -> counterparty + platform scope; Partner Account selection rules
//   (b) field-view-model         AgreementVersionDto draft + registry -> per-field view models grouped by intake section; extraction rows
//   (c) cross-verification       reconciliation DTO -> cross-verification rows + the actions allowed on each
//   (d) qualifying-unit          supported qualifying units only; unsupported wording -> "Needs mapping"
//   (e) terms-validators         client-side validators mirroring checkFieldDecisionValue / terms.ts
//   (f) confirm-blockers         confirm `not_ready` blockers -> human messages with jump targets
//   (g) revision-diff            changed-field diff between two confirmed term sets / a revision draft and its prior version
export * from "./agreement-for";
export * from "./confirm-blockers";
export * from "./cross-verification";
export * from "./field-values";
export * from "./field-view-model";
export * from "./qualifying-unit";
export * from "./revision-diff";
export * from "./terms-validators";

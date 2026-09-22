import { AGREEMENT_FIELD_BY_KEY, checkFieldDecisionValue, type AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { FieldReconciliationDto, ReconciliationAction, ReconciliationState } from "@/server/finance-agreements/reconciliation-compare";
import type { AgreementReconciliationDto } from "@/server/finance-agreements/reconciliation-service";
import type { KycComponent, MasterDataMode } from "@/server/finance-agreements/master-data-commands";
import type { AgreementEntryDecision } from "@/server/finance-agreements/types";

import { MASTER_DATA_SOURCE_NOTE, NOT_AVAILABLE_IN_CREATOROPS, NO_VALUE_TEXT, RESTRICTED_VALUE_TEXT, fieldLabel, reconciliationChip, reconciliationReasonLabel, type ChipSpec } from "./format";
import { formatFieldValue } from "./field-values";
import { isIdentityField, maskIdentityValue } from "./identity-mask";

// Step 14B: the reconciliation DTO -> cross-verification rows and the actions a person may take on each (pure).
//
//   CreatorOps value | Agreement value | Status | Your decision
//
// The server decides WHICH actions are allowed (`allowedActions` - it knows the version's state and the actor's rights
// in the owning module); this module maps them onto the UI's wording and onto the concrete request each one sends:
//   an AGREEMENT-side action  -> decideField (ACCEPTED / CORRECTED). Saving the Agreement never writes master data.
//   a MASTER-DATA action      -> a separate, explicitly confirmed command (contact: POST .../master-data, identity:
//                                POST .../kyc). It is offered only when the server lists it, and only as its own button.
export type CrossVerificationActionKind = "CONFIRM" | "USE_AGREEMENT_VALUE" | "USE_CREATOROPS_VALUE" | "KEEP_CREATOROPS_VALUE" | "ENTER_VALUE" | "UPDATE_MASTER_DATA" | "OVERWRITE_MASTER_DATA";

export type MasterDataActionTarget = { via: "contact"; fieldKey: "emailAddress" | "contactNumber" } | { via: "kyc"; component: Exclude<KycComponent, "bank"> };

export type CrossVerificationAction = {
  kind: CrossVerificationActionKind;
  label: string;
  // Agreement-side actions: the decision to send through decideField. null for master-data actions.
  decision: "ACCEPTED" | "CORRECTED" | null;
  // Where the decision's value comes from: nowhere (ACCEPTED keeps the entry's value / acknowledges an identity field),
  // the CreatorOps value (`value` is set, already validated), or the person (the UI collects it, then validates it).
  valueSource: "none" | "canonical" | "typed";
  value?: unknown;
  // Master-data actions only.
  masterData: { target: MasterDataActionTarget; mode: MasterDataMode; requiresReason: boolean } | null;
  // Master-data updates are ALWAYS behind an explicit confirmation dialog.
  requiresDialog: boolean;
  primary: boolean;
  // This action is what the Agreement currently reflects (the person can still change it while the version is open).
  selected: boolean;
  help?: string;
};

export type CrossVerificationRow = {
  fieldKey: AgreementFieldKey;
  label: string;
  state: ReconciliationState;
  stateChip: ChipSpec;
  reasonText: string | null;
  restricted: boolean;
  // Mismatch is subtly highlighted (never by colour alone - the status text says "Mismatch").
  highlight: boolean;
  creatorOpsText: string;
  // "CreatorOps master data" / "Not available in CreatorOps" / null
  creatorOpsNote: string | null;
  agreementText: string;
  // "Agreement · page 3 · Confidence: High" (extracted) / "Manual" ... / null
  agreementNote: string | null;
  confirmedText: string | null;
  agreementDecision: AgreementEntryDecision | null;
  // The person already accepted / corrected the Agreement's value for this field.
  confirmed: boolean;
  // The value the Agreement will carry comes from CreatorOps master data (labelled, never called "extracted").
  sourceNote: string | null;
  actions: CrossVerificationAction[];
  // Awaiting a deliberate resolution (a difference or a one-sided value with no decision yet).
  needsResolution: boolean;
};

// The field -> master-data command mapping. Only these fields can update the owning Partner / Vendor record; bank details
// cannot be applied from a contract at all.
export const MASTER_DATA_TARGETS: Partial<Record<AgreementFieldKey, MasterDataActionTarget>> = {
  emailAddress: { via: "contact", fieldKey: "emailAddress" },
  contactNumber: { via: "contact", fieldKey: "contactNumber" },
  panNumber: { via: "kyc", component: "pan" },
  aadhaarNumber: { via: "kyc", component: "aadhaar" },
  gstin: { via: "kyc", component: "gst" },
};

export const UPDATE_MASTER_DATA_LABEL = "Update Partner/Vendor";
export const OVERWRITE_MASTER_DATA_LABEL = "Update Partner/Vendor after confirmation";
export const SAVING_NEVER_UPDATES_NOTE = "Saving the Agreement never changes the Partner/Vendor record.";

const isPositive = (decision: AgreementEntryDecision | null): boolean => decision === "ACCEPTED" || decision === "CORRECTED";

function maskedCanonical(field: FieldReconciliationDto): string | null {
  const masked = maskIdentityValue(field.fieldKey, field.canonicalValue);
  return masked === NO_VALUE_TEXT ? null : masked;
}

function joinValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const text = Array.isArray(value) ? value.filter((item) => item.length > 0).join(", ") : value;
  return text.length > 0 ? text : null;
}

// The CreatorOps value as a value a decision may carry: a single string, or an array for array-valued fields; and only when the
// server's own check accepts it (a Partner in two states has no single "state" to keep - then only "Enter corrected value" applies).
export function canonicalDecisionValue(fieldKey: AgreementFieldKey, canonicalValue: string | string[] | undefined): unknown | null {
  if (canonicalValue === undefined) return null;
  // The reconciliation DTO collapses a one-element list to a plain string, so an array-valued field (platforms) with ONE platform arrives
  // as "instagram": try the plain value, then the one-element list (the server's own check decides which shape the field accepts).
  const candidates: unknown[] = Array.isArray(canonicalValue) ? [canonicalValue, ...(canonicalValue.length === 1 ? [canonicalValue[0]] : [])] : [canonicalValue, [canonicalValue]];
  for (const candidate of candidates) {
    const check = checkFieldDecisionValue(fieldKey, "CORRECTED", candidate);
    if (check.ok && check.value !== undefined && check.value !== null) return check.value;
  }
  return null;
}

function agreementValueText(field: FieldReconciliationDto, canonicalText: string | null): string {
  if (field.agreementDecision === "NOT_APPLICABLE") return "Not applicable";
  if (field.agreementDecision === "UNAVAILABLE") return "Unavailable";
  const value = field.confirmedValue ?? field.extractedValue;
  // An identity value is shown masked for EVERY actor who may compare it (last four characters); a restricted row never gets here.
  if (value !== undefined && value !== null) return isIdentityField(field.fieldKey) ? maskIdentityValue(field.fieldKey, value) : formatFieldValue(field.fieldKey, value);
  if (field.state === "MATCH" && canonicalText) return canonicalText;
  return NO_VALUE_TEXT;
}

function confirmedValueText(field: FieldReconciliationDto): string | null {
  const identity = AGREEMENT_FIELD_BY_KEY[field.fieldKey].identityValue;
  if (field.agreementDecision === "ACCEPTED" || field.agreementDecision === "CORRECTED") {
    if (identity) return "Acknowledged";
    return field.confirmedValue !== undefined && field.confirmedValue !== null ? formatFieldValue(field.fieldKey, field.confirmedValue) : null;
  }
  if (field.agreementDecision === "UNAVAILABLE") return "Unavailable";
  if (field.agreementDecision === "NOT_APPLICABLE") return "Not applicable";
  return null;
}

function agreementNoteOf(field: FieldReconciliationDto): string | null {
  const source = field.source.agreement;
  // A value the PERSON decided (kept from CreatorOps, or typed) is not "extracted": say whose decision it is, and - when the Agreement
  // itself said something else - what it said.
  if (field.agreementDecision === "CORRECTED" && !AGREEMENT_FIELD_BY_KEY[field.fieldKey].identityValue) {
    const parts = [matchesCanonical(field) ? "Kept CreatorOps value" : "Entered by you", "your decision"];
    const said = field.extractedValue;
    if (said !== undefined && said !== null && !sameValue(said, field.confirmedValue)) parts.push(`The Agreement said: ${formatFieldValue(field.fieldKey, said)}`);
    return parts.join(" · ");
  }
  if (!source) return null;
  const parts = [source.origin === "MASTER_DATA" ? "CreatorOps master data" : source.origin === "MANUAL" ? "Manual" : "Agreement"];
  if (source.page) parts.push(`page ${source.page}`);
  // HIGH is the ordinary case for a proposed value and says nothing worth a caption; only a lower confidence earns one.
  if (source.origin === "EXTRACTED" && source.confidence && source.confidence !== "HIGH") parts.push(`Confidence: ${source.confidence.charAt(0)}${source.confidence.slice(1).toLowerCase()}`);
  return parts.join(" · ");
}

type ActionContext = { field: FieldReconciliationDto; canResolve: boolean; allowed: ReadonlySet<ReconciliationAction> };

const action = (base: Omit<CrossVerificationAction, "requiresDialog" | "help" | "masterData" | "value"> & Partial<Pick<CrossVerificationAction, "value" | "masterData" | "help" | "requiresDialog">>): CrossVerificationAction => ({
  masterData: null,
  requiresDialog: false,
  ...base,
});

function masterDataAction(field: FieldReconciliationDto, mode: MasterDataMode): CrossVerificationAction | null {
  const target = MASTER_DATA_TARGETS[field.fieldKey];
  if (!target) return null;
  return action({
    kind: mode === "FILL_MISSING" ? "UPDATE_MASTER_DATA" : "OVERWRITE_MASTER_DATA",
    label: mode === "FILL_MISSING" ? UPDATE_MASTER_DATA_LABEL : OVERWRITE_MASTER_DATA_LABEL,
    decision: null,
    valueSource: "none",
    masterData: { target, mode, requiresReason: mode === "OVERWRITE_MISMATCH" },
    requiresDialog: true,
    primary: false,
    selected: false,
    help: SAVING_NEVER_UPDATES_NOTE,
  });
}

function actionsFor({ field, canResolve, allowed }: ActionContext): CrossVerificationAction[] {
  const identity = AGREEMENT_FIELD_BY_KEY[field.fieldKey].identityValue;
  const positive = isPositive(field.agreementDecision ?? null);
  const canonicalValue = identity ? null : canonicalDecisionValue(field.fieldKey, field.canonicalValue);
  const hasAgreementValue = (field.extractedValue !== undefined && field.extractedValue !== null) || (field.confirmedValue !== undefined && field.confirmedValue !== null);
  const out: CrossVerificationAction[] = [];
  const enterValue = (): CrossVerificationAction =>
    action({ kind: "ENTER_VALUE", label: "Enter corrected value", decision: "CORRECTED", valueSource: "typed", primary: false, selected: field.agreementDecision === "CORRECTED" && !matchesCanonical(field) });

  switch (field.state) {
    case "MATCH":
      if (canResolve && !positive) out.push(action({ kind: "CONFIRM", label: "Confirm", decision: "ACCEPTED", valueSource: "none", primary: true, selected: false }));
      // A row becomes a Match once "Keep CreatorOps value" (or a typed value equal to it) was chosen: the person must still be able to change
      // their mind, so a decided, non-identity Match keeps the typed-value action (a mis-click is never irreversible before confirming).
      else if (canResolve && !identity) out.push(enterValue());
      break;

    case "MISSING_IN_CREATOROPS": {
      if (canResolve) out.push(action({ kind: "USE_AGREEMENT_VALUE", label: "Use Agreement value", decision: "ACCEPTED", valueSource: "none", primary: !positive, selected: positive }));
      if (allowed.has("UPDATE_MASTER_DATA_FROM_AGREEMENT")) {
        const update = masterDataAction(field, "FILL_MISSING");
        if (update) out.push(update);
      }
      break;
    }

    case "MISSING_IN_AGREEMENT":
      if (canResolve) {
        if (identity) out.push(action({ kind: "USE_CREATOROPS_VALUE", label: "Use CreatorOps value", decision: "ACCEPTED", valueSource: "none", primary: !positive, selected: positive }));
        else if (canonicalValue !== null) out.push(action({ kind: "USE_CREATOROPS_VALUE", label: "Use CreatorOps value", decision: "ACCEPTED", valueSource: "canonical", value: canonicalValue, primary: !positive, selected: positive, help: MASTER_DATA_SOURCE_NOTE }));
        if (!identity) out.push(enterValue());
      }
      break;

    case "MISMATCH": {
      if (allowed.has("KEEP_CREATOROPS_VALUE")) {
        if (identity) out.push(action({ kind: "KEEP_CREATOROPS_VALUE", label: "Keep CreatorOps value", decision: "ACCEPTED", valueSource: "none", primary: false, selected: false }));
        else if (canonicalValue !== null) out.push(action({ kind: "KEEP_CREATOROPS_VALUE", label: "Keep CreatorOps value", decision: "CORRECTED", valueSource: "canonical", value: canonicalValue, primary: false, selected: field.agreementDecision === "CORRECTED" && matchesCanonical(field) }));
      }
      if (allowed.has("USE_AGREEMENT_VALUE_IN_AGREEMENT_ONLY")) out.push(action({ kind: "USE_AGREEMENT_VALUE", label: "Use Agreement value", decision: "ACCEPTED", valueSource: "none", primary: false, selected: field.agreementDecision === "ACCEPTED" }));
      if (canResolve && !identity) out.push(enterValue());
      if (allowed.has("OVERWRITE_MASTER_DATA_WITH_AGREEMENT_VALUE")) {
        const overwrite = masterDataAction(field, "OVERWRITE_MISMATCH");
        if (overwrite) out.push(overwrite);
      }
      break;
    }

    case "UNAVAILABLE":
      // No canonical home (address, PIN): the Agreement still keeps its own confirmed value.
      if (field.reason === "no_canonical_field" && canResolve) {
        if (hasAgreementValue) out.push(action({ kind: "USE_AGREEMENT_VALUE", label: "Use Agreement value", decision: "ACCEPTED", valueSource: "none", primary: !positive, selected: positive }));
        if (!identity) out.push(enterValue());
      }
      break;

    default:
      break;
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// The decided value equals the CreatorOps value (so "Keep CreatorOps value" is the selected resolution, not a typed one).
function matchesCanonical(field: FieldReconciliationDto): boolean {
  if (field.confirmedValue === undefined || field.canonicalValue === undefined) return false;
  const confirmed = Array.isArray(field.confirmedValue) ? field.confirmedValue.map(String).join("|") : String(field.confirmedValue);
  const canonical = Array.isArray(field.canonicalValue) ? field.canonicalValue.join("|") : field.canonicalValue;
  return confirmed === canonical;
}

export type BuildCrossVerificationOptions = {
  // manage_agreements (from the server-computed permissions object).
  canManage: boolean;
};

export function buildCrossVerificationRows(reconciliation: Pick<AgreementReconciliationDto, "fields" | "versionConfirmed" | "versionStatus">, options: BuildCrossVerificationOptions): CrossVerificationRow[] {
  const versionOpen = !reconciliation.versionConfirmed && reconciliation.versionStatus === "DRAFT";
  const canResolve = options.canManage && versionOpen;

  return reconciliation.fields.map((field) => {
    const restricted = field.state === "RESTRICTED";
    // The CreatorOps identity value (PAN, Aadhaar, GSTIN, bank account, IFSC) is compared server-side but only ever PRINTED masked.
    const canonicalText = restricted ? null : isIdentityField(field.fieldKey) ? maskedCanonical(field) : joinValue(field.canonicalValue);
    const decision = field.agreementDecision ?? null;
    const confirmed = isPositive(decision) || decision === "UNAVAILABLE" || decision === "NOT_APPLICABLE";

    const creatorOpsText = restricted ? RESTRICTED_VALUE_TEXT : (canonicalText ?? (field.state === "UNAVAILABLE" && field.reason === "no_canonical_field" ? NOT_AVAILABLE_IN_CREATOROPS : NO_VALUE_TEXT));
    const creatorOpsNote = restricted ? null : field.state === "UNAVAILABLE" && field.reason === "no_canonical_field" ? null : canonicalText ? (field.source.canonical ?? "CreatorOps master data") : null;

    const actions = restricted ? [] : actionsFor({ field, canResolve, allowed: new Set(field.allowedActions) });
    const usesCreatorOpsValue = actions.some((item) => item.kind === "USE_CREATOROPS_VALUE");

    return {
      fieldKey: field.fieldKey,
      label: fieldLabel(field.fieldKey),
      state: field.state,
      stateChip: reconciliationChip(field.state),
      reasonText: reconciliationReasonLabel(field.reason),
      restricted,
      highlight: field.state === "MISMATCH",
      creatorOpsText,
      creatorOpsNote,
      agreementText: restricted ? RESTRICTED_VALUE_TEXT : agreementValueText(field, canonicalText),
      agreementNote: restricted ? null : agreementNoteOf(field),
      confirmedText: restricted ? null : confirmedValueText(field),
      agreementDecision: decision,
      confirmed,
      // A CreatorOps-sourced value is labelled as such - never "extracted".
      sourceNote: field.state === "MISSING_IN_AGREEMENT" && usesCreatorOpsValue ? MASTER_DATA_SOURCE_NOTE : null,
      actions,
      needsResolution: !confirmed && (field.state === "MISMATCH" || field.state === "MISSING_IN_CREATOROPS" || field.state === "MISSING_IN_AGREEMENT" || (field.state === "UNAVAILABLE" && field.reason === "no_canonical_field" && actions.length > 0)),
    } satisfies CrossVerificationRow;
  });
}

// The summary counts the panel header shows (an actionable subset of the DTO's own summary).
export function crossVerificationNeedsResolution(rows: readonly CrossVerificationRow[]): number {
  return rows.filter((row) => row.needsResolution).length;
}

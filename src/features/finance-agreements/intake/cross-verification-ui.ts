import { AGREEMENT_FIELD_BY_KEY, type AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { CounterpartyType } from "@/server/finance-agreements/types";

import type { ApplyKycInput, UpdateMasterDataInput } from "../api-client";
import { OVERWRITE_MASTER_DATA_LABEL, SAVING_NEVER_UPDATES_NOTE, UPDATE_MASTER_DATA_LABEL, type CrossVerificationAction, type CrossVerificationRow } from "../cross-verification";
import { editorKindFor } from "../field-view-model";
import { counterpartyTypeLabel, KYC_COMPONENT_LABELS } from "../format";
import type { ValidationResult } from "../terms-validators";
import { editorStateToValue } from "./editors/editor-state";

// Step 14B intake (Cross-verification): the display-only rules of the section (pure) - grouping, the summary line, the corrected-value
// check and the wording / request of the two explicit master-data commands.

// --- Grouping & summary -------------------------------------------------------------------------------------------------------------------
export type CrossVerificationGroupKey = "contact" | "platform" | "identity";
export type CrossVerificationGroup = { key: CrossVerificationGroupKey; title: string; description: string; rows: CrossVerificationRow[] };

const GROUP_META: Record<CrossVerificationGroupKey, { title: string; description: string }> = {
  contact: { title: "Contact details", description: "Name, phone, email, state, address and PIN code." },
  platform: { title: "Platform & page", description: "Platforms and the collaborator page, compared with the Partner Accounts in CreatorOps." },
  identity: { title: "Restricted identity", description: "Compared only when you have access to restricted details; without it every row here reads Restricted and no value is shown. A value is never copied into the Agreement - you only acknowledge it." },
};

export function crossVerificationGroupOf(fieldKey: AgreementFieldKey): CrossVerificationGroupKey {
  if (AGREEMENT_FIELD_BY_KEY[fieldKey].identityValue) return "identity";
  return AGREEMENT_FIELD_BY_KEY[fieldKey].group === "partner_platform" ? "platform" : "contact";
}

// Rows grouped in display order (contact, platform, identity); an empty group is dropped; row order inside a group is the server's.
export function groupCrossVerificationRows(rows: readonly CrossVerificationRow[]): CrossVerificationGroup[] {
  const order: CrossVerificationGroupKey[] = ["contact", "platform", "identity"];
  return order
    .map((key) => ({ key, ...GROUP_META[key], rows: rows.filter((row) => crossVerificationGroupOf(row.fieldKey) === key) }))
    .filter((group) => group.rows.length > 0);
}

export type CrossVerificationSummary = { total: number; needsResolution: number; mismatches: number; restricted: number; pendingRows: CrossVerificationRow[] };

export function summarizeCrossVerification(rows: readonly CrossVerificationRow[]): CrossVerificationSummary {
  const pendingRows = rows.filter((row) => row.needsResolution);
  return {
    total: rows.length,
    needsResolution: pendingRows.length,
    mismatches: rows.filter((row) => row.state === "MISMATCH").length,
    restricted: rows.filter((row) => row.restricted).length,
    pendingRows,
  };
}

export function summaryText(summary: CrossVerificationSummary): string {
  if (summary.total === 0) return "Nothing to compare yet.";
  if (summary.needsResolution === 0) return "Every comparable field is resolved or needs no action.";
  return `${summary.needsResolution} of ${summary.total} ${summary.total === 1 ? "field needs" : "fields need"} your decision.`;
}

// The visible label of the unresolved-row jump link.
export const jumpLabel = (row: Pick<CrossVerificationRow, "label" | "stateChip">): string => `${row.label} - ${row.stateChip.label}`;

// --- Enter corrected value ----------------------------------------------------------------------------------------------------------------
// The typed value of a corrected cross-verification field, checked by the same validators the server applies. The field kinds here are
// plain text or the platform list (never a structured value).
export function validateCorrectedText(fieldKey: AgreementFieldKey, text: string): ValidationResult<unknown> {
  const kind = editorKindFor(fieldKey);
  if (kind === "platforms") return editorStateToValue(fieldKey, kind, { kind: "platforms", text });
  return editorStateToValue(fieldKey, kind === "acknowledge" || kind === "computed" ? "text" : kind, { kind: "text", text });
}

// The text an "Enter corrected value" box opens with: the value the Agreement currently carries (never the CreatorOps value).
export function correctedValueSeed(row: Pick<CrossVerificationRow, "agreementText" | "confirmedText" | "restricted">): string {
  if (row.restricted) return "";
  const text = row.confirmedText ?? row.agreementText;
  return text === "—" || text === "Not applicable" || text === "Unavailable" || text === "Acknowledged" ? "" : text;
}

// --- Master-data commands (explicit, confirmed, never triggered by saving) ------------------------------------------------------------------
export type MasterDataDialogCopy = {
  title: string;
  lead: string;
  // What will and will not change.
  points: string[];
  confirmLabel: string;
  requiresReason: boolean;
  reasonLabel: string | null;
};

export function describeMasterDataAction(row: Pick<CrossVerificationRow, "label" | "fieldKey">, action: Pick<CrossVerificationAction, "masterData">, counterpartyType: CounterpartyType): MasterDataDialogCopy | null {
  const command = action.masterData;
  if (!command) return null;
  const noun = counterpartyTypeLabel(counterpartyType);
  const overwrite = command.mode === "OVERWRITE_MISMATCH";
  const what = command.target.via === "kyc" ? `the ${KYC_COMPONENT_LABELS[command.target.component]} in the ${noun} KYC record` : `the ${row.label.toLowerCase()} on the ${noun} record`;
  return {
    title: overwrite ? OVERWRITE_MASTER_DATA_LABEL.replace("Partner/Vendor", noun) : UPDATE_MASTER_DATA_LABEL.replace("Partner/Vendor", noun),
    lead: overwrite ? `This replaces ${what} with the value from the Agreement.` : `This fills ${what}, which is empty in CreatorOps, with the value from the Agreement.`,
    points: [
      overwrite ? "The existing CreatorOps value is replaced. Other Agreements and screens will see the new value." : "Only an empty value is filled. Nothing already recorded is replaced.",
      "The change is made through the owning module, which applies its own access rules.",
      SAVING_NEVER_UPDATES_NOTE,
    ],
    confirmLabel: overwrite ? `Replace ${command.target.via === "kyc" ? "KYC value" : row.label.toLowerCase()}` : `Update ${noun}`,
    requiresReason: command.requiresReason,
    reasonLabel: command.requiresReason ? "Why is the CreatorOps value being replaced?" : null,
  };
}

export const REASON_MIN = 3;
export const REASON_MAX = 1000;

// The acknowledged reason a replacement needs (3-1000 characters after trimming).
export function validateReason(text: string): ValidationResult<string> {
  const reason = text.trim();
  if (reason.length < REASON_MIN) return { ok: false, errors: [`Enter a reason (at least ${REASON_MIN} characters).`] };
  if (reason.length > REASON_MAX) return { ok: false, errors: [`The reason can be at most ${REASON_MAX.toLocaleString("en-IN")} characters.`] };
  return { ok: true, value: reason };
}

export type MasterDataRequest = { via: "contact"; input: Omit<UpdateMasterDataInput, "version" | "expectedDocVersion"> } | { via: "kyc"; input: Omit<ApplyKycInput, "version"> };

// The exact request a confirmed master-data action sends. `reason` is required (and the acknowledgement recorded) only for OVERWRITE_MISMATCH.
export function buildMasterDataRequest(action: Pick<CrossVerificationAction, "masterData">, input: { reason: string | null; expectedCounterpartyVersion: number | null }): { ok: true; request: MasterDataRequest } | { ok: false; message: string } {
  const command = action.masterData;
  if (!command) return { ok: false, message: "This action does not change the Partner or Vendor record." };
  let resolution: { acknowledged: true; reason: string } | undefined;
  if (command.requiresReason) {
    const checked = validateReason(input.reason ?? "");
    if (!checked.ok) return { ok: false, message: checked.errors[0]! };
    resolution = { acknowledged: true, reason: checked.value };
  }
  if (command.target.via === "kyc") {
    return { ok: true, request: { via: "kyc", input: { components: [command.target.component], mode: command.mode, ...(resolution ? { resolution } : {}) } } };
  }
  if (input.expectedCounterpartyVersion === null || !Number.isInteger(input.expectedCounterpartyVersion) || input.expectedCounterpartyVersion < 1) {
    return { ok: false, message: "The current Partner or Vendor record could not be read, so it cannot be updated safely. Try again." };
  }
  return { ok: true, request: { via: "contact", input: { fieldKey: command.target.fieldKey, mode: command.mode, expectedCounterpartyVersion: input.expectedCounterpartyVersion, ...(resolution ? { resolution } : {}) } } };
}

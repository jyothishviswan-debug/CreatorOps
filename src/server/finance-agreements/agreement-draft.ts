import { isDeepStrictEqual } from "node:util";

import { AGREEMENT_FIELD_BY_KEY, AGREEMENT_FIELD_VALUE_SCHEMAS, AGREEMENT_FIELDS, type AgreementFieldDef, type AgreementFieldKey } from "./fields";
import type { AuthorizedCounterparty } from "./finance-agreements-gate";
import type { AgreementDraft, AgreementDraftEntry, AgreementEntryDecision, AgreementFieldOrigin, AgreementFieldProvenanceEntry, AgreementVersionDoc, CounterpartyType, ExtractionRunDoc } from "./types";
import type { AgreementFieldDecisionKind } from "./fields";

// Step 14A: PURE helpers that build and change an Agreement version's draft working copy.
// No Firestore, no clock, no identity value: every function takes what it needs and returns a
// new draft, so the services stay thin and each rule here is unit-testable on its own.

export const MASTER_DATA_LABEL = "CreatorOps master data";
export const MANUAL_ENTRY_LABEL = "Entered in CreatorOps";
export const CORRECTED_LABEL = "Corrected in CreatorOps";
export const IDENTITY_ACK_LABEL = "Extracted from contract (value not stored on the Agreement)";

const provenance = (label: string, extras: Partial<AgreementFieldProvenanceEntry> = {}): AgreementFieldProvenanceEntry => ({ label, extractionRunRef: null, page: null, confidence: null, ...extras });

function entry(value: unknown, origin: AgreementFieldOrigin, decision: AgreementEntryDecision, prov: AgreementFieldProvenanceEntry, extra: Partial<AgreementDraftEntry> = {}): AgreementDraftEntry {
  return { value: (value ?? null) as AgreementDraftEntry["value"], origin, decision, extractedValue: null, decidedByUserRef: null, decidedAt: null, provenance: prov, ...extra };
}

// The value, validated/normalized against the field's own schema, or undefined when it does not fit.
function validValue(key: AgreementFieldKey, value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  const parsed = AGREEMENT_FIELD_VALUE_SCHEMAS[key].safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// --- Master-data prefill ---------------------------------------------------------------------------------------------------
// The draft working copy of a NEW Agreement version 1: what CreatorOps already knows about the
// counterparty, origin MASTER_DATA, decision PENDING (a human still has to accept each value),
// provenance "CreatorOps master data". NEVER an identity value - the restricted store is not
// read here and identity fields are not prefilled at all. A value that does not fit its field
// schema is simply not prefilled.
export function buildMasterDataDraft(authorized: AuthorizedCounterparty): AgreementDraft {
  const draft: AgreementDraft = {};
  const put = (key: AgreementFieldKey, value: unknown) => {
    const valid = validValue(key, value);
    if (valid !== undefined) draft[key] = entry(valid, "MASTER_DATA", "PENDING", provenance(MASTER_DATA_LABEL));
  };

  const master = authorized.type === "PARTNER" ? authorized.partner : authorized.vendor;
  put("counterpartyName", master.legalName ?? master.displayName);
  put("contactNumber", master.phone);
  put("emailAddress", master.email);
  // Only an unambiguous single region names a state; several regions are never guessed between.
  if (master.regionIds.length === 1) put("state", master.regionIds[0]);

  if (authorized.type === "PARTNER") {
    if (authorized.counterparty.platformScope.length > 0) put("platforms", authorized.counterparty.platformScope);
    // Canonical Partner Account data is preferred for the collaborator page - but only when the
    // Agreement names exactly one account (with several, which page is meant is not guessable).
    if (authorized.accounts.length === 1) {
      const account = authorized.accounts[0]!;
      put("collaboratorPageLink", account.profileUrl);
      put("collaboratorPageName", account.displayName ?? account.handle);
    }
  }
  return draft;
}

// --- Reading a confirmed version back as field values ---------------------------------------------------------------
function getPath(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// The frozen value of one DECIDED, non-identity field of a confirmed version (undefined when the
// version is unconfirmed or the field has no home in the terms / contact snapshot).
export function readConfirmedFieldValue(version: Pick<AgreementVersionDoc, "terms" | "contactSnapshot">, field: AgreementFieldDef): unknown {
  if (!field.path || field.identityValue) return undefined;
  if (field.target === "terms") return version.terms ? getPath(version.terms, field.path) : undefined;
  if (field.target === "contactSnapshot") return version.contactSnapshot ? getPath(version.contactSnapshot, field.path) : undefined;
  return undefined;
}

// --- Revision prefill ----------------------------------------------------------------------------------------------------
// The draft of a REVISION: every decided, applicable field of the previous confirmed version is
// carried over (origin MANUAL, provenance "previous version n"), with the decision the field had
// there (a corrected value carries as ACCEPTED - the correction happened in that version) and the
// original decider/time. Values come only from the frozen terms / contact snapshot - the
// counterparty's CURRENT master data is deliberately not consulted, so a revision never drifts
// with a later Partner / Vendor edit. A field whose value was never confirmed is not carried.
export function draftFromConfirmedVersion(base: AgreementVersionDoc): AgreementDraft {
  const draft: AgreementDraft = {};
  const prov = base.fieldProvenance ?? {};
  const label = `previous version ${base.version}`;
  for (const field of AGREEMENT_FIELDS) {
    if (field.mode !== "DECIDED" || !field.appliesTo.includes(base.counterparty.type)) continue;
    const frozen = prov[field.key];
    if (!frozen) continue;
    const carried = provenance(label);
    const decided = { decidedByUserRef: frozen.decidedByUserRef, decidedAt: frozen.decidedAt };

    if (field.identityValue || frozen.decision === "UNAVAILABLE" || frozen.decision === "NOT_APPLICABLE") {
      draft[field.key] = entry(null, "MANUAL", frozen.decision === "CORRECTED" ? "ACCEPTED" : frozen.decision, carried, decided);
      continue;
    }
    const value = validValue(field.key, readConfirmedFieldValue(base, field));
    if (value === undefined) continue;
    draft[field.key] = entry(value, "MANUAL", "ACCEPTED", carried, decided);
  }
  return draft;
}

// --- Deciding one field --------------------------------------------------------------------------------------------------
export type ApplyFieldDecisionInput = {
  existing: AgreementDraftEntry | undefined;
  fieldKey: AgreementFieldKey;
  decision: AgreementFieldDecisionKind;
  // Already validated by checkFieldDecisionValue: undefined = none supplied.
  value: unknown;
  actorUserRef: string;
  now: string;
};
export type ApplyFieldDecisionResult = { ok: true; entry: AgreementDraftEntry } | { ok: false; message: string };

// The one rule set for a human decision on a draft entry:
//   identity VALUE field    acknowledgement only; the entry holds no value, ever
//   UNAVAILABLE / N.A.      the entry keeps no value
//   CORRECTED               takes the supplied value (the extractor's own proposal stays beside it)
//   ACCEPTED                keeps the entry's current value; a supplied value is accepted only when
//                           there is no current value (a value someone typed) or it equals the
//                           current one - changing a value is CORRECTED, never a silent ACCEPTED
export function applyFieldDecision(input: ApplyFieldDecisionInput): ApplyFieldDecisionResult {
  const { existing, fieldKey, decision, value, actorUserRef, now } = input;
  const field = AGREEMENT_FIELD_BY_KEY[fieldKey];
  const decided = { decidedByUserRef: actorUserRef, decidedAt: now };
  const manual = provenance(MANUAL_ENTRY_LABEL);

  if (field.identityValue) {
    return { ok: true, entry: entry(null, existing?.origin ?? "MANUAL", decision, existing?.provenance ?? manual, decided) };
  }
  if (decision === "UNAVAILABLE" || decision === "NOT_APPLICABLE") {
    return { ok: true, entry: entry(null, existing?.origin ?? "MANUAL", decision, existing?.provenance ?? manual, { ...decided, extractedValue: existing?.extractedValue ?? null }) };
  }
  if (decision === "CORRECTED") {
    const from = existing?.provenance;
    return {
      ok: true,
      entry: entry(value, existing?.origin ?? "MANUAL", "CORRECTED", provenance(CORRECTED_LABEL, { extractionRunRef: from?.extractionRunRef ?? null, page: from?.page ?? null, confidence: from?.confidence ?? null }), {
        ...decided,
        extractedValue: existing?.extractedValue ?? null,
      }),
    };
  }

  // ACCEPTED
  const supplied = value !== undefined && value !== null;
  if (!supplied) {
    if (!existing || existing.value === null) return { ok: false, message: `${field.label} has no value to accept. Supply a value with a CORRECTED decision, or mark it UNAVAILABLE / NOT_APPLICABLE.` };
    return { ok: true, entry: { ...existing, ...decided, decision: "ACCEPTED" } };
  }
  if (existing && existing.value !== null) {
    if (!isDeepStrictEqual(existing.value, value)) return { ok: false, message: `${field.label} already has a different value. Use a CORRECTED decision to change it.` };
    return { ok: true, entry: { ...existing, ...decided, decision: "ACCEPTED" } };
  }
  // No current value: accepting the extractor's own (previously declined) proposal keeps its origin;
  // any other supplied value is a value a human entered.
  if (existing?.extractedValue !== null && existing?.extractedValue !== undefined && isDeepStrictEqual(existing.extractedValue, value)) {
    return { ok: true, entry: { ...existing, ...decided, value: value as AgreementDraftEntry["value"], decision: "ACCEPTED" } };
  }
  return { ok: true, entry: entry(value, "MANUAL", "ACCEPTED", manual, { ...decided, extractedValue: existing?.extractedValue ?? null }) };
}

// --- Attaching an extraction run -------------------------------------------------------------------------------------------
export type AttachProposalsResult = { draft: AgreementDraft; attachedCount: number; keptDecisionCount: number; skippedCount: number; attachedFieldKeys: AgreementFieldKey[] };

// Copies the run's NON-restricted proposals into the draft as origin EXTRACTED / decision PENDING.
//   - an entry a human already DECIDED (accepted, corrected, unavailable, not applicable) is never
//     touched (kept); only an absent or still-PENDING entry takes the proposal;
//   - an identity VALUE proposal creates an acknowledgement entry with no value (the value lives only
//     in the restricted extraction record and is never copied here);
//   - a proposal with no value, for a field the extractor may not fill, for a field that does not
//     apply to this counterparty type, or whose value does not fit the field's schema is skipped;
//   - the proposal's confidence / page ride along as provenance, never the raw snippet.
export function attachProposalsToDraft(draft: AgreementDraft, run: ExtractionRunDoc, counterpartyType: CounterpartyType): AttachProposalsResult {
  const next: AgreementDraft = { ...draft };
  const attachedFieldKeys: AgreementFieldKey[] = [];
  let keptDecisionCount = 0;
  let skippedCount = 0;

  for (const proposal of run.proposals) {
    const field = AGREEMENT_FIELD_BY_KEY[proposal.fieldKey];
    if (field.mode !== "DECIDED" || !field.extractable || !field.appliesTo.includes(counterpartyType)) {
      skippedCount += 1;
      continue;
    }
    const existing = next[proposal.fieldKey];
    if (existing && existing.decision !== "PENDING") {
      keptDecisionCount += 1;
      continue;
    }
    const prov = provenance(field.identityValue ? IDENTITY_ACK_LABEL : `Extracted from contract (parser ${run.parserVersion})`, { extractionRunRef: run.runRef, page: proposal.source.page, confidence: proposal.confidence });

    if (field.identityValue) {
      next[proposal.fieldKey] = entry(null, "EXTRACTED", "PENDING", prov);
    } else {
      const value = validValue(proposal.fieldKey, proposal.normalizedValue);
      if (value === undefined) {
        skippedCount += 1;
        continue;
      }
      next[proposal.fieldKey] = entry(value, "EXTRACTED", "PENDING", prov, { extractedValue: value as AgreementDraftEntry["value"] });
    }
    attachedFieldKeys.push(proposal.fieldKey);
  }
  return { draft: next, attachedCount: attachedFieldKeys.length, keptDecisionCount, skippedCount, attachedFieldKeys };
}

// --- Fields for the reconciliation agent ----------------------------------------------------------------------------
export type ReconciliationFieldEntry = {
  fieldKey: AgreementFieldKey;
  restricted: boolean;
  // null for every restricted field: an Agreement never holds an identity value.
  value: unknown;
  origin: AgreementFieldOrigin;
  decision: AgreementEntryDecision;
  extractedValue: unknown;
  provenance: AgreementFieldProvenanceEntry;
};

// The Agreement-side values of one version for cross-verification: the WORKING draft of an
// unconfirmed version, or the frozen terms + contact snapshot + provenance of a confirmed one.
// Restricted fields are listed with value null (their decision only).
export function reconciliationEntriesForVersion(version: AgreementVersionDoc): ReconciliationFieldEntry[] {
  const out: ReconciliationFieldEntry[] = [];
  if (version.confirmation === null) {
    for (const field of AGREEMENT_FIELDS) {
      const item = version.draft[field.key];
      if (!item) continue;
      out.push({
        fieldKey: field.key,
        restricted: field.restricted,
        value: field.restricted ? null : item.value,
        origin: item.origin,
        decision: item.decision,
        extractedValue: field.restricted ? null : item.extractedValue,
        provenance: item.provenance,
      });
    }
    return out;
  }
  for (const field of AGREEMENT_FIELDS) {
    const frozen = version.fieldProvenance?.[field.key];
    if (!frozen || field.mode !== "DECIDED") continue;
    out.push({
      fieldKey: field.key,
      restricted: field.restricted,
      value: field.restricted ? null : (readConfirmedFieldValue(version, field) ?? null),
      origin: frozen.origin,
      decision: frozen.decision,
      extractedValue: null,
      provenance: frozen.provenance,
    });
  }
  return out;
}

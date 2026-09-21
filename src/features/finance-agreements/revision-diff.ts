import { AGREEMENT_FIELDS, AGREEMENT_FIELD_BY_KEY, type AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { AgreementDraftEntryDto } from "@/server/finance-agreements/client-dto";
import type { ConfirmedAgreementTerms, ContactSnapshot } from "@/server/finance-agreements/terms";

import { confirmedFieldValue, deepEqual, formatFieldValue } from "./field-values";
import { fieldPlacement, type IntakeSectionId } from "./field-view-model";
import { fieldLabel } from "./format";

// Step 14B: the changed-field diff of a REVISION against the prior confirmed terms (pure).
// A revision is the next editable DRAFT version, prefilled from the previous confirmed terms; the screen marks every field whose
// value differs from that prior version (the ACTIVE one stays untouched and readable until the replacement is activated).
export type ConfirmedTermSet = { terms: ConfirmedAgreementTerms | null; contactSnapshot: ContactSnapshot | null };

export type FieldChange = {
  fieldKey: AgreementFieldKey;
  label: string;
  section: IntakeSectionId;
  before: unknown;
  after: unknown;
  beforeText: string;
  afterText: string;
};

// The registry fields whose confirmed value lives in the terms / contact snapshot: every decidable non-identity field, plus the
// derived Agreement type (a change of the commercial structure changes it).
const COMPARABLE_FIELDS = AGREEMENT_FIELDS.filter(
  (field) => field.path !== null && (field.target === "terms" || field.target === "contactSnapshot") && ((field.mode === "DECIDED" && !field.identityValue) || field.key === "agreementType"),
);

function change(fieldKey: AgreementFieldKey, before: unknown, after: unknown, currencyBefore: string | null, currencyAfter: string | null): FieldChange {
  return {
    fieldKey,
    label: fieldLabel(fieldKey),
    section: fieldPlacement(fieldKey).section,
    before,
    after,
    beforeText: formatFieldValue(fieldKey, before, { currency: currencyBefore }),
    afterText: formatFieldValue(fieldKey, after, { currency: currencyAfter }),
  };
}

// Two CONFIRMED term sets (e.g. the superseded version vs its replacement): the fields whose value differs. Registry order.
export function diffConfirmedTerms(before: ConfirmedTermSet, after: ConfirmedTermSet): FieldChange[] {
  const currencyBefore = before.terms?.commercial.currency ?? null;
  const currencyAfter = after.terms?.commercial.currency ?? null;
  const changes: FieldChange[] = [];
  for (const field of COMPARABLE_FIELDS) {
    const left = confirmedFieldValue(field.key, before.terms, before.contactSnapshot);
    const right = confirmedFieldValue(field.key, after.terms, after.contactSnapshot);
    if (!deepEqual(left, right)) changes.push(change(field.key, left, right, currencyBefore, currencyAfter));
  }
  return changes;
}

// The value a draft entry WILL freeze to at confirm (mirrors assembleConfirmedAgreement): ACCEPTED / CORRECTED -> its value;
// UNAVAILABLE -> null; NOT_APPLICABLE -> the field's not-applicable shape; PENDING -> undecided (undefined).
function resolvedDraftValue(key: AgreementFieldKey, entry: AgreementDraftEntryDto): unknown | undefined {
  if (entry.decision === "PENDING") return undefined;
  if (entry.decision === "UNAVAILABLE") return null;
  if (entry.decision === "NOT_APPLICABLE") return AGREEMENT_FIELD_BY_KEY[key].notApplicableValue;
  return entry.value;
}

// An editable REVISION draft vs the prior confirmed terms: the fields the person has (so far) decided to a DIFFERENT value.
// A still-PENDING entry is undecided, not changed; a field with no draft entry is untouched.
export function diffDraftAgainstPrior(draft: Partial<Record<AgreementFieldKey, AgreementDraftEntryDto>>, prior: ConfirmedTermSet): FieldChange[] {
  const currencyBefore = prior.terms?.commercial.currency ?? null;
  const currencyEntry = draft.currency;
  const currencyAfter = currencyEntry && (currencyEntry.decision === "ACCEPTED" || currencyEntry.decision === "CORRECTED") && typeof currencyEntry.value === "string" ? currencyEntry.value : currencyBefore;
  const changes: FieldChange[] = [];
  for (const field of COMPARABLE_FIELDS) {
    if (field.key === "agreementType") continue;
    const entry = draft[field.key];
    if (!entry) continue;
    const resolved = resolvedDraftValue(field.key, entry);
    if (resolved === undefined) continue;
    const before = confirmedFieldValue(field.key, prior.terms, prior.contactSnapshot);
    if (!deepEqual(before, resolved)) changes.push(change(field.key, before, resolved, currencyBefore, currencyAfter));
  }
  return changes;
}

export const changedFieldKeys = (changes: readonly FieldChange[]): Set<AgreementFieldKey> => new Set(changes.map((item) => item.fieldKey));

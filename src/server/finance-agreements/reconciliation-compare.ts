import { AGREEMENT_FIELD_BY_KEY, type AgreementFieldGroup, type AgreementFieldKey } from "./fields";
import type { ReconciliationFieldEntry } from "./agreement-draft";
import type { AgreementEntryDecision, AgreementFieldOrigin, CounterpartyType, ExtractionConfidence } from "./types";

// Step 14A: the PURE cross-verification of an Agreement's field values against CreatorOps' canonical
// records. No Firestore, no clock, no authorization decision of its own: the service hands it
// what the actor MAY see (identityVisible / permission flags) plus the already-loaded canonical
// snapshot, and it returns one typed result per field.
//
// It never decides which side is right and never writes: a difference is reported as MISMATCH and
// the actions a human may deliberately choose are listed, nothing more.
//
// Restricted identity fields obey one rule: unless `identityVisible` the state is RESTRICTED with NO
// value and NO match / mismatch result at all (a "MATCH" would itself disclose the value).

export const RECONCILIATION_STATES = ["MATCH", "MISSING_IN_CREATOROPS", "MISSING_IN_AGREEMENT", "MISMATCH", "NOT_APPLICABLE", "RESTRICTED", "UNAVAILABLE"] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

export const RECONCILIATION_ACTIONS = ["UPDATE_MASTER_DATA_FROM_AGREEMENT", "KEEP_CREATOROPS_VALUE", "USE_AGREEMENT_VALUE_IN_AGREEMENT_ONLY", "OVERWRITE_MASTER_DATA_WITH_AGREEMENT_VALUE"] as const;
export type ReconciliationAction = (typeof RECONCILIATION_ACTIONS)[number];

export type ReconciliationReason =
  | "no_canonical_field"
  | "canonical_unreadable"
  | "canonical_value_not_comparable"
  | "agreement_value_not_comparable"
  | "not_applicable_to_counterparty"
  | "decided_not_applicable"
  | "canonical_declares_not_applicable"
  | "nothing_to_compare"
  | "identity_access_required";

// The fields a reconciliation reports on: contact facts, identity values and the partner/platform
// context. Everything else in the registry (dates, commercial terms ...) has no CreatorOps
// counterpart to compare against.
export const RECONCILIATION_FIELD_KEYS = [
  "counterpartyName",
  "contactNumber",
  "emailAddress",
  "state",
  "address",
  "pinCode",
  "gstin",
  "aadhaarNumber",
  "panNumber",
  "panHolderName",
  "bankAccountNumber",
  "ifsc",
  "platforms",
  "collaboratorPageLink",
  "collaboratorPageName",
] as const satisfies readonly AgreementFieldKey[];

// The ONLY fields a master-data command may write (ordinary contact + restricted identity components
// the owning module lets us save). Bank is deliberately absent: the canonical bank record also
// needs a holder name, bank name and branch that a contract extraction cannot supply.
export const MASTER_DATA_UPDATABLE_FIELD_KEYS: readonly AgreementFieldKey[] = ["emailAddress", "contactNumber", "panNumber", "aadhaarNumber", "gstin"];
export const CONTACT_UPDATABLE_FIELD_KEYS = ["emailAddress", "contactNumber"] as const;

// --- Normalization (compare-only; nothing normalized here is ever stored) ----------------------------------------------------
const collapse = (value: string) => value.replace(/\s+/g, " ").trim();

export function normalizeName(raw: string): string | null {
  const text = collapse(
    raw
      .normalize("NFKC")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^\p{L}\p{N}]+/gu, " "),
  )
    .split(" ")
    .map((word) => (word === "pvt" ? "private" : word === "ltd" ? "limited" : word === "co" ? "company" : word))
    .join(" ")
    .trim();
  return text.length > 0 ? text : null;
}

export function normalizeEmail(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  return text.length > 0 ? text : null;
}

// Digits only; an Indian +91 / 91 / 0 prefix does not make two numbers different.
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D+/g, "");
  if (digits.length === 0) return null;
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  else if (digits.length === 13 && digits.startsWith("091")) digits = digits.slice(3);
  return digits;
}

export function normalizeState(raw: string): string | null {
  const text = collapse(raw.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " "));
  return text.length > 0 ? text : null;
}

const alnumUpper = (raw: string) => raw.replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
export function normalizeIdentityCode(raw: string): string | null {
  const text = alnumUpper(raw);
  return text.length > 0 ? text : null;
}

// A masked Aadhaar (XXXXXXXX1234) or any non-12-digit value is not comparable.
export function normalizeAadhaar(raw: string): string | null {
  const digits = raw.replace(/[\s-]+/g, "");
  return /^\d{12}$/.test(digits) ? digits : null;
}

export function normalizePlatformName(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  return text.length > 0 ? text : null;
}

// scheme, "www." and a trailing slash do not make two page links different.
export function normalizePageLink(raw: string): string | null {
  const text = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#]+$/, "");
  return text.length > 0 ? text : null;
}

type FieldSpec = { normalize: (raw: string) => string | null; mode: "any" | "set" };

// Keys are quoted on purpose (see the boundary test on identity-value property names).
const FIELD_SPECS: Partial<Record<AgreementFieldKey, FieldSpec>> = {
  counterpartyName: { normalize: normalizeName, mode: "any" },
  contactNumber: { normalize: normalizePhone, mode: "any" },
  emailAddress: { normalize: normalizeEmail, mode: "any" },
  state: { normalize: normalizeState, mode: "any" },
  "gstin": { normalize: normalizeIdentityCode, mode: "any" },
  "aadhaarNumber": { normalize: normalizeAadhaar, mode: "any" },
  "panNumber": { normalize: normalizeIdentityCode, mode: "any" },
  "bankAccountNumber": { normalize: normalizeIdentityCode, mode: "any" },
  "ifsc": { normalize: normalizeIdentityCode, mode: "any" },
  platforms: { normalize: normalizePlatformName, mode: "set" },
  collaboratorPageLink: { normalize: normalizePageLink, mode: "any" },
  collaboratorPageName: { normalize: normalizeName, mode: "any" },
};

// --- Inputs ----------------------------------------------------------------------------------------------------------------
export type CanonicalSide =
  | { kind: "no_canonical_field" }
  | { kind: "unreadable" }
  | { kind: "empty" }
  | { kind: "declared_not_applicable" }
  | { kind: "values"; values: readonly string[] };

// What CreatorOps already holds for the counterparty, already loaded (and, for `identity`, only
// loaded when the actor may see it). Owned by the Partner / Vendor modules; never written here.
export type CanonicalSnapshot = {
  counterpartyType: CounterpartyType;
  legalName: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  regionIds: readonly string[];
  // Partner Accounts in play for a Partner Agreement; null for a Vendor (no accounts exist).
  accounts: ReadonlyArray<{ platform: string; profileUrl: string | null; displayName: string | null; handle: string | null }> | null;
  // null = not loaded (the actor may not see identity); "unreadable" = the store could not be read.
  identity: null | "unreadable" | { pan: string | null; aadhaar: string | null; gst: { applicable: boolean; number: string | null } | null; bankAccountNo: string | null; bankIfscCode: string | null };
};

const clean = (value: string | null | undefined) => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);
const cleanList = (values: ReadonlyArray<string | null | undefined>) => values.map(clean).filter((value): value is string => value !== null);

// Pure. The canonical side of one field.
export function canonicalSideFor(fieldKey: AgreementFieldKey, snapshot: CanonicalSnapshot): CanonicalSide {
  const values = (list: string[]): CanonicalSide => (list.length > 0 ? { kind: "values", values: list } : { kind: "empty" });
  const identity = snapshot.identity;
  const fromIdentity = (pick: (doc: Exclude<CanonicalSnapshot["identity"], null | "unreadable">) => CanonicalSide): CanonicalSide => {
    if (identity === "unreadable" || identity === null) return { kind: "unreadable" };
    return pick(identity);
  };

  switch (fieldKey) {
    case "counterpartyName":
      // The Agreement should carry the legal name; either recorded name is a match.
      return values(cleanList([snapshot.legalName, snapshot.displayName]));
    case "contactNumber":
      return values(cleanList([snapshot.phone]));
    case "emailAddress":
      return values(cleanList([snapshot.email]));
    case "state":
      return values(cleanList([...snapshot.regionIds]));
    case "platforms":
      return snapshot.accounts === null ? { kind: "no_canonical_field" } : values([...new Set(cleanList(snapshot.accounts.map((account) => account.platform)))]);
    case "collaboratorPageLink":
      return snapshot.accounts === null ? { kind: "no_canonical_field" } : values(cleanList(snapshot.accounts.map((account) => account.profileUrl)));
    case "collaboratorPageName":
      return snapshot.accounts === null ? { kind: "no_canonical_field" } : values(cleanList(snapshot.accounts.map((account) => account.displayName ?? account.handle)));
    case "panNumber":
      return fromIdentity((doc) => values(cleanList([doc.pan])));
    case "aadhaarNumber":
      return fromIdentity((doc) => values(cleanList([doc.aadhaar])));
    case "gstin":
      return fromIdentity((doc) => (doc.gst?.applicable === false ? { kind: "declared_not_applicable" } : values(cleanList([doc.gst?.number]))));
    case "bankAccountNumber":
      return fromIdentity((doc) => values(cleanList([doc.bankAccountNo])));
    case "ifsc":
      return fromIdentity((doc) => values(cleanList([doc.bankIfscCode])));
    default:
      // address, pinCode, panHolderName ... : no canonical home exists today - never invent one.
      return { kind: "no_canonical_field" };
  }
}

export type AgreementSide = {
  decision: AgreementEntryDecision | null;
  origin: AgreementFieldOrigin | null;
  // The agreement's working (draft) or frozen (confirmed) value. For an identity field this is the
  // RESTRICTED extracted value and is only ever supplied when the actor may see it.
  value: unknown;
  extractedValue: unknown;
  provenance: { label: string; confidence: ExtractionConfidence | null; page: number | null } | null;
};

export type ComparisonPermissions = {
  // manage_agreements AND the version is the open, unconfirmed one: the Agreement can still be changed.
  resolveInAgreement: boolean;
  // manage_agreements AND the OWNING module permits the write (edit / restricted identity + categories).
  masterDataWritable: boolean;
};

export type FieldComparisonInput = {
  fieldKey: AgreementFieldKey;
  counterpartyType: CounterpartyType;
  identityBlocked: boolean;
  canonical: CanonicalSide;
  agreement: AgreementSide;
  permissions: ComparisonPermissions;
};

export type FieldReconciliationDto = {
  fieldKey: AgreementFieldKey;
  label: string;
  group: AgreementFieldGroup;
  state: ReconciliationState;
  reason?: ReconciliationReason;
  // Present only where the actor may see the value; absent for RESTRICTED.
  canonicalValue?: string | string[];
  extractedValue?: unknown;
  confirmedValue?: unknown;
  agreementDecision?: AgreementEntryDecision;
  source: {
    canonical: string | null;
    agreement: { label: string; origin: AgreementFieldOrigin | null; confidence: ExtractionConfidence | null; page: number | null } | null;
  };
  allowedActions: ReconciliationAction[];
};

const CANONICAL_SOURCE_LABEL = { master_data: "CreatorOps master data", partner_account: "CreatorOps Partner Accounts", restricted_identity: "CreatorOps restricted identity record", none: null } as const;

function asStrings(value: unknown): string[] {
  if (typeof value === "string") return value.trim().length > 0 ? [value.trim()] : [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return [];
}

function normalizeAll(spec: FieldSpec, values: readonly string[]): string[] {
  return values.map(spec.normalize).filter((value): value is string => value !== null);
}

function valuesEqual(spec: FieldSpec, agreement: string[], canonical: string[]): boolean {
  if (spec.mode === "set") {
    const a = new Set(agreement);
    const c = new Set(canonical);
    return a.size === c.size && [...a].every((item) => c.has(item));
  }
  return agreement.every((item) => canonical.includes(item));
}

const isDecided = (decision: AgreementEntryDecision | null) => decision === "ACCEPTED" || decision === "CORRECTED";

// Pure. Compares one field. The DTO is built field-by-field: RESTRICTED carries no value key at all.
export function compareField(input: FieldComparisonInput): FieldReconciliationDto {
  const field = AGREEMENT_FIELD_BY_KEY[input.fieldKey];
  const canonicalLabel = CANONICAL_SOURCE_LABEL[field.canonicalSource.kind];
  const agreementSource = input.agreement.provenance
    ? { label: input.agreement.provenance.label, origin: input.agreement.origin, confidence: input.agreement.provenance.confidence, page: input.agreement.provenance.page }
    : null;

  const base = { fieldKey: input.fieldKey, label: field.label, group: field.group };
  const result = (state: ReconciliationState, extra: Partial<FieldReconciliationDto> = {}): FieldReconciliationDto => ({
    ...base,
    state,
    source: { canonical: canonicalLabel, agreement: agreementSource },
    allowedActions: [],
    ...extra,
  });

  // 1. Not a field of this counterparty (an Aadhaar for a Vendor).
  if (!field.appliesTo.includes(input.counterpartyType)) return { ...base, state: "NOT_APPLICABLE", reason: "not_applicable_to_counterparty", source: { canonical: null, agreement: null }, allowedActions: [] };

  // 2. Restricted identity the actor may not see: NO value, NO result, NOTHING that varies with the data.
  if (field.identityValue && input.identityBlocked) return { ...base, state: "RESTRICTED", reason: "identity_access_required", source: { canonical: null, agreement: null }, allowedActions: [] };

  const decision = input.agreement.decision;
  const decided = isDecided(decision);
  const agreementDecisionPart = decision ? { agreementDecision: decision } : {};
  const agreementValues = decision === "UNAVAILABLE" || decision === "NOT_APPLICABLE" ? [] : asStrings(input.agreement.value);
  const visible: Partial<FieldReconciliationDto> = {
    ...agreementDecisionPart,
    ...(input.agreement.extractedValue !== null && input.agreement.extractedValue !== undefined ? { extractedValue: input.agreement.extractedValue } : {}),
    ...(decided && input.agreement.value !== null && input.agreement.value !== undefined && !field.identityValue ? { confirmedValue: input.agreement.value } : {}),
  };
  const canonical = input.canonical;
  const withCanonical = (extra: Partial<FieldReconciliationDto> = {}): Partial<FieldReconciliationDto> => ({
    ...visible,
    ...(canonical.kind === "values" ? { canonicalValue: canonical.values.length === 1 ? canonical.values[0]! : [...canonical.values] } : {}),
    ...extra,
  });

  // 3. No canonical home / store unreadable: cannot compare (never invent a home, never guess).
  if (canonical.kind === "no_canonical_field") return result("UNAVAILABLE", withCanonical({ reason: "no_canonical_field" }));
  if (canonical.kind === "unreadable") return result("UNAVAILABLE", withCanonical({ reason: "canonical_unreadable" }));

  // 4. The Agreement itself declares the field not applicable.
  if (decision === "NOT_APPLICABLE") return result("NOT_APPLICABLE", withCanonical({ reason: "decided_not_applicable" }));

  const spec = FIELD_SPECS[input.fieldKey];
  if (!spec) return result("UNAVAILABLE", withCanonical({ reason: "no_canonical_field" }));

  const agreementHas = agreementValues.length > 0;
  const agreementNorm = normalizeAll(spec, agreementValues);
  if (agreementHas && agreementNorm.length !== agreementValues.length) return result("UNAVAILABLE", withCanonical({ reason: "agreement_value_not_comparable" }));

  const canonicalNorm = canonical.kind === "values" ? normalizeAll(spec, canonical.values) : [];
  if (canonical.kind === "values" && canonicalNorm.length === 0) return result("UNAVAILABLE", withCanonical({ reason: "canonical_value_not_comparable" }));

  const updatable = MASTER_DATA_UPDATABLE_FIELD_KEYS.includes(input.fieldKey);
  const masterActionAllowed = updatable && input.permissions.masterDataWritable && decided;

  // 5. Both sides.
  if (canonical.kind === "values" && agreementHas) {
    if (valuesEqual(spec, agreementNorm, canonicalNorm)) return result("MATCH", withCanonical());
    const actions: ReconciliationAction[] = [];
    if (input.permissions.resolveInAgreement) actions.push("KEEP_CREATOROPS_VALUE", "USE_AGREEMENT_VALUE_IN_AGREEMENT_ONLY");
    if (masterActionAllowed) actions.push("OVERWRITE_MASTER_DATA_WITH_AGREEMENT_VALUE");
    return result("MISMATCH", withCanonical({ allowedActions: actions }));
  }
  if (canonical.kind === "values") return result("MISSING_IN_AGREEMENT", withCanonical());

  // 6. CreatorOps has nothing (empty) or declared the component not applicable.
  if (agreementHas) {
    if (canonical.kind === "declared_not_applicable") {
      const actions: ReconciliationAction[] = [];
      if (input.permissions.resolveInAgreement) actions.push("KEEP_CREATOROPS_VALUE", "USE_AGREEMENT_VALUE_IN_AGREEMENT_ONLY");
      if (masterActionAllowed) actions.push("OVERWRITE_MASTER_DATA_WITH_AGREEMENT_VALUE");
      return result("MISMATCH", withCanonical({ reason: "canonical_declares_not_applicable", allowedActions: actions }));
    }
    return result("MISSING_IN_CREATOROPS", withCanonical({ allowedActions: masterActionAllowed ? ["UPDATE_MASTER_DATA_FROM_AGREEMENT"] : [] }));
  }
  if (canonical.kind === "declared_not_applicable") return result("NOT_APPLICABLE", withCanonical({ reason: "canonical_declares_not_applicable" }));
  return result("UNAVAILABLE", withCanonical({ reason: "nothing_to_compare" }));
}

// --- Whole-Agreement comparison -----------------------------------------------------------------------------------------------
export type ReconcileInput = {
  counterpartyType: CounterpartyType;
  // Both finance_contracts AND the counterparty's identity category. Without it every identity
  // field is RESTRICTED and NO restricted store is consulted.
  identityVisible: boolean;
  canManageAgreements: boolean;
  // The version is the head's open, unconfirmed one (its draft can still be resolved).
  versionOpen: boolean;
  // The OWNING module lets this actor edit ordinary contact data (feature + edit action).
  ownerMayEditContact: boolean;
  // The OWNING module lets this actor save restricted identity (feature + action + category) - AND finance_contracts.
  ownerMayManageIdentity: boolean;
  canonical: CanonicalSnapshot;
  // The version's draft (or frozen) entries, from reconciliationEntriesForVersion.
  entries: readonly ReconciliationFieldEntry[];
  // Restricted extracted values by field key; only ever non-empty when identityVisible.
  restrictedExtracted: Partial<Record<AgreementFieldKey, string>>;
};

export function reconcileFields(input: ReconcileInput): FieldReconciliationDto[] {
  const byKey = new Map(input.entries.map((entry) => [entry.fieldKey, entry] as const));
  return RECONCILIATION_FIELD_KEYS.map((fieldKey) => {
    const field = AGREEMENT_FIELD_BY_KEY[fieldKey];
    const entry = byKey.get(fieldKey);
    const identity = field.identityValue;
    const extracted = identity && input.identityVisible ? (input.restrictedExtracted[fieldKey] ?? null) : null;

    const agreement: AgreementSide = {
      decision: entry?.decision ?? null,
      origin: entry?.origin ?? null,
      // An Agreement never holds an identity value: its side is the restricted extracted value.
      value: identity ? extracted : (entry?.value ?? null),
      extractedValue: identity ? extracted : (entry?.extractedValue ?? null),
      provenance: entry ? { label: entry.provenance.label, confidence: entry.provenance.confidence, page: entry.provenance.page } : null,
    };
    const writable = identity ? input.ownerMayManageIdentity : input.ownerMayEditContact;
    return compareField({
      fieldKey,
      counterpartyType: input.counterpartyType,
      identityBlocked: identity && !input.identityVisible,
      canonical: canonicalSideFor(fieldKey, input.canonical),
      agreement,
      permissions: { resolveInAgreement: input.canManageAgreements && input.versionOpen, masterDataWritable: input.canManageAgreements && writable },
    });
  });
}

export function summarizeReconciliation(fields: readonly FieldReconciliationDto[]): Record<ReconciliationState, number> {
  const counts = Object.fromEntries(RECONCILIATION_STATES.map((state) => [state, 0])) as Record<ReconciliationState, number>;
  for (const field of fields) counts[field.state] += 1;
  return counts;
}

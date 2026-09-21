import { z } from "zod";

import { platformIdentifierArraySchema } from "@/server/shared/platform";
import {
  accountTransferFeeSchema,
  adminTermsSchema,
  advancePaymentSchema,
  agreementDatesSchema,
  agreementTypeSchema,
  commercialTermsSchema,
  contactSnapshotSchema,
  contractTermsTextSchema,
  deriveAgreementType,
  fixedComponentSchema,
  identityComponentStatusSchema,
  incentiveSchema,
  lfcSfcSchema,
  MAX_AGREEMENT_PLATFORMS,
  performanceTargetsSchema,
  platformTermsSchema,
  confirmedAgreementTermsSchema,
  type ConfirmedAgreementTerms,
  type ContactSnapshot,
  type IdentityComponents,
  type IdentityStatusState,
} from "./terms";
import type { AgreementDraft, AgreementFieldProvenance, AgreementSourceMode, CounterpartyType } from "./types";

// Step 14A: the Agreement FIELD REGISTRY - the single source of truth for which
// fields exist, where each one lives, whether it is restricted, whether it is
// required to confirm, and what shape its value must take. Plus the pure,
// side-effect-free validators the confirm service uses.
//
// deriveAgreementType lives in terms.ts (the terms schema needs it and fields.ts
// depends on terms.ts, never the reverse); it is re-exported here.
export { deriveAgreementType };

export const AGREEMENT_FIELD_KEYS = [
  // counterparty / contact
  "counterpartyName",
  "contactNumber",
  "emailAddress",
  "state",
  "address",
  "pinCode",
  "gstin",
  // restricted identity (values NEVER stored in Agreement docs) + document statuses
  "aadhaarNumber",
  "aadhaarStatus",
  "panNumber",
  "panHolderName",
  "bankAccountNumber",
  "ifsc",
  "aadhaarDocumentStatus",
  "panDocumentStatus",
  "gstCertificateStatus",
  // partner / platform
  "partnerRef",
  "partnerAccountRefs",
  "platforms",
  "collaboratorPageLink",
  "collaboratorPageName",
  // agreement dates / clauses
  "agreementNumber",
  "signedDate",
  "effectiveDate",
  "terminationDate",
  "renewalTerms",
  "noticeTerms",
  "terminationTerms",
  // commercial (payment-affecting)
  "currency",
  "paymentCycle",
  "fixedComponent",
  "monthlyRequiredQualifyingContentCount",
  "qualifyingUnit",
  "accountTransferFee",
  "advancePayment",
  "invoiceRequired",
  "invoiceDueTerms",
  "paymentDueTerms",
  "servicesMandated",
  "incentive",
  "lfcSfc",
  // warning-only targets
  "performanceTargets",
  // admin / manual / derived
  "onboardingProcessCompleted",
  "remarks",
  "agreementType",
] as const;
export const agreementFieldKeySchema = z.enum(AGREEMENT_FIELD_KEYS);
export type AgreementFieldKey = z.infer<typeof agreementFieldKeySchema>;

export type AgreementFieldGroup = "counterparty_contact" | "identity" | "partner_platform" | "dates_terms" | "commercial" | "targets" | "admin";

// Where a confirmed value lands in the version doc.
export type AgreementFieldTarget = "contactSnapshot" | "identityStatus" | "counterparty" | "terms";

export type AgreementFieldValueType = "text" | "date" | "enum" | "boolean" | "integer" | "currency_code" | "object" | "array" | "status" | "none";

// Where CreatorOps already holds the canonical value, if anywhere (informational
// - the reconciliation service owns the comparison). `none` = no canonical home
// (the Agreement keeps its own confirmed snapshot; never invent one).
export type AgreementCanonicalSource = { kind: "master_data" | "partner_account" | "restricted_identity" | "none"; path: string | null };

export type AgreementFieldDef = {
  key: AgreementFieldKey;
  group: AgreementFieldGroup;
  label: string;
  // True for every identity-group field: its VALUE (and, for statuses, its
  // per-component detail) is only visible with the identity sensitive category.
  restricted: boolean;
  // True only for real identity VALUES (GSTIN, Aadhaar, PAN, PAN holder name,
  // bank account, IFSC). Agreement docs store a decision for these, NEVER a value.
  identityValue: boolean;
  // DECIDED: a human decides it (ACCEPTED / CORRECTED / UNAVAILABLE / NOT_APPLICABLE).
  // COMPUTED: the system supplies it (counterparty refs, identity statuses, agreementType).
  mode: "DECIDED" | "COMPUTED";
  // Whether an extractor may propose it.
  extractable: boolean;
  // always: a usable value (ACCEPTED/CORRECTED) is required to confirm.
  // conditional: required when `requiredWhen` holds (checked by the assembled terms schema).
  // never: may be UNAVAILABLE / NOT_APPLICABLE.
  requiredForConfirm: "always" | "conditional" | "never";
  requiredWhen: string | null;
  // true: a missing draft entry blocks confirm (payment-affecting / dating fields
  // must be decided deliberately). false: a missing entry is recorded as an
  // implicit UNAVAILABLE at confirm.
  explicitDecisionRequired: boolean;
  appliesTo: readonly CounterpartyType[];
  valueType: AgreementFieldValueType;
  target: AgreementFieldTarget;
  // Path inside ConfirmedAgreementTerms / ContactSnapshot / IdentityComponents this field fills; null for none.
  path: readonly string[] | null;
  canonicalSource: AgreementCanonicalSource;
  // What NOT_APPLICABLE means for this field when frozen into the terms.
  notApplicableValue: unknown;
};

const BOTH: readonly CounterpartyType[] = ["PARTNER", "VENDOR"];
const PARTNER_ONLY: readonly CounterpartyType[] = ["PARTNER"];

type FieldOptions = Partial<Omit<AgreementFieldDef, "key" | "group" | "label" | "valueType" | "target">>;

function def(key: AgreementFieldKey, group: AgreementFieldGroup, label: string, valueType: AgreementFieldValueType, target: AgreementFieldTarget, path: readonly string[] | null, options: FieldOptions = {}): AgreementFieldDef {
  return {
    key,
    group,
    label,
    valueType,
    target,
    path,
    restricted: false,
    identityValue: false,
    mode: "DECIDED",
    extractable: true,
    requiredForConfirm: "never",
    requiredWhen: null,
    explicitDecisionRequired: false,
    appliesTo: BOTH,
    canonicalSource: { kind: "none", path: null },
    notApplicableValue: null,
    ...options,
  };
}

// An identity VALUE: restricted, extractable only into the RESTRICTED extraction
// record, decided by acknowledgement only, never stored on the Agreement.
function identityValueDef(key: AgreementFieldKey, label: string, component: "pan" | "aadhaar" | "gst" | "bank", canonicalPath: string | null, appliesTo: readonly CounterpartyType[] = BOTH): AgreementFieldDef {
  return def(key, "identity", label, "none", "identityStatus", [component], {
    restricted: true,
    identityValue: true,
    appliesTo,
    canonicalSource: canonicalPath ? { kind: "restricted_identity", path: canonicalPath } : { kind: "none", path: null },
  });
}

// A computed identity STATUS (component presence, from the canonical restricted store).
function identityStatusDef(key: AgreementFieldKey, label: string, component: "pan" | "aadhaar" | "gst", appliesTo: readonly CounterpartyType[] = BOTH): AgreementFieldDef {
  return def(key, "identity", label, "status", "identityStatus", [component], { restricted: true, mode: "COMPUTED", extractable: false, appliesTo, canonicalSource: { kind: "restricted_identity", path: `restrictedFinancialIdentities.${component}` } });
}

const COMMERCIAL_OPTIONS: FieldOptions = { explicitDecisionRequired: true };
const terms = (...path: string[]) => path;

const DEFS: AgreementFieldDef[] = [
  // --- counterparty / contact ---
  def("counterpartyName", "counterparty_contact", "Counterparty name", "text", "contactSnapshot", terms("counterpartyName"), {
    requiredForConfirm: "always",
    explicitDecisionRequired: true,
    canonicalSource: { kind: "master_data", path: "legalName|displayName" },
  }),
  def("contactNumber", "counterparty_contact", "Contact number", "text", "contactSnapshot", terms("contactNumber"), { canonicalSource: { kind: "master_data", path: "phone" } }),
  def("emailAddress", "counterparty_contact", "Email address", "text", "contactSnapshot", terms("emailAddress"), { canonicalSource: { kind: "master_data", path: "email" } }),
  def("state", "counterparty_contact", "State", "text", "contactSnapshot", terms("state"), { canonicalSource: { kind: "master_data", path: "regionIds" } }),
  // No canonical address / PIN home exists today - the Agreement keeps its own confirmed snapshot.
  def("address", "counterparty_contact", "Address", "text", "contactSnapshot", terms("address")),
  def("pinCode", "counterparty_contact", "PIN code", "text", "contactSnapshot", terms("pinCode")),
  identityValueDef("gstin", "GSTIN", "gst", "restrictedFinancialIdentities.gst.number"),

  // --- restricted identity ---
  identityValueDef("aadhaarNumber", "Aadhaar number", "aadhaar", "restrictedFinancialIdentities.aadhaar.number", PARTNER_ONLY),
  identityStatusDef("aadhaarStatus", "Aadhaar status", "aadhaar", PARTNER_ONLY),
  identityValueDef("panNumber", "PAN number", "pan", "restrictedFinancialIdentities.pan.number"),
  identityValueDef("panHolderName", "PAN holder name", "pan", null),
  identityValueDef("bankAccountNumber", "Bank account number", "bank", "restrictedFinancialIdentities.bank.accountNumber"),
  identityValueDef("ifsc", "IFSC", "bank", "restrictedFinancialIdentities.bank.ifsc"),
  identityStatusDef("aadhaarDocumentStatus", "Aadhaar document status", "aadhaar", PARTNER_ONLY),
  identityStatusDef("panDocumentStatus", "PAN document status", "pan"),
  identityStatusDef("gstCertificateStatus", "GST certificate status", "gst"),

  // --- partner / platform ---
  def("partnerRef", "partner_platform", "Partner", "text", "counterparty", null, { mode: "COMPUTED", extractable: false, appliesTo: PARTNER_ONLY, canonicalSource: { kind: "master_data", path: "partnerRef" } }),
  def("partnerAccountRefs", "partner_platform", "Partner Accounts", "array", "counterparty", null, { mode: "COMPUTED", extractable: false, appliesTo: PARTNER_ONLY, canonicalSource: { kind: "partner_account", path: "partnerAccountRef" } }),
  def("platforms", "partner_platform", "Platforms", "array", "terms", terms("platform", "platforms"), { canonicalSource: { kind: "partner_account", path: "platform" }, notApplicableValue: [] }),
  def("collaboratorPageLink", "partner_platform", "Collaborator page link", "text", "terms", terms("platform", "collaboratorPageLink"), { canonicalSource: { kind: "partner_account", path: "profileUrl" } }),
  def("collaboratorPageName", "partner_platform", "Collaborator page name", "text", "terms", terms("platform", "collaboratorPageName"), { canonicalSource: { kind: "partner_account", path: "displayName" } }),

  // --- agreement dates / clauses (Agreement STATUS is CreatorOps lifecycle, never copied from text) ---
  def("agreementNumber", "dates_terms", "Agreement number", "text", "terms", terms("agreementNumber")),
  def("signedDate", "dates_terms", "Signed date", "date", "terms", terms("dates", "signedDate")),
  def("effectiveDate", "dates_terms", "Effective date", "date", "terms", terms("dates", "effectiveFrom"), { requiredForConfirm: "always", explicitDecisionRequired: true }),
  def("terminationDate", "dates_terms", "Termination date", "date", "terms", terms("dates", "effectiveTo")),
  def("renewalTerms", "dates_terms", "Renewal terms", "text", "terms", terms("contractTerms", "renewalTerms")),
  def("noticeTerms", "dates_terms", "Notice terms", "text", "terms", terms("contractTerms", "noticeTerms")),
  def("terminationTerms", "dates_terms", "Termination terms", "text", "terms", terms("contractTerms", "terminationTerms")),

  // --- commercial (payment-affecting; every one must be decided deliberately) ---
  def("currency", "commercial", "Currency", "currency_code", "terms", terms("commercial", "currency"), { ...COMMERCIAL_OPTIONS, requiredForConfirm: "conditional", requiredWhen: "any amount is present" }),
  def("paymentCycle", "commercial", "Payment cycle", "enum", "terms", terms("commercial", "paymentCycle"), COMMERCIAL_OPTIONS),
  def("fixedComponent", "commercial", "Fixed component", "object", "terms", terms("commercial", "fixedComponent"), { ...COMMERCIAL_OPTIONS, notApplicableValue: { applicable: false, amountMinor: null } }),
  // The old "Fixed deliverable units" label maps here (there is no Deliverable entity).
  def("monthlyRequiredQualifyingContentCount", "commercial", "Monthly required qualifying content count", "integer", "terms", terms("commercial", "monthlyRequiredQualifyingContentCount"), {
    ...COMMERCIAL_OPTIONS,
    requiredForConfirm: "conditional",
    requiredWhen: "a qualifying unit is present",
  }),
  def("qualifyingUnit", "commercial", "Qualifying unit", "text", "terms", terms("commercial", "qualifyingUnit"), { ...COMMERCIAL_OPTIONS, requiredForConfirm: "conditional", requiredWhen: "a required content count is present" }),
  def("accountTransferFee", "commercial", "Account transfer fee", "object", "terms", terms("commercial", "accountTransferFee"), { ...COMMERCIAL_OPTIONS, notApplicableValue: { applicable: false, amountMinor: null, details: null } }),
  def("advancePayment", "commercial", "Advance payment", "object", "terms", terms("commercial", "advancePayment"), { ...COMMERCIAL_OPTIONS, notApplicableValue: { applicable: false, details: null, amountMinor: null } }),
  def("invoiceRequired", "commercial", "Invoice required", "boolean", "terms", terms("commercial", "invoiceRequired"), COMMERCIAL_OPTIONS),
  def("invoiceDueTerms", "commercial", "Invoice due terms", "text", "terms", terms("commercial", "invoiceDueTerms"), COMMERCIAL_OPTIONS),
  def("paymentDueTerms", "commercial", "Payment due terms", "text", "terms", terms("commercial", "paymentDueTerms"), COMMERCIAL_OPTIONS),
  def("servicesMandated", "commercial", "Services mandated", "text", "terms", terms("commercial", "servicesMandated"), COMMERCIAL_OPTIONS),
  def("incentive", "commercial", "Incentive slabs", "object", "terms", terms("commercial", "incentive"), { ...COMMERCIAL_OPTIONS, notApplicableValue: { applicable: false, slabs: [] } }),
  def("lfcSfc", "commercial", "LFC / SFC rule (explicit only)", "object", "terms", terms("commercial", "lfcSfc"), COMMERCIAL_OPTIONS),

  // --- warning-only targets (never payment-affecting) ---
  def("performanceTargets", "targets", "Performance targets (warning-only)", "array", "terms", terms("performanceTargets"), { explicitDecisionRequired: true, notApplicableValue: [] }),

  // --- admin / manual / derived ---
  def("onboardingProcessCompleted", "admin", "Onboarding process completed", "boolean", "terms", terms("admin", "onboardingProcessCompleted"), { extractable: false }),
  def("remarks", "admin", "Remarks (internal)", "text", "terms", terms("admin", "remarks"), { extractable: false }),
  // Derived from the confirmed commercial structure (deriveAgreementType); an extractor guess is never read.
  def("agreementType", "admin", "Agreement type (derived)", "enum", "terms", terms("agreementType"), { mode: "COMPUTED", extractable: false }),
];

export const AGREEMENT_FIELD_BY_KEY = Object.fromEntries(DEFS.map((field) => [field.key, field])) as Record<AgreementFieldKey, AgreementFieldDef>;
export const AGREEMENT_FIELDS: readonly AgreementFieldDef[] = AGREEMENT_FIELD_KEYS.map((key) => AGREEMENT_FIELD_BY_KEY[key]);

export function isIdentityValueField(key: AgreementFieldKey): boolean {
  return AGREEMENT_FIELD_BY_KEY[key].identityValue;
}
export function isDecidableField(key: AgreementFieldKey): boolean {
  return AGREEMENT_FIELD_BY_KEY[key].mode === "DECIDED";
}
export function fieldAppliesTo(key: AgreementFieldKey, counterpartyType: CounterpartyType): boolean {
  return AGREEMENT_FIELD_BY_KEY[key].appliesTo.includes(counterpartyType);
}

// --- Per-field value schemas (the shape of a draft entry's `value`) -----------------------------------------------------
// Identity VALUE fields accept null only: an identity value can never be stored
// in an Agreement doc.
const contactShape = contactSnapshotSchema.shape;
const commercialShape = commercialTermsSchema.shape;
const datesShape = agreementDatesSchema.shape;
const contractShape = contractTermsTextSchema.shape;
const platformShape = platformTermsSchema.shape;
const adminShape = adminTermsSchema.shape;

export const AGREEMENT_FIELD_VALUE_SCHEMAS: Record<AgreementFieldKey, z.ZodType> = {
  counterpartyName: contactShape.counterpartyName,
  contactNumber: contactShape.contactNumber.unwrap(),
  emailAddress: contactShape.emailAddress.unwrap(),
  state: contactShape.state.unwrap(),
  address: contactShape.address.unwrap(),
  pinCode: contactShape.pinCode.unwrap(),
  gstin: z.null(),
  aadhaarNumber: z.null(),
  aadhaarStatus: identityComponentStatusSchema,
  panNumber: z.null(),
  panHolderName: z.null(),
  bankAccountNumber: z.null(),
  ifsc: z.null(),
  aadhaarDocumentStatus: identityComponentStatusSchema,
  panDocumentStatus: identityComponentStatusSchema,
  gstCertificateStatus: identityComponentStatusSchema,
  partnerRef: z.string().min(1),
  partnerAccountRefs: z.array(z.string().min(1)).max(50),
  platforms: platformIdentifierArraySchema(MAX_AGREEMENT_PLATFORMS),
  collaboratorPageLink: platformShape.collaboratorPageLink.unwrap(),
  collaboratorPageName: platformShape.collaboratorPageName.unwrap(),
  agreementNumber: z.string().trim().min(1).max(100),
  signedDate: datesShape.signedDate.unwrap(),
  effectiveDate: datesShape.effectiveFrom,
  terminationDate: datesShape.effectiveTo.unwrap(),
  renewalTerms: contractShape.renewalTerms.unwrap(),
  noticeTerms: contractShape.noticeTerms.unwrap(),
  terminationTerms: contractShape.terminationTerms.unwrap(),
  currency: commercialShape.currency.unwrap(),
  paymentCycle: commercialShape.paymentCycle.unwrap(),
  fixedComponent: fixedComponentSchema,
  monthlyRequiredQualifyingContentCount: commercialShape.monthlyRequiredQualifyingContentCount.unwrap(),
  qualifyingUnit: commercialShape.qualifyingUnit.unwrap(),
  accountTransferFee: accountTransferFeeSchema,
  advancePayment: advancePaymentSchema,
  invoiceRequired: z.boolean(),
  invoiceDueTerms: commercialShape.invoiceDueTerms.unwrap(),
  paymentDueTerms: commercialShape.paymentDueTerms.unwrap(),
  servicesMandated: commercialShape.servicesMandated.unwrap(),
  incentive: incentiveSchema,
  lfcSfc: lfcSfcSchema,
  performanceTargets: performanceTargetsSchema,
  onboardingProcessCompleted: z.boolean(),
  remarks: adminShape.remarks.unwrap(),
  agreementType: agreementTypeSchema,
};

// --- Decision validation (used by decideField's input schema and service) ----------------------------------------------
export const AGREEMENT_FIELD_DECISIONS = ["ACCEPTED", "CORRECTED", "UNAVAILABLE", "NOT_APPLICABLE"] as const;
export type AgreementFieldDecisionKind = (typeof AGREEMENT_FIELD_DECISIONS)[number];

export type FieldDecisionCheck = { ok: true; value: unknown } | { ok: false; message: string };

// Pure. ACCEPTED keeps the entry's existing value (a supplied value, if any, is
// validated and used); CORRECTED needs a value; UNAVAILABLE / NOT_APPLICABLE
// carry none. Identity VALUE fields take a decision only (never a value) and
// can be neither corrected nor supplied here - identity values are corrected in
// the canonical restricted store. COMPUTED fields cannot be decided at all.
export function checkFieldDecisionValue(fieldKey: AgreementFieldKey, decision: AgreementFieldDecisionKind, value: unknown): FieldDecisionCheck {
  const field = AGREEMENT_FIELD_BY_KEY[fieldKey];
  if (field.mode !== "DECIDED") return { ok: false, message: `${field.label} is computed by the system and cannot be decided.` };

  const hasValue = value !== undefined && value !== null;
  if (field.identityValue) {
    if (decision === "CORRECTED") return { ok: false, message: `${field.label} cannot be corrected here; identity values live only in the restricted identity record.` };
    if (hasValue) return { ok: false, message: `${field.label} is restricted; no value may be supplied.` };
    return { ok: true, value: null };
  }
  if (decision === "UNAVAILABLE" || decision === "NOT_APPLICABLE") {
    return hasValue ? { ok: false, message: `A ${decision} decision carries no value.` } : { ok: true, value: null };
  }
  if (decision === "CORRECTED" && !hasValue) return { ok: false, message: "A corrected field needs a value." };
  if (!hasValue) return { ok: true, value: undefined };

  const parsed = AGREEMENT_FIELD_VALUE_SCHEMAS[fieldKey].safeParse(value);
  if (!parsed.success) return { ok: false, message: `Invalid value for ${field.label}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}` };
  return { ok: true, value: parsed.data };
}

// --- Confirm-time validators ---------------------------------------------------------------------------------------------
export type AgreementReadinessIssue = { code: string; message: string; fieldKey?: AgreementFieldKey };

export type AssembleConfirmedAgreementInput = {
  draft: AgreementDraft;
  counterpartyType: CounterpartyType;
  // Recorded on fields no one touched (implicit UNAVAILABLE) at confirmation.
  actorUserRef: string;
  confirmedAt: string;
};

export type AssembleConfirmedAgreementResult =
  | {
      ok: true;
      terms: ConfirmedAgreementTerms;
      contactSnapshot: ContactSnapshot;
      fieldProvenance: AgreementFieldProvenance;
      sourceMode: AgreementSourceMode;
      effective: { signedDate: string | null; effectiveFrom: string; effectiveTo: string | null };
    }
  | { ok: false; blockers: AgreementReadinessIssue[] };

type Resolved = { state: "value"; value: unknown } | { state: "unavailable" } | { state: "not_applicable" } | { state: "none" };

// The pure confirm gate + assembler. Checks, in order:
//   1. every draft entry for a field that does not apply to the counterparty type is rejected;
//   2. EVERY entry (extracted, master-data-prefilled or manual) is decided - PENDING blocks;
//   3. every explicitDecisionRequired field has an entry;
//   4. ACCEPTED/CORRECTED entries carry a value that matches the field's value schema
//      (identity VALUE fields carry none);
//   5. the assembled terms + contact snapshot parse against their strict schemas, which
//      enforces required-field completeness (counterparty name, effective date, currency
//      with any amount, required count <-> qualifying unit) and derives agreementType.
// A field no one touched and that needs no explicit decision is recorded as an implicit
// UNAVAILABLE (origin MANUAL) at confirmation. Never reads an extractor's agreement type.
export function assembleConfirmedAgreement(input: AssembleConfirmedAgreementInput): AssembleConfirmedAgreementResult {
  const blockers: AgreementReadinessIssue[] = [];
  const { draft, counterpartyType } = input;
  const resolved = new Map<AgreementFieldKey, Resolved>();

  for (const field of AGREEMENT_FIELDS) {
    const entry = draft[field.key];
    const applies = field.appliesTo.includes(counterpartyType);

    if (entry && !applies) {
      blockers.push({ code: "field_not_applicable", message: `${field.label} does not apply to a ${counterpartyType.toLowerCase()} agreement.`, fieldKey: field.key });
      continue;
    }
    if (field.mode === "COMPUTED" || !applies) continue;

    if (!entry) {
      if (field.explicitDecisionRequired) blockers.push({ code: "field_undecided", message: `${field.label} must be decided.`, fieldKey: field.key });
      resolved.set(field.key, { state: "none" });
      continue;
    }
    if (entry.decision === "PENDING") {
      blockers.push({ code: "field_pending", message: `${field.label} is awaiting a decision.`, fieldKey: field.key });
      continue;
    }
    if (entry.decision === "UNAVAILABLE") {
      resolved.set(field.key, { state: "unavailable" });
      continue;
    }
    if (entry.decision === "NOT_APPLICABLE") {
      resolved.set(field.key, { state: "not_applicable" });
      continue;
    }
    // ACCEPTED | CORRECTED
    if (field.identityValue) {
      resolved.set(field.key, { state: "none" });
      continue;
    }
    const parsed = AGREEMENT_FIELD_VALUE_SCHEMAS[field.key].safeParse(entry.value);
    if (entry.value === null || entry.value === undefined) {
      blockers.push({ code: "decision_without_value", message: `${field.label} was ${entry.decision.toLowerCase()} but has no value.`, fieldKey: field.key });
    } else if (!parsed.success) {
      blockers.push({ code: "value_invalid", message: `${field.label}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`, fieldKey: field.key });
    } else {
      resolved.set(field.key, { state: "value", value: parsed.data });
    }
  }

  // Only decidable, applicable, non-identity fields contribute values; everything else is null / not applicable.
  const pick = (key: AgreementFieldKey): unknown => {
    const item = resolved.get(key);
    if (item?.state === "value") return item.value;
    if (item?.state === "not_applicable") return AGREEMENT_FIELD_BY_KEY[key].notApplicableValue;
    return null;
  };
  const list = (key: AgreementFieldKey): unknown => pick(key) ?? [];

  const commercial = {
    currency: pick("currency"),
    paymentCycle: pick("paymentCycle"),
    fixedComponent: pick("fixedComponent"),
    monthlyRequiredQualifyingContentCount: pick("monthlyRequiredQualifyingContentCount"),
    qualifyingUnit: pick("qualifyingUnit"),
    accountTransferFee: pick("accountTransferFee"),
    advancePayment: pick("advancePayment"),
    invoiceRequired: pick("invoiceRequired"),
    invoiceDueTerms: pick("invoiceDueTerms"),
    paymentDueTerms: pick("paymentDueTerms"),
    servicesMandated: pick("servicesMandated"),
    incentive: pick("incentive"),
    lfcSfc: pick("lfcSfc"),
  };
  const commercialCheck = commercialTermsSchema.safeParse(commercial);
  const agreementType = commercialCheck.success ? deriveAgreementType({ commercial: commercialCheck.data }) : "UNSPECIFIED";

  const candidateTerms = {
    agreementNumber: pick("agreementNumber"),
    dates: { signedDate: pick("signedDate"), effectiveFrom: pick("effectiveDate"), effectiveTo: pick("terminationDate") },
    contractTerms: { renewalTerms: pick("renewalTerms"), noticeTerms: pick("noticeTerms"), terminationTerms: pick("terminationTerms") },
    platform: { platforms: list("platforms"), collaboratorPageLink: pick("collaboratorPageLink"), collaboratorPageName: pick("collaboratorPageName") },
    commercial,
    performanceTargets: list("performanceTargets"),
    admin: { onboardingProcessCompleted: pick("onboardingProcessCompleted"), remarks: pick("remarks") },
    agreementType,
  };
  const candidateContact = {
    counterpartyName: pick("counterpartyName"),
    contactNumber: pick("contactNumber"),
    emailAddress: pick("emailAddress"),
    state: pick("state"),
    address: pick("address"),
    pinCode: pick("pinCode"),
  };

  const termsResult = confirmedAgreementTermsSchema.safeParse(candidateTerms);
  const contactResult = contactSnapshotSchema.safeParse(candidateContact);
  const alreadyBlocked = new Set(blockers.map((blocker) => blocker.fieldKey).filter(Boolean));

  if (!termsResult.success) {
    for (const issue of termsResult.error.issues) {
      const fieldKey = fieldKeyForTermsPath(issue.path);
      if (fieldKey && alreadyBlocked.has(fieldKey)) continue;
      blockers.push({ code: fieldKey === "effectiveDate" || fieldKey === "counterpartyName" ? "required_field_missing" : "terms_invalid", message: `${issue.path.join(".") || "terms"}: ${issue.message}`, ...(fieldKey ? { fieldKey } : {}) });
    }
  }
  if (!contactResult.success) {
    for (const issue of contactResult.error.issues) {
      const fieldKey = (AGREEMENT_FIELDS.find((field) => field.target === "contactSnapshot" && field.path?.[0] === issue.path[0])?.key ?? undefined) as AgreementFieldKey | undefined;
      if (fieldKey && alreadyBlocked.has(fieldKey)) continue;
      blockers.push({ code: fieldKey === "counterpartyName" ? "required_field_missing" : "contact_invalid", message: `${issue.path.join(".") || "contact"}: ${issue.message}`, ...(fieldKey ? { fieldKey } : {}) });
    }
  }

  if (blockers.length > 0 || !termsResult.success || !contactResult.success) return { ok: false, blockers };

  const fieldProvenance = buildFieldProvenance(draft, counterpartyType, input.actorUserRef, input.confirmedAt);
  return {
    ok: true,
    terms: termsResult.data,
    contactSnapshot: contactResult.data,
    fieldProvenance,
    sourceMode: deriveSourceMode(fieldProvenance),
    effective: { signedDate: termsResult.data.dates.signedDate, effectiveFrom: termsResult.data.dates.effectiveFrom, effectiveTo: termsResult.data.dates.effectiveTo },
  };
}

function fieldKeyForTermsPath(path: ReadonlyArray<PropertyKey>): AgreementFieldKey | undefined {
  const wanted = path.map(String).join(".");
  return AGREEMENT_FIELDS.find((field) => field.target === "terms" && field.path && field.path.join(".") === wanted)?.key;
}

// Frozen per-field provenance for every decidable, applicable field: the entry's
// own decision/origin, or an implicit UNAVAILABLE recorded at confirmation.
function buildFieldProvenance(draft: AgreementDraft, counterpartyType: CounterpartyType, actorUserRef: string, confirmedAt: string): AgreementFieldProvenance {
  const out: AgreementFieldProvenance = {};
  for (const field of AGREEMENT_FIELDS) {
    if (field.mode !== "DECIDED" || !field.appliesTo.includes(counterpartyType)) continue;
    const entry = draft[field.key];
    out[field.key] = entry
      ? { origin: entry.origin, decision: entry.decision === "PENDING" ? "UNAVAILABLE" : entry.decision, decidedByUserRef: entry.decidedByUserRef, decidedAt: entry.decidedAt, provenance: entry.provenance }
      : { origin: "MANUAL", decision: "UNAVAILABLE", decidedByUserRef: actorUserRef, decidedAt: confirmedAt, provenance: { label: "Not provided (recorded at confirmation)", extractionRunRef: null, page: null, confidence: null } };
  }
  return out;
}

// sourceMode rule (from field ORIGINS, never from a claim):
//   E = fields ACCEPTED as extracted (origin EXTRACTED, decision ACCEPTED)
//   M = fields whose value a human supplied (decision CORRECTED, or origin MANUAL with
//       decision ACCEPTED/CORRECTED)
// Master-data prefills and implicit UNAVAILABLE fields count toward neither.
//   E = 0            -> MANUAL
//   E > 0 and M = 0  -> EXTRACTED
//   E > 0 and M > 0  -> MIXED
export function deriveSourceMode(provenance: AgreementFieldProvenance): AgreementSourceMode {
  let extracted = 0;
  let manual = 0;
  for (const entry of Object.values(provenance)) {
    if (!entry) continue;
    if (entry.origin === "EXTRACTED" && entry.decision === "ACCEPTED") extracted += 1;
    else if (entry.decision === "CORRECTED" || (entry.origin === "MANUAL" && entry.decision === "ACCEPTED")) manual += 1;
  }
  if (extracted === 0) return "MANUAL";
  return manual === 0 ? "EXTRACTED" : "MIXED";
}

// Standalone shape validators (also used by services that build the snapshots outside confirm).
export function validateContactSnapshot(value: unknown): { ok: true; value: ContactSnapshot } | { ok: false; issues: string[] } {
  const parsed = contactSnapshotSchema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
}

// RULE for the identity STATE from component presence (status only, no values):
//   required components: pan + bank, gst when it applies (a NOT_APPLICABLE gst is not required);
//   aadhaar is tracked (Partner only) but never required for AVAILABLE.
//   all required PRESENT -> AVAILABLE; none PRESENT and none INCOMPLETE -> MISSING; otherwise INCOMPLETE.
// A component-level INCOMPLETE (document on file, details not entered) never counts as PRESENT: it blocks AVAILABLE, and it makes the
// state INCOMPLETE even when nothing else is present (something is on file, so the record is not simply missing).
// (UNAVAILABLE - the store could not be read - and RESTRICTED - the viewer lacks the
// identity category - are set by callers, never derived here.)
export function deriveIdentityStatusState(components: IdentityComponents): Exclude<IdentityStatusState, "UNAVAILABLE"> {
  const required = [components.pan, components.bank, ...(components.gst === "NOT_APPLICABLE" ? [] : [components.gst])];
  const present = required.filter((status) => status === "PRESENT").length;
  if (present === required.length) return "AVAILABLE";
  const partial = required.some((status) => status === "INCOMPLETE");
  return present === 0 && !partial ? "MISSING" : "INCOMPLETE";
}

// Shape + consistency check of an identity STATUS snapshot: a Vendor has no Aadhaar
// (NOT_APPLICABLE), and a stored state must agree with its components.
export function validateIdentityStatusShape(counterpartyType: CounterpartyType, snapshot: { state: IdentityStatusState; components: IdentityComponents }): string[] {
  const issues: string[] = [];
  if (counterpartyType === "VENDOR" && snapshot.components.aadhaar !== "NOT_APPLICABLE") issues.push("A vendor has no Aadhaar component (expected NOT_APPLICABLE).");
  if (snapshot.state !== "UNAVAILABLE" && snapshot.state !== deriveIdentityStatusState(snapshot.components)) issues.push("The identity status state disagrees with its components.");
  return issues;
}

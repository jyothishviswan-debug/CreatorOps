import { describe, expect, it } from "vitest";

import type { ReconciliationFieldEntry } from "./agreement-draft";
import { redactAgreementEventMetadata } from "./agreement-events";
import type { AgreementFieldKey } from "./fields";
import {
  canonicalSideFor,
  compareField,
  MASTER_DATA_UPDATABLE_FIELD_KEYS,
  normalizeAadhaar,
  normalizeEmail,
  normalizeIdentityCode,
  normalizeName,
  normalizePageLink,
  normalizePhone,
  normalizeState,
  RECONCILIATION_FIELD_KEYS,
  RECONCILIATION_STATES,
  reconcileFields,
  summarizeReconciliation,
  type AgreementSide,
  type CanonicalSide,
  type CanonicalSnapshot,
  type ComparisonPermissions,
  type ReconcileInput,
} from "./reconciliation-compare";
import type { AgreementEntryDecision } from "./types";

// Step 14A: the PURE reconciliation comparison. Every state, every action rule and the normalization
// are proven here with no Firestore. All values are invented.

const ALL_PERMS: ComparisonPermissions = { resolveInAgreement: true, masterDataWritable: true };
const NO_PERMS: ComparisonPermissions = { resolveInAgreement: false, masterDataWritable: false };

const side = (over: Partial<AgreementSide> = {}): AgreementSide => ({ decision: "PENDING", origin: "EXTRACTED", value: null, extractedValue: null, provenance: { label: "Extracted from contract", confidence: "MEDIUM", page: 2 }, ...over });
const values = (...list: string[]): CanonicalSide => ({ kind: "values", values: list });

function compare(fieldKey: AgreementFieldKey, canonical: CanonicalSide, agreement: AgreementSide, extra: { permissions?: ComparisonPermissions; counterpartyType?: "PARTNER" | "VENDOR"; identityBlocked?: boolean } = {}) {
  return compareField({ fieldKey, counterpartyType: extra.counterpartyType ?? "PARTNER", identityBlocked: extra.identityBlocked ?? false, canonical, agreement, permissions: extra.permissions ?? ALL_PERMS });
}

describe("normalization (compare-only)", () => {
  it("phone: digits only; +91 / 91 / 0 prefixes do not make numbers differ", () => {
    for (const variant of ["+91 98765 43210", "91-9876543210", "098765 43210", "9876543210", "(+91) 9876543210", "0919876543210"]) expect(normalizePhone(variant), variant).toBe("9876543210");
    expect(normalizePhone("98765 43211")).not.toBe(normalizePhone("9876543210"));
    expect(normalizePhone("n/a")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });

  it("email: trimmed and case-insensitive", () => {
    expect(normalizeEmail("  Jane.Doe@Example.TEST ")).toBe("jane.doe@example.test");
    expect(normalizeEmail("   ")).toBeNull();
  });

  it("name: case, punctuation, spacing, & / and, pvt / ltd abbreviations", () => {
    expect(normalizeName("Acme  Talent Pvt. Ltd.")).toBe(normalizeName("ACME TALENT PRIVATE LIMITED"));
    expect(normalizeName("Smith & Sons")).toBe(normalizeName("smith and sons"));
    expect(normalizeName("Acme Talent")).not.toBe(normalizeName("Acme Talents"));
    expect(normalizeName("...")).toBeNull();
  });

  it("state: case and punctuation", () => {
    expect(normalizeState(" Tamil  Nadu ")).toBe("tamil nadu");
    expect(normalizeState("Jammu & Kashmir")).toBe(normalizeState("jammu kashmir"));
  });

  it("PAN / GSTIN / IFSC / bank account: uppercase, alphanumerics only", () => {
    expect(normalizeIdentityCode("abcde 1234-f")).toBe("ABCDE1234F");
    expect(normalizeIdentityCode(" 0012 3456 7890 ")).toBe("001234567890");
    expect(normalizeIdentityCode("--")).toBeNull();
  });

  it("aadhaar: exactly 12 digits (spaces / dashes ignored); a masked value is not comparable", () => {
    expect(normalizeAadhaar("2341 2341 2346")).toBe("234123412346");
    expect(normalizeAadhaar("2341-2341-2346")).toBe("234123412346");
    expect(normalizeAadhaar("XXXXXXXX2346")).toBeNull();
    expect(normalizeAadhaar("12345")).toBeNull();
  });

  it("page link: scheme, www. and trailing slash do not matter", () => {
    expect(normalizePageLink("https://www.Instagram.com/acme/")).toBe(normalizePageLink("instagram.com/acme"));
    expect(normalizePageLink("https://instagram.com/acme")).not.toBe(normalizePageLink("https://instagram.com/acme2"));
  });
});

describe("canonicalSideFor", () => {
  const snapshot = (over: Partial<CanonicalSnapshot> = {}): CanonicalSnapshot => ({
    counterpartyType: "PARTNER",
    legalName: "Acme Talent Private Limited",
    displayName: "Acme",
    email: "acme@example.test",
    phone: "+91 90000 00000",
    regionIds: ["Karnataka", "Kerala"],
    accounts: [{ platform: "instagram", profileUrl: "https://instagram.com/acme", displayName: "Acme Page", handle: "acme" }],
    identity: { pan: "ABCDE1234F", aadhaar: "234123412346", gst: { applicable: true, number: "29ABCDE1234F1Z5" }, bankAccountNo: "998877665544", bankIfscCode: "TEST0001234" },
    ...over,
  });

  it("maps every canonical home", () => {
    const s = snapshot();
    expect(canonicalSideFor("counterpartyName", s)).toEqual({ kind: "values", values: ["Acme Talent Private Limited", "Acme"] });
    expect(canonicalSideFor("emailAddress", s)).toEqual({ kind: "values", values: ["acme@example.test"] });
    expect(canonicalSideFor("contactNumber", s)).toEqual({ kind: "values", values: ["+91 90000 00000"] });
    expect(canonicalSideFor("state", s)).toEqual({ kind: "values", values: ["Karnataka", "Kerala"] });
    expect(canonicalSideFor("platforms", s)).toEqual({ kind: "values", values: ["instagram"] });
    expect(canonicalSideFor("collaboratorPageLink", s)).toEqual({ kind: "values", values: ["https://instagram.com/acme"] });
    expect(canonicalSideFor("collaboratorPageName", s)).toEqual({ kind: "values", values: ["Acme Page"] });
    expect(canonicalSideFor("panNumber", s)).toEqual({ kind: "values", values: ["ABCDE1234F"] });
    expect(canonicalSideFor("aadhaarNumber", s)).toEqual({ kind: "values", values: ["234123412346"] });
    expect(canonicalSideFor("gstin", s)).toEqual({ kind: "values", values: ["29ABCDE1234F1Z5"] });
    expect(canonicalSideFor("bankAccountNumber", s)).toEqual({ kind: "values", values: ["998877665544"] });
    expect(canonicalSideFor("ifsc", s)).toEqual({ kind: "values", values: ["TEST0001234"] });
  });

  it("address, PIN and PAN holder name have NO canonical home - never invented", () => {
    for (const key of ["address", "pinCode", "panHolderName"] as const) expect(canonicalSideFor(key, snapshot())).toEqual({ kind: "no_canonical_field" });
  });

  it("blank values are empty; a GST declared not applicable is its own kind; an unloaded / unreadable store is unreadable", () => {
    const empty = snapshot({ email: "  ", phone: null, regionIds: [], legalName: null, identity: { pan: null, aadhaar: null, gst: null, bankAccountNo: null, bankIfscCode: null } });
    expect(canonicalSideFor("emailAddress", empty)).toEqual({ kind: "empty" });
    expect(canonicalSideFor("contactNumber", empty)).toEqual({ kind: "empty" });
    expect(canonicalSideFor("state", empty)).toEqual({ kind: "empty" });
    expect(canonicalSideFor("counterpartyName", empty)).toEqual({ kind: "values", values: ["Acme"] });
    expect(canonicalSideFor("panNumber", empty)).toEqual({ kind: "empty" });
    expect(canonicalSideFor("gstin", empty)).toEqual({ kind: "empty" });
    expect(canonicalSideFor("gstin", snapshot({ identity: { pan: null, aadhaar: null, gst: { applicable: false, number: null }, bankAccountNo: null, bankIfscCode: null } }))).toEqual({ kind: "declared_not_applicable" });
    expect(canonicalSideFor("panNumber", snapshot({ identity: "unreadable" }))).toEqual({ kind: "unreadable" });
    expect(canonicalSideFor("panNumber", snapshot({ identity: null }))).toEqual({ kind: "unreadable" });
  });

  it("a Vendor has no Partner Accounts: platform / page fields have no canonical home", () => {
    const vendor = snapshot({ counterpartyType: "VENDOR", accounts: null });
    for (const key of ["platforms", "collaboratorPageLink", "collaboratorPageName"] as const) expect(canonicalSideFor(key, vendor)).toEqual({ kind: "no_canonical_field" });
  });
});

describe("compareField: every state", () => {
  it("MATCH: normalized-equal values (phone formats, email case, name variants, state among regions, page links, platform sets)", () => {
    expect(compare("contactNumber", values("+91 98765 43210"), side({ value: "9876543210" })).state).toBe("MATCH");
    expect(compare("emailAddress", values("Jane@Example.test"), side({ value: "jane@example.test" })).state).toBe("MATCH");
    expect(compare("counterpartyName", values("Acme Talent Private Limited", "Acme"), side({ value: "Acme Talent Pvt Ltd" })).state).toBe("MATCH");
    expect(compare("counterpartyName", values("Acme Talent Private Limited", "Acme"), side({ value: "ACME" })).state).toBe("MATCH");
    expect(compare("state", values("Karnataka", "Kerala"), side({ value: "kerala" })).state).toBe("MATCH");
    expect(compare("collaboratorPageLink", values("https://www.instagram.com/acme/"), side({ value: "instagram.com/acme" })).state).toBe("MATCH");
    expect(compare("platforms", values("instagram", "youtube"), side({ value: ["YouTube", "instagram"] })).state).toBe("MATCH");
    expect(compare("panNumber", values("ABCDE1234F"), side({ value: "abcde1234f" })).state).toBe("MATCH");
    expect(compare("bankAccountNumber", values("998877665544"), side({ value: "9988 7766 5544" })).state).toBe("MATCH");
    expect(compare("aadhaarNumber", values("234123412346"), side({ value: "2341 2341 2346" })).state).toBe("MATCH");
  });

  it("a MATCH still lists no action and exposes both values", () => {
    const result = compare("emailAddress", values("a@example.test"), side({ value: "a@example.test", extractedValue: "a@example.test" }));
    expect(result).toMatchObject({ state: "MATCH", canonicalValue: "a@example.test", extractedValue: "a@example.test", allowedActions: [] });
  });

  it("MISSING_IN_CREATOROPS: the Agreement has a value, CreatorOps is empty; UPDATE is offered only for an allowlisted field, once DECIDED, to an actor the OWNING module permits", () => {
    const decided = side({ decision: "ACCEPTED", value: "new@example.test" });
    expect(compare("emailAddress", { kind: "empty" }, decided)).toMatchObject({ state: "MISSING_IN_CREATOROPS", allowedActions: ["UPDATE_MASTER_DATA_FROM_AGREEMENT"] });
    expect(compare("emailAddress", { kind: "empty" }, side({ decision: "CORRECTED", value: "new@example.test" })).allowedActions).toEqual(["UPDATE_MASTER_DATA_FROM_AGREEMENT"]);
    // still a proposal (PENDING) -> state reported, no action yet
    expect(compare("emailAddress", { kind: "empty" }, side({ decision: "PENDING", value: "new@example.test" }))).toMatchObject({ state: "MISSING_IN_CREATOROPS", allowedActions: [] });
    // the owning module denies -> state kept, no master-data action
    expect(compare("emailAddress", { kind: "empty" }, decided, { permissions: { resolveInAgreement: true, masterDataWritable: false } })).toMatchObject({ state: "MISSING_IN_CREATOROPS", allowedActions: [] });
    // a field outside the allowlist never gets a master-data action (state has no command)
    expect(compare("state", { kind: "empty" }, side({ decision: "ACCEPTED", value: "Kerala" }))).toMatchObject({ state: "MISSING_IN_CREATOROPS", allowedActions: [] });
    expect(compare("collaboratorPageLink", { kind: "empty" }, side({ decision: "ACCEPTED", value: "instagram.com/x" })).allowedActions).toEqual([]);
    // bank is deliberately not updatable
    expect(compare("bankAccountNumber", { kind: "empty" }, side({ decision: "ACCEPTED", value: "998877665544" })).allowedActions).toEqual([]);
  });

  it("MISSING_IN_AGREEMENT: CreatorOps has a value, the Agreement does not (unset, empty, or decided UNAVAILABLE)", () => {
    expect(compare("emailAddress", values("a@example.test"), side({ decision: null, origin: null, provenance: null })).state).toBe("MISSING_IN_AGREEMENT");
    expect(compare("emailAddress", values("a@example.test"), side({ decision: "PENDING", value: "   " })).state).toBe("MISSING_IN_AGREEMENT");
    const unavailable = compare("emailAddress", values("a@example.test"), side({ decision: "UNAVAILABLE", value: null, extractedValue: "x@example.test" }));
    expect(unavailable).toMatchObject({ state: "MISSING_IN_AGREEMENT", canonicalValue: "a@example.test", allowedActions: [] });
  });

  it("MISMATCH: lists the deliberate resolutions - and only the master-data one the actor may use", () => {
    const decided = side({ decision: "ACCEPTED", value: "other@example.test" });
    expect(compare("emailAddress", values("a@example.test"), decided).allowedActions).toEqual(["KEEP_CREATOROPS_VALUE", "USE_AGREEMENT_VALUE_IN_AGREEMENT_ONLY", "OVERWRITE_MASTER_DATA_WITH_AGREEMENT_VALUE"]);
    // owning module denies: state stays MISMATCH, no master-data action
    const denied = compare("emailAddress", values("a@example.test"), decided, { permissions: { resolveInAgreement: true, masterDataWritable: false } });
    expect(denied.state).toBe("MISMATCH");
    expect(denied.allowedActions).toEqual(["KEEP_CREATOROPS_VALUE", "USE_AGREEMENT_VALUE_IN_AGREEMENT_ONLY"]);
    // frozen (confirmed) version: the Agreement cannot be re-resolved, master data still can be deliberately corrected
    expect(compare("emailAddress", values("a@example.test"), decided, { permissions: { resolveInAgreement: false, masterDataWritable: true } }).allowedActions).toEqual(["OVERWRITE_MASTER_DATA_WITH_AGREEMENT_VALUE"]);
    // pending proposal: no overwrite until decided
    expect(compare("emailAddress", values("a@example.test"), side({ decision: "PENDING", value: "other@example.test" })).allowedActions).toEqual(["KEEP_CREATOROPS_VALUE", "USE_AGREEMENT_VALUE_IN_AGREEMENT_ONLY"]);
    // no permissions at all: state only
    expect(compare("emailAddress", values("a@example.test"), decided, { permissions: NO_PERMS })).toMatchObject({ state: "MISMATCH", allowedActions: [] });
    // a non-allowlisted field never offers an overwrite
    expect(compare("counterpartyName", values("Acme"), side({ decision: "ACCEPTED", value: "Other Name" })).allowedActions).toEqual(["KEEP_CREATOROPS_VALUE", "USE_AGREEMENT_VALUE_IN_AGREEMENT_ONLY"]);
    // a platform set that differs is a mismatch (set equality)
    expect(compare("platforms", values("instagram", "youtube"), side({ value: ["instagram"] })).state).toBe("MISMATCH");
    // state not among the regions
    expect(compare("state", values("Karnataka"), side({ value: "Kerala" })).state).toBe("MISMATCH");
  });

  it("MISMATCH also when CreatorOps declared the component not applicable and the Agreement carries a value", () => {
    const result = compare("gstin", { kind: "declared_not_applicable" }, side({ decision: "ACCEPTED", value: "29ABCDE1234F1Z5" }));
    expect(result).toMatchObject({ state: "MISMATCH", reason: "canonical_declares_not_applicable" });
    expect(result.allowedActions).toContain("OVERWRITE_MASTER_DATA_WITH_AGREEMENT_VALUE");
  });

  it("NOT_APPLICABLE: a Vendor Aadhaar, an Agreement decision of NOT_APPLICABLE, or a canonical declaration with nothing on the Agreement", () => {
    expect(compare("aadhaarNumber", { kind: "empty" }, side({ value: "234123412346" }), { counterpartyType: "VENDOR" })).toMatchObject({ state: "NOT_APPLICABLE", reason: "not_applicable_to_counterparty", allowedActions: [] });
    expect(compare("emailAddress", values("a@example.test"), side({ decision: "NOT_APPLICABLE" }))).toMatchObject({ state: "NOT_APPLICABLE", reason: "decided_not_applicable", allowedActions: [] });
    expect(compare("gstin", { kind: "declared_not_applicable" }, side({ decision: null, origin: null, provenance: null }))).toMatchObject({ state: "NOT_APPLICABLE", reason: "canonical_declares_not_applicable" });
  });

  it("UNAVAILABLE: no canonical home (address / PIN / PAN holder name / Vendor platform) keeps the Agreement's own value visible", () => {
    const address = compare("address", { kind: "no_canonical_field" }, side({ decision: "ACCEPTED", value: "12 Some Road, Bengaluru" }));
    expect(address).toMatchObject({ state: "UNAVAILABLE", reason: "no_canonical_field", confirmedValue: "12 Some Road, Bengaluru", allowedActions: [] });
    expect(address.canonicalValue).toBeUndefined();
    expect(compare("pinCode", canonicalSideFor("pinCode", { counterpartyType: "PARTNER", legalName: null, displayName: "A", email: null, phone: null, regionIds: [], accounts: [], identity: null }), side({ value: "560001" })).reason).toBe("no_canonical_field");
    expect(compare("platforms", { kind: "no_canonical_field" }, side({ value: ["instagram"] }), { counterpartyType: "VENDOR" }).state).toBe("UNAVAILABLE");
  });

  it("UNAVAILABLE: an unreadable canonical store, an agreement value that cannot be compared (masked Aadhaar), nothing on either side", () => {
    expect(compare("panNumber", { kind: "unreadable" }, side({ value: "ABCDE1234F" }))).toMatchObject({ state: "UNAVAILABLE", reason: "canonical_unreadable" });
    expect(compare("aadhaarNumber", values("234123412346"), side({ decision: "ACCEPTED", value: "XXXXXXXX2346" }))).toMatchObject({ state: "UNAVAILABLE", reason: "agreement_value_not_comparable", allowedActions: [] });
    expect(compare("contactNumber", values("n/a"), side({ value: "9876543210" }))).toMatchObject({ state: "UNAVAILABLE", reason: "canonical_value_not_comparable" });
    expect(compare("emailAddress", { kind: "empty" }, side({ decision: null, origin: null, provenance: null }))).toMatchObject({ state: "UNAVAILABLE", reason: "nothing_to_compare" });
    expect(compare("emailAddress", { kind: "empty" }, side({ decision: "UNAVAILABLE" }))).toMatchObject({ state: "UNAVAILABLE", reason: "nothing_to_compare" });
  });

  it("RESTRICTED: an identity field the actor may not see carries NO value, NO result, NO action - whatever the data", () => {
    const outcomes = [
      compare("panNumber", values("ABCDE1234F"), side({ decision: "ACCEPTED", value: "ABCDE1234F", extractedValue: "ABCDE1234F" }), { identityBlocked: true }), // would be MATCH
      compare("panNumber", values("ABCDE1234F"), side({ decision: "ACCEPTED", value: "ZZZZZ9999Z" }), { identityBlocked: true }), // would be MISMATCH
      compare("panNumber", { kind: "empty" }, side({ decision: "ACCEPTED", value: "ABCDE1234F" }), { identityBlocked: true }), // would be MISSING_IN_CREATOROPS
      compare("panNumber", { kind: "unreadable" }, side({ decision: null }), { identityBlocked: true }), // would be UNAVAILABLE
      compare("panNumber", values("ABCDE1234F"), side({ decision: "NOT_APPLICABLE" }), { identityBlocked: true }), // would be NOT_APPLICABLE
    ];
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ fieldKey: "panNumber", label: "PAN number", group: "identity", state: "RESTRICTED", reason: "identity_access_required", source: { canonical: null, agreement: null }, allowedActions: [] });
    }
    // every identity VALUE field is covered by the same rule (a Vendor Aadhaar is N/A by type, not restricted)
    for (const key of ["gstin", "aadhaarNumber", "panNumber", "panHolderName", "bankAccountNumber", "ifsc"] as const) {
      expect(compare(key, values("SECRET-VALUE-123"), side({ value: "SECRET-VALUE-123" }), { identityBlocked: true }).state).toBe("RESTRICTED");
    }
  });

  it("ordinary (non-identity) fields are never RESTRICTED", () => {
    expect(compare("emailAddress", values("a@example.test"), side({ value: "a@example.test" }), { identityBlocked: true }).state).toBe("MATCH");
  });

  it("the DTO carries provenance: canonical source label and agreement origin / confidence / page", () => {
    const result = compare("emailAddress", values("a@example.test"), side({ value: "a@example.test", origin: "EXTRACTED", provenance: { label: "Extracted from contract (parser x)", confidence: "HIGH", page: 3 } }));
    expect(result.source).toEqual({ canonical: "CreatorOps master data", agreement: { label: "Extracted from contract (parser x)", origin: "EXTRACTED", confidence: "HIGH", page: 3 } });
    expect(compare("panNumber", values("ABCDE1234F"), side({ value: "ABCDE1234F" })).source.canonical).toBe("CreatorOps restricted identity record");
    expect(compare("platforms", values("instagram"), side({ value: ["instagram"] })).source.canonical).toBe("CreatorOps Partner Accounts");
  });

  it("confirmedValue is the DECIDED value only; extractedValue keeps the extractor's own proposal beside a correction", () => {
    const corrected = compare("emailAddress", values("a@example.test"), side({ decision: "CORRECTED", value: "fixed@example.test", extractedValue: "raw@example.test" }));
    expect(corrected).toMatchObject({ confirmedValue: "fixed@example.test", extractedValue: "raw@example.test", agreementDecision: "CORRECTED" });
    const pending = compare("emailAddress", values("a@example.test"), side({ decision: "PENDING", value: "raw@example.test", extractedValue: "raw@example.test" }));
    expect(pending.confirmedValue).toBeUndefined();
    expect(pending.extractedValue).toBe("raw@example.test");
  });

  it("the action ids are exactly the four specified ones", () => {
    const seen = new Set<string>();
    for (const perms of [ALL_PERMS, NO_PERMS, { resolveInAgreement: true, masterDataWritable: false }, { resolveInAgreement: false, masterDataWritable: true }]) {
      for (const canonical of [values("a@example.test"), { kind: "empty" } as CanonicalSide]) {
        for (const decision of ["PENDING", "ACCEPTED", "CORRECTED"] as AgreementEntryDecision[]) compare("emailAddress", canonical, side({ decision, value: "z@example.test" }), { permissions: perms }).allowedActions.forEach((action) => seen.add(action));
      }
    }
    expect([...seen].sort()).toEqual(["KEEP_CREATOROPS_VALUE", "OVERWRITE_MASTER_DATA_WITH_AGREEMENT_VALUE", "UPDATE_MASTER_DATA_FROM_AGREEMENT", "USE_AGREEMENT_VALUE_IN_AGREEMENT_ONLY"]);
  });

  it("the master-data allowlist is exactly email, phone and the PAN / Aadhaar / GST components", () => {
    expect([...MASTER_DATA_UPDATABLE_FIELD_KEYS].sort()).toEqual(["aadhaarNumber", "contactNumber", "emailAddress", "gstin", "panNumber"]);
  });
});

describe("reconcileFields (whole Agreement)", () => {
  const entry = (fieldKey: AgreementFieldKey, over: Partial<ReconciliationFieldEntry> = {}): ReconciliationFieldEntry => ({
    fieldKey,
    restricted: false,
    value: null,
    origin: "EXTRACTED",
    decision: "PENDING",
    extractedValue: null,
    provenance: { label: "Extracted from contract", extractionRunRef: "run_x", page: 1, confidence: "MEDIUM" },
    ...over,
  });

  const canonical: CanonicalSnapshot = {
    counterpartyType: "PARTNER",
    legalName: "Acme Talent Private Limited",
    displayName: "Acme",
    email: "acme@example.test",
    phone: null,
    regionIds: ["Karnataka"],
    accounts: [{ platform: "instagram", profileUrl: null, displayName: null, handle: "acme" }],
    identity: { pan: "ABCDE1234F", aadhaar: null, gst: null, bankAccountNo: "998877665544", bankIfscCode: "TEST0001234" },
  };

  const base: ReconcileInput = {
    counterpartyType: "PARTNER",
    identityVisible: true,
    canManageAgreements: true,
    versionOpen: true,
    ownerMayEditContact: true,
    ownerMayManageIdentity: true,
    canonical,
    entries: [
      entry("counterpartyName", { value: "Acme Talent Pvt Ltd", decision: "ACCEPTED" }),
      entry("contactNumber", { value: "+919876543210", decision: "ACCEPTED" }),
      entry("emailAddress", { value: "different@example.test", decision: "ACCEPTED" }),
      entry("address", { value: "1 Road", decision: "ACCEPTED" }),
      entry("panNumber", { decision: "ACCEPTED", restricted: true }),
    ],
    restrictedExtracted: { panNumber: "ABCDE1234F", gstin: "29ABCDE1234F1Z5", ifsc: "TEST0001234", panHolderName: "Someone Holder" },
  };

  it("reports one result per reconcilable field, in registry order", () => {
    const result = reconcileFields(base);
    expect(result.map((field) => field.fieldKey)).toEqual([...RECONCILIATION_FIELD_KEYS]);
    const state = Object.fromEntries(result.map((field) => [field.fieldKey, field.state]));
    expect(state).toMatchObject({
      counterpartyName: "MATCH",
      contactNumber: "MISSING_IN_CREATOROPS",
      emailAddress: "MISMATCH",
      state: "MISSING_IN_AGREEMENT",
      address: "UNAVAILABLE",
      pinCode: "UNAVAILABLE",
      panNumber: "MATCH",
      panHolderName: "UNAVAILABLE",
      gstin: "MISSING_IN_CREATOROPS",
      aadhaarNumber: "UNAVAILABLE",
      bankAccountNumber: "MISSING_IN_AGREEMENT",
      ifsc: "MATCH",
      platforms: "MISSING_IN_AGREEMENT",
    });
    expect(summarizeReconciliation(result).MATCH).toBe(3);
    expect(Object.keys(summarizeReconciliation(result)).sort()).toEqual([...RECONCILIATION_STATES].sort());
  });

  it("the identity GSTIN proposal is offered UPDATE only after it is decided (ACCEPTED acknowledgement)", () => {
    const undecided = reconcileFields(base).find((field) => field.fieldKey === "gstin")!;
    expect(undecided.allowedActions).toEqual([]);
    const decided = reconcileFields({ ...base, entries: [...base.entries, entry("gstin", { decision: "ACCEPTED", restricted: true })] }).find((field) => field.fieldKey === "gstin")!;
    expect(decided).toMatchObject({ state: "MISSING_IN_CREATOROPS", allowedActions: ["UPDATE_MASTER_DATA_FROM_AGREEMENT"] });
    const ownerDenied = reconcileFields({ ...base, ownerMayManageIdentity: false, entries: [...base.entries, entry("gstin", { decision: "ACCEPTED", restricted: true })] }).find((field) => field.fieldKey === "gstin")!;
    expect(ownerDenied).toMatchObject({ state: "MISSING_IN_CREATOROPS", allowedActions: [] });
  });

  it("contact actions follow the OWNING edit permission; a confirmed (not open) version offers only master-data actions", () => {
    const find = (input: ReconcileInput, key: AgreementFieldKey) => reconcileFields(input).find((field) => field.fieldKey === key)!;
    expect(find(base, "emailAddress").allowedActions).toContain("OVERWRITE_MASTER_DATA_WITH_AGREEMENT_VALUE");
    expect(find({ ...base, ownerMayEditContact: false }, "emailAddress")).toMatchObject({ state: "MISMATCH", allowedActions: ["KEEP_CREATOROPS_VALUE", "USE_AGREEMENT_VALUE_IN_AGREEMENT_ONLY"] });
    expect(find({ ...base, canManageAgreements: false }, "emailAddress")).toMatchObject({ state: "MISMATCH", allowedActions: [] });
    expect(find({ ...base, versionOpen: false }, "emailAddress").allowedActions).toEqual(["OVERWRITE_MASTER_DATA_WITH_AGREEMENT_VALUE"]);
    expect(find(base, "contactNumber").allowedActions).toEqual(["UPDATE_MASTER_DATA_FROM_AGREEMENT"]);
  });

  it("without identityVisible EVERY identity field is RESTRICTED, and nothing of the restricted / canonical identity values reaches the DTO", () => {
    const result = reconcileFields({ ...base, identityVisible: false, ownerMayManageIdentity: false });
    for (const key of ["gstin", "aadhaarNumber", "panNumber", "panHolderName", "bankAccountNumber", "ifsc"] as const) {
      expect(result.find((field) => field.fieldKey === key)).toMatchObject({ state: "RESTRICTED", allowedActions: [] });
    }
    // extracted values supplied by mistake are ignored entirely when identity is not visible
    const json = JSON.stringify(reconcileFields({ ...base, identityVisible: false }));
    for (const secret of ["ABCDE1234F", "29ABCDE1234F1Z5", "TEST0001234", "998877665544", "Someone Holder"]) expect(json).not.toContain(secret);
    // ordinary fields are still compared
    expect(result.find((field) => field.fieldKey === "emailAddress")!.state).toBe("MISMATCH");
  });

  it("a Vendor: no Aadhaar (NOT_APPLICABLE), no Partner Accounts (platform fields UNAVAILABLE)", () => {
    const vendor = reconcileFields({ ...base, counterpartyType: "VENDOR", canonical: { ...canonical, counterpartyType: "VENDOR", accounts: null, identity: { ...(canonical.identity as object), aadhaar: null } as CanonicalSnapshot["identity"] } });
    const find = (key: AgreementFieldKey) => vendor.find((field) => field.fieldKey === key)!;
    expect(find("aadhaarNumber")).toMatchObject({ state: "NOT_APPLICABLE", reason: "not_applicable_to_counterparty" });
    for (const key of ["platforms", "collaboratorPageLink", "collaboratorPageName"] as const) expect(find(key)).toMatchObject({ state: "UNAVAILABLE", reason: "no_canonical_field" });
  });

  it("an unreadable canonical identity store is UNAVAILABLE, never MISSING", () => {
    const result = reconcileFields({ ...base, canonical: { ...canonical, identity: "unreadable" } });
    for (const key of ["gstin", "aadhaarNumber", "panNumber", "bankAccountNumber", "ifsc"] as const) expect(result.find((field) => field.fieldKey === key)).toMatchObject({ state: "UNAVAILABLE", reason: "canonical_unreadable" });
  });

  it("is a pure function: same input, same output, input untouched", () => {
    const snapshot = JSON.stringify(base);
    expect(reconcileFields(base)).toEqual(reconcileFields(base));
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe("audit event allowlist for the master-data commands", () => {
  it("keeps component NAMES, mode, counterpartyType, fieldKey, resolutionAcknowledged and a safe reason - and drops any value", () => {
    const kept = redactAgreementEventMetadata({
      components: ["pan", "gst"],
      mode: "OVERWRITE_MISMATCH",
      counterpartyType: "VENDOR",
      fieldKey: "emailAddress",
      resolutionAcknowledged: true,
      reason: "Contract confirmed by the counterparty",
      pan: "ABCDE1234F",
      value: "a@example.test",
      email: "a@example.test",
    });
    expect(kept).toEqual({ components: ["pan", "gst"], mode: "OVERWRITE_MISMATCH", counterpartyType: "VENDOR", fieldKey: "emailAddress", resolutionAcknowledged: true, reason: "Contract confirmed by the counterparty" });
  });

  it("drops a components list that is empty, has duplicates, or names anything but the four components", () => {
    for (const bad of [[], ["pan", "pan"], ["pan", "ABCDE1234F"], "pan", ["pan", "aadhaar", "gst", "bank", "extra"], [1]]) expect(redactAgreementEventMetadata({ components: bad })).toBeNull();
  });

  it("a reason that looks like an identity value, email or amount is dropped rather than recorded", () => {
    for (const reason of ["value was ABCDE1234F", "email a@example.test confirmed", "paid 50000 rupees"]) expect(redactAgreementEventMetadata({ reason })).toBeNull();
  });
});

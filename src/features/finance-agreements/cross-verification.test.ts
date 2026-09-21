import { describe, expect, it } from "vitest";

import { MASTER_DATA_UPDATABLE_FIELD_KEYS, RECONCILIATION_STATES, type FieldReconciliationDto } from "@/server/finance-agreements/reconciliation-compare";
import type { AgreementReconciliationDto } from "@/server/finance-agreements/reconciliation-service";

import { MASTER_DATA_TARGETS, SAVING_NEVER_UPDATES_NOTE, buildCrossVerificationRows, canonicalDecisionValue, crossVerificationNeedsResolution } from "./cross-verification";

const openVersion = { versionConfirmed: false, versionStatus: "DRAFT" as const };

function field(over: Partial<FieldReconciliationDto> & Pick<FieldReconciliationDto, "fieldKey" | "state">): FieldReconciliationDto {
  return { label: over.fieldKey, group: "counterparty_contact", source: { canonical: "CreatorOps master data", agreement: null }, allowedActions: [], ...over };
}
const rowsFor = (fields: FieldReconciliationDto[], options: { canManage?: boolean; version?: Pick<AgreementReconciliationDto, "versionConfirmed" | "versionStatus"> } = {}) =>
  buildCrossVerificationRows({ fields, ...(options.version ?? openVersion) }, { canManage: options.canManage ?? true });
const one = (f: FieldReconciliationDto, options: Parameters<typeof rowsFor>[1] = {}) => rowsFor([f], options)[0]!;
const kinds = (f: FieldReconciliationDto, options: Parameters<typeof rowsFor>[1] = {}) => one(f, options).actions.map((a) => a.kind);
const labels = (f: FieldReconciliationDto, options: Parameters<typeof rowsFor>[1] = {}) => one(f, options).actions.map((a) => a.label);

describe("status vocabulary and highlighting", () => {
  it("renders every state with the design's human text; only Mismatch is highlighted", () => {
    const states = RECONCILIATION_STATES.map((state) => one(field({ fieldKey: "emailAddress", state })));
    expect(states.map((row) => row.stateChip.label)).toEqual(["Match", "Missing in CreatorOps", "Missing in Agreement", "Mismatch", "Not applicable", "Restricted", "Unavailable"]);
    expect(states.filter((row) => row.highlight).map((row) => row.state)).toEqual(["MISMATCH"]);
  });
});

describe("MATCH", () => {
  const match = field({ fieldKey: "emailAddress", state: "MATCH", canonicalValue: "a@b.co", extractedValue: "A@B.co", agreementDecision: "PENDING" });
  it("offers Confirm (accept, no value) while undecided", () => {
    const row = one(match);
    expect(row.creatorOpsText).toBe("a@b.co");
    expect(row.agreementText).toBe("A@B.co");
    expect(row.actions).toHaveLength(1);
    expect(row.actions[0]).toMatchObject({ kind: "CONFIRM", label: "Confirm", decision: "ACCEPTED", valueSource: "none", primary: true, masterData: null });
    expect(row.needsResolution).toBe(false);
  });
  it("once decided offers only 'Enter corrected value' (so a mis-click can still be changed), and shows the confirmed value", () => {
    const row = one({ ...match, agreementDecision: "ACCEPTED", confirmedValue: "a@b.co" });
    expect(row.actions.map((a) => a.kind)).toEqual(["ENTER_VALUE"]);
    // an identity row is only ever acknowledged - nothing to retype
    expect(one(field({ fieldKey: "panNumber", state: "MATCH", agreementDecision: "ACCEPTED" })).actions).toEqual([]);
    // read-only versions offer nothing
    expect(one({ ...match, agreementDecision: "ACCEPTED", confirmedValue: "a@b.co" }, { canManage: false }).actions).toEqual([]);
    expect(row.confirmed).toBe(true);
    expect(row.confirmedText).toBe("a@b.co");
  });
  it("shows the CreatorOps value on the Agreement side when the Agreement's own value was not extracted", () => {
    expect(one(field({ fieldKey: "emailAddress", state: "MATCH", canonicalValue: "a@b.co" })).agreementText).toBe("a@b.co");
  });
});

describe("MISSING_IN_CREATOROPS", () => {
  const missing = field({ fieldKey: "emailAddress", state: "MISSING_IN_CREATOROPS", extractedValue: "new@b.co", agreementDecision: "PENDING" });
  it("offers Use Agreement value only (the master-data update is not offered until the server lists it)", () => {
    expect(labels(missing)).toEqual(["Use Agreement value"]);
    expect(one(missing).actions[0]).toMatchObject({ kind: "USE_AGREEMENT_VALUE", decision: "ACCEPTED", valueSource: "none", primary: true });
    expect(one(missing).needsResolution).toBe(true);
    expect(one(missing).creatorOpsText).toBe("—");
  });
  it("adds a SEPARATE, dialog-gated `Update Partner/Vendor` when the server allows it - and saving never does it", () => {
    const decided = field({ ...missing, agreementDecision: "ACCEPTED", confirmedValue: "new@b.co", allowedActions: ["UPDATE_MASTER_DATA_FROM_AGREEMENT"] });
    const row = one(decided);
    expect(row.actions.map((a) => a.label)).toEqual(["Use Agreement value", "Update Partner/Vendor"]);
    const update = row.actions[1]!;
    expect(update).toMatchObject({ kind: "UPDATE_MASTER_DATA", decision: null, requiresDialog: true, primary: false, help: SAVING_NEVER_UPDATES_NOTE });
    expect(update.masterData).toEqual({ target: { via: "contact", fieldKey: "emailAddress" }, mode: "FILL_MISSING", requiresReason: false });
    expect(row.actions[0]!.decision).toBe("ACCEPTED"); // the Agreement-side action never carries master-data intent
    expect(row.actions[0]!.masterData).toBeNull();
  });
  it("maps identity fields to the KYC command, never to the contact command", () => {
    const pan = one(field({ fieldKey: "panNumber", state: "MISSING_IN_CREATOROPS", agreementDecision: "ACCEPTED", extractedValue: "ABCDE1234F", allowedActions: ["UPDATE_MASTER_DATA_FROM_AGREEMENT"] }));
    expect(pan.actions.find((a) => a.kind === "UPDATE_MASTER_DATA")!.masterData!.target).toEqual({ via: "kyc", component: "pan" });
  });
  it("never offers an update for a field with no master-data target (bank details cannot be applied from a contract)", () => {
    expect(kinds(field({ fieldKey: "bankAccountNumber", state: "MISSING_IN_CREATOROPS", agreementDecision: "ACCEPTED", extractedValue: "1234", allowedActions: ["UPDATE_MASTER_DATA_FROM_AGREEMENT"] }))).not.toContain("UPDATE_MASTER_DATA");
  });
});

describe("MISSING_IN_AGREEMENT", () => {
  const f = field({ fieldKey: "contactNumber", state: "MISSING_IN_AGREEMENT", canonicalValue: "+91 98765 43210" });
  it("offers the CreatorOps value (labelled as master data, never as extracted) and an enter-value alternative", () => {
    const row = one(f);
    expect(row.actions.map((a) => a.label)).toEqual(["Use CreatorOps value", "Enter corrected value"]);
    expect(row.actions[0]).toMatchObject({ kind: "USE_CREATOROPS_VALUE", decision: "ACCEPTED", valueSource: "canonical", value: "+91 98765 43210", primary: true });
    expect(row.sourceNote).toBe("Source: CreatorOps master data");
    expect(row.creatorOpsNote).toBe("CreatorOps master data");
    expect(row.agreementText).toBe("—");
    expect(JSON.stringify(row)).not.toMatch(/extracted/i);
  });
  it("an identity field is acknowledged without a value", () => {
    const row = one(field({ fieldKey: "panNumber", state: "MISSING_IN_AGREEMENT", canonicalValue: "ABCDE1234F" }));
    expect(row.actions.map((a) => [a.kind, a.valueSource, a.decision])).toEqual([["USE_CREATOROPS_VALUE", "none", "ACCEPTED"]]);
  });
  it("offers only Enter value when the CreatorOps value cannot be carried by a decision (a Partner in two states)", () => {
    expect(kinds(field({ fieldKey: "state", state: "MISSING_IN_AGREEMENT", canonicalValue: ["Kerala", "Tamil Nadu"] }))).toEqual(["ENTER_VALUE"]);
    expect(one(field({ fieldKey: "state", state: "MISSING_IN_AGREEMENT", canonicalValue: ["Kerala", "Tamil Nadu"] })).creatorOpsText).toBe("Kerala, Tamil Nadu");
  });
});

describe("MISMATCH", () => {
  const mismatch = field({ fieldKey: "emailAddress", state: "MISMATCH", canonicalValue: "old@b.co", extractedValue: "new@b.co", agreementDecision: "PENDING", allowedActions: ["KEEP_CREATOROPS_VALUE", "USE_AGREEMENT_VALUE_IN_AGREEMENT_ONLY"] });

  it("requires a deliberate choice: Keep CreatorOps value | Use Agreement value | Enter corrected value - no default", () => {
    const row = one(mismatch);
    expect(row.highlight).toBe(true);
    expect(row.needsResolution).toBe(true);
    expect(row.actions.map((a) => a.label)).toEqual(["Keep CreatorOps value", "Use Agreement value", "Enter corrected value"]);
    expect(row.actions.some((a) => a.primary)).toBe(false);
    expect(row.actions.some((a) => a.selected)).toBe(false);
    expect(row.actions[0]).toMatchObject({ decision: "CORRECTED", valueSource: "canonical", value: "old@b.co" });
    expect(row.actions[1]).toMatchObject({ decision: "ACCEPTED", valueSource: "none" });
    expect(row.actions[2]).toMatchObject({ decision: "CORRECTED", valueSource: "typed" });
  });

  it("no master-data update is offered unless the server lists the deliberate overwrite", () => {
    expect(kinds(mismatch)).not.toContain("OVERWRITE_MASTER_DATA");
    const row = one({ ...mismatch, agreementDecision: "ACCEPTED", confirmedValue: "new@b.co", allowedActions: [...mismatch.allowedActions, "OVERWRITE_MASTER_DATA_WITH_AGREEMENT_VALUE"] });
    const overwrite = row.actions.find((a) => a.kind === "OVERWRITE_MASTER_DATA")!;
    expect(overwrite.label).toBe("Update Partner/Vendor after confirmation");
    expect(overwrite).toMatchObject({ decision: null, requiresDialog: true, primary: false });
    expect(overwrite.masterData).toEqual({ target: { via: "contact", fieldKey: "emailAddress" }, mode: "OVERWRITE_MISMATCH", requiresReason: true });
  });

  it("marks the current resolution as selected (Use Agreement value / Keep CreatorOps value / a typed correction)", () => {
    const selected = (f: FieldReconciliationDto) => one(f).actions.filter((a) => a.selected).map((a) => a.kind);
    expect(selected({ ...mismatch, agreementDecision: "ACCEPTED", confirmedValue: "new@b.co" })).toEqual(["USE_AGREEMENT_VALUE"]);
    expect(selected({ ...mismatch, agreementDecision: "CORRECTED", confirmedValue: "old@b.co" })).toEqual(["KEEP_CREATOROPS_VALUE"]);
    expect(selected({ ...mismatch, agreementDecision: "CORRECTED", confirmedValue: "typed@b.co" })).toEqual(["ENTER_VALUE"]);
  });

  it("a restricted-identity mismatch (visible to an authorized actor) never offers Enter value", () => {
    const row = one(field({ fieldKey: "panNumber", state: "MISMATCH", canonicalValue: "AAAAA1111A", extractedValue: "BBBBB2222B", allowedActions: ["KEEP_CREATOROPS_VALUE", "USE_AGREEMENT_VALUE_IN_AGREEMENT_ONLY"] }));
    expect(row.actions.map((a) => a.kind)).toEqual(["KEEP_CREATOROPS_VALUE", "USE_AGREEMENT_VALUE"]);
    expect(row.actions[0]).toMatchObject({ decision: "ACCEPTED", valueSource: "none" });
  });
});

describe("RESTRICTED, NOT_APPLICABLE, UNAVAILABLE", () => {
  it("RESTRICTED shows only the masked word, no values, no actions", () => {
    const row = one(field({ fieldKey: "panNumber", state: "RESTRICTED", reason: "identity_access_required" }));
    expect(row).toMatchObject({ restricted: true, creatorOpsText: "Restricted", agreementText: "Restricted", confirmedText: null, actions: [], needsResolution: false });
    expect(row.reasonText).toBe("You do not have access to compare restricted details.");
  });

  it("even if a restricted field carried values, the row never exposes them", () => {
    const row = one(field({ fieldKey: "panNumber", state: "RESTRICTED", canonicalValue: "ABCDE1234F", extractedValue: "ABCDE1234F", confirmedValue: "ABCDE1234F", allowedActions: ["KEEP_CREATOROPS_VALUE"] }));
    expect(JSON.stringify(row)).not.toContain("ABCDE1234F");
    expect(row.actions).toEqual([]);
  });

  it("NOT_APPLICABLE offers nothing", () => {
    expect(one(field({ fieldKey: "aadhaarNumber", state: "NOT_APPLICABLE", reason: "not_applicable_to_counterparty" })).actions).toEqual([]);
  });

  it("UNAVAILABLE address / PIN: 'Not available in CreatorOps' - never invented - but still confirmable as Agreement-only data", () => {
    const row = one(field({ fieldKey: "address", state: "UNAVAILABLE", reason: "no_canonical_field", extractedValue: "12 MG Road, Kochi", agreementDecision: "PENDING" }));
    expect(row.creatorOpsText).toBe("Not available in CreatorOps");
    expect(row.reasonText).toBe("CreatorOps has no field for this yet.");
    expect(row.actions.map((a) => a.label)).toEqual(["Use Agreement value", "Enter corrected value"]);
    expect(row.needsResolution).toBe(true);
    const noValue = one(field({ fieldKey: "pinCode", state: "UNAVAILABLE", reason: "no_canonical_field" }));
    expect(noValue.actions.map((a) => a.label)).toEqual(["Enter corrected value"]);
  });

  it("other UNAVAILABLE reasons offer nothing", () => {
    expect(one(field({ fieldKey: "emailAddress", state: "UNAVAILABLE", reason: "canonical_unreadable" })).actions).toEqual([]);
    expect(one(field({ fieldKey: "emailAddress", state: "UNAVAILABLE", reason: "nothing_to_compare" })).creatorOpsText).toBe("—");
  });
});

describe("who may resolve", () => {
  const mismatch = field({ fieldKey: "emailAddress", state: "MISMATCH", canonicalValue: "old@b.co", extractedValue: "new@b.co", allowedActions: ["KEEP_CREATOROPS_VALUE", "USE_AGREEMENT_VALUE_IN_AGREEMENT_ONLY"] });

  it("without manage_agreements there are no Agreement-side resolution actions beyond what the server lists (and none for Match / Missing)", () => {
    expect(kinds(field({ fieldKey: "emailAddress", state: "MATCH", canonicalValue: "a@b.co" }), { canManage: false })).toEqual([]);
    expect(kinds(field({ fieldKey: "emailAddress", state: "MISSING_IN_CREATOROPS", extractedValue: "x@y.co" }), { canManage: false })).toEqual([]);
    expect(kinds(field({ fieldKey: "emailAddress", state: "MISSING_IN_AGREEMENT", canonicalValue: "x@y.co" }), { canManage: false })).toEqual([]);
    expect(kinds({ ...mismatch, allowedActions: [] }, { canManage: false })).toEqual([]);
  });

  it("a confirmed (frozen) version offers no Agreement-side resolution: Enter value / Confirm / Use ... are all gone", () => {
    const frozen = { version: { versionConfirmed: true, versionStatus: "DRAFT" as const } };
    expect(kinds(field({ fieldKey: "emailAddress", state: "MATCH", canonicalValue: "a@b.co" }), frozen)).toEqual([]);
    expect(kinds({ ...mismatch, allowedActions: [] }, frozen)).toEqual([]);
    expect(kinds(field({ fieldKey: "emailAddress", state: "MISSING_IN_AGREEMENT", canonicalValue: "x@y.co" }), frozen)).toEqual([]);
    const active = { version: { versionConfirmed: true, versionStatus: "ACTIVE" as const } };
    expect(kinds(field({ fieldKey: "emailAddress", state: "MATCH", canonicalValue: "a@b.co" }), active)).toEqual([]);
  });
});

describe("canonicalDecisionValue (validated by the server's own rule)", () => {
  it("accepts a single string, a one-element array for a text field, and an array for platforms", () => {
    expect(canonicalDecisionValue("emailAddress", "a@b.co")).toBe("a@b.co");
    expect(canonicalDecisionValue("state", ["Kerala"])).toBe("Kerala");
    expect(canonicalDecisionValue("platforms", ["instagram", "youtube"])).toEqual(["instagram", "youtube"]);
  });
  it("regression: the DTO collapses a one-element list to a string - platforms with ONE platform still yields a list value for 'Use CreatorOps value'", () => {
    expect(canonicalDecisionValue("platforms", "instagram")).toEqual(["instagram"]);
    expect(canonicalDecisionValue("state", "Kerala")).toBe("Kerala");
  });
  it("rejects what a decision cannot carry", () => {
    expect(canonicalDecisionValue("state", ["Kerala", "Tamil Nadu"])).toBeNull();
    expect(canonicalDecisionValue("pinCode", "12")).toBeNull();
    expect(canonicalDecisionValue("emailAddress", undefined)).toBeNull();
    expect(canonicalDecisionValue("panNumber", "ABCDE1234F")).toBeNull(); // identity values are never carried
  });
});

describe("summary + registry consistency", () => {
  it("counts rows that still need a deliberate resolution", () => {
    const rows = rowsFor([
      field({ fieldKey: "emailAddress", state: "MISMATCH", canonicalValue: "a", extractedValue: "b", allowedActions: ["KEEP_CREATOROPS_VALUE"] }),
      field({ fieldKey: "contactNumber", state: "MATCH", canonicalValue: "1", agreementDecision: "ACCEPTED", confirmedValue: "1" }),
      field({ fieldKey: "address", state: "UNAVAILABLE", reason: "no_canonical_field" }),
      field({ fieldKey: "panNumber", state: "RESTRICTED" }),
    ]);
    expect(crossVerificationNeedsResolution(rows)).toBe(2);
  });

  it("MASTER_DATA_TARGETS is a subset of what the server lets a master-data command write (no drift), and never includes bank", () => {
    for (const key of Object.keys(MASTER_DATA_TARGETS)) expect(MASTER_DATA_UPDATABLE_FIELD_KEYS).toContain(key);
    expect(Object.keys(MASTER_DATA_TARGETS).sort()).toEqual([...MASTER_DATA_UPDATABLE_FIELD_KEYS].sort());
    expect(Object.keys(MASTER_DATA_TARGETS)).not.toContain("bankAccountNumber");
  });
});

describe("identity values are only ever printed masked (last four characters)", () => {
  const identity = field({ fieldKey: "panNumber", state: "MISMATCH", group: "identity", canonicalValue: "ABCDE1234F", extractedValue: "ZZZZZ9999Z", agreementDecision: "PENDING" });
  it("masks the CreatorOps value and the Agreement value for an actor who may compare them", () => {
    const row = one(identity);
    expect(row.creatorOpsText).toBe("••••••234F");
    expect(row.agreementText).toBe("••••••999Z");
    expect(JSON.stringify(row)).not.toMatch(/ABCDE1234F|ZZZZZ9999Z/);
  });
  it("masks every identity field, including GSTIN, Aadhaar, bank account and IFSC", () => {
    for (const [fieldKey, value, masked] of [["gstin", "29ABCPE1234F1Z5", "•".repeat(11) + "F1Z5"], ["aadhaarNumber", "234123412346", "•".repeat(8) + "2346"], ["bankAccountNumber", "123456789012", "•".repeat(8) + "9012"], ["ifsc", "HDFC0001234", "•".repeat(7) + "1234"]] as const) {
      expect(one(field({ fieldKey, state: "MISSING_IN_AGREEMENT", canonicalValue: value })).creatorOpsText).toBe(masked);
    }
  });
  it("a restricted row still shows Restricted and no value at all", () => {
    const row = one(field({ fieldKey: "panNumber", state: "RESTRICTED" }));
    expect(row.creatorOpsText).toBe("Restricted");
    expect(row.agreementText).toBe("Restricted");
  });
});

describe("truthful provenance of a value the person decided", () => {
  const mismatch = field({ fieldKey: "emailAddress", state: "MISMATCH", canonicalValue: "a@b.co", extractedValue: "new@b.co", source: { canonical: "CreatorOps master data", agreement: { label: "Extracted from contract", origin: "EXTRACTED", confidence: "MEDIUM", page: 1 } } });
  it("Keep CreatorOps value reads 'your decision', never 'Agreement - page 1', and says what the Agreement said", () => {
    const row = one({ ...mismatch, agreementDecision: "CORRECTED", confirmedValue: "a@b.co", state: "MATCH" });
    expect(row.agreementNote).toBe("Kept CreatorOps value · your decision · The Agreement said: new@b.co");
    expect(row.agreementNote).not.toMatch(/page 1|Confidence/);
  });
  it("a typed value reads 'Entered by you'", () => {
    expect(one({ ...mismatch, agreementDecision: "CORRECTED", confirmedValue: "typed@b.co" }).agreementNote).toBe("Entered by you · your decision · The Agreement said: new@b.co");
  });
  it("Use Agreement value keeps the extracted provenance (the value really came from the Agreement)", () => {
    expect(one({ ...mismatch, agreementDecision: "ACCEPTED", confirmedValue: "new@b.co" }).agreementNote).toBe("Agreement · page 1 · Confidence: Medium");
  });
});

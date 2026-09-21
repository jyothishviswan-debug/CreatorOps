import { describe, expect, it } from "vitest";

import { partnerAccountDocSchema, partnerDocSchema } from "@/server/partners/types";
import { vendorDocSchema } from "@/server/vendors/types";

import { applyFieldDecision, attachProposalsToDraft, buildMasterDataDraft, draftFromConfirmedVersion, MASTER_DATA_LABEL, reconciliationEntriesForVersion, type ApplyFieldDecisionInput } from "./agreement-draft";
import { AGREEMENT_FIELD_BY_KEY, assembleConfirmedAgreement, type AgreementFieldKey } from "./fields";
import type { AuthorizedCounterparty } from "./finance-agreements-gate";
import { agreementDraftSchema, agreementVersionDocSchema, extractionRunDocSchema, type AgreementDraft, type AgreementVersionDoc } from "./types";
import { READY_DECISIONS } from "./testing/agreement-service-fixtures";

const NOW = "2026-01-01T00:00:00.000Z";
const ACTOR = "user-ref-1";

function partner(over: Record<string, unknown> = {}) {
  return partnerDocSchema.parse({
    uid: "p-uid",
    partnerRef: "p-ref",
    version: 1,
    displayName: "Display Partner",
    displayNameLower: "display partner",
    status: "ACTIVE",
    createdAt: NOW,
    createdByUserRef: "x",
    updatedAt: NOW,
    updatedByUserRef: "x",
    ...over,
  });
}
function account(over: Record<string, unknown> = {}) {
  return partnerAccountDocSchema.parse({
    uid: "a-uid",
    partnerAccountRef: "a-ref",
    version: 1,
    partnerRef: "p-ref",
    platform: "Instagram",
    normalizedIdentity: "instagram:a",
    status: "ACTIVE",
    createdAt: NOW,
    createdByUserRef: "x",
    updatedAt: NOW,
    updatedByUserRef: "x",
    ...over,
  });
}
function partnerAuthorized(over: { partner?: Record<string, unknown>; accounts?: Array<Record<string, unknown>> } = {}): AuthorizedCounterparty {
  const p = partner(over.partner);
  const accounts = (over.accounts ?? []).map((a) => account(a));
  return {
    type: "PARTNER",
    counterparty: { type: "PARTNER", partnerRef: p.partnerRef, partnerAccountRefs: accounts.map((a) => a.partnerAccountRef), platformScope: [...new Set(accounts.map((a) => a.platform.toLowerCase()))].sort() },
    scope: { ownerUid: null, regionIds: p.regionIds, teamIds: [], partnerUid: p.uid, vendorUid: null },
    displayName: p.displayName,
    partner: p,
    accounts,
  };
}

describe("buildMasterDataDraft", () => {
  it("prefills name/phone/email/state from master data as MASTER_DATA + PENDING with the master-data provenance label", () => {
    const draft = buildMasterDataDraft(partnerAuthorized({ partner: { legalName: "Legal Name Ltd", phone: "+91 90000 00000", email: "a@example.test", regionIds: ["Kerala"] } }));
    expect(draft.counterpartyName).toMatchObject({ value: "Legal Name Ltd", origin: "MASTER_DATA", decision: "PENDING", decidedByUserRef: null });
    expect(draft.counterpartyName?.provenance.label).toBe(MASTER_DATA_LABEL);
    expect(draft.contactNumber?.value).toBe("+91 90000 00000");
    expect(draft.emailAddress?.value).toBe("a@example.test");
    expect(draft.state?.value).toBe("Kerala");
    for (const entry of Object.values(draft)) expect(entry).toMatchObject({ origin: "MASTER_DATA", decision: "PENDING", extractedValue: null });
    expect(agreementDraftSchema.safeParse(draft).success).toBe(true);
  });

  it("falls back to the display name; several regions never guess a state; null contact fields are not prefilled", () => {
    const draft = buildMasterDataDraft(partnerAuthorized({ partner: { regionIds: ["Kerala", "Tamil Nadu"] } }));
    expect(draft.counterpartyName?.value).toBe("Display Partner");
    expect(draft.state).toBeUndefined();
    expect(draft.emailAddress).toBeUndefined();
    expect(draft.contactNumber).toBeUndefined();
  });

  it("never prefills an identity field or a computed one", () => {
    const draft = buildMasterDataDraft(partnerAuthorized({ partner: { email: "a@example.test" }, accounts: [{ platform: "Instagram", profileUrl: "https://example.test/x", displayName: "Page" }] }));
    for (const key of Object.keys(draft) as AgreementFieldKey[]) {
      expect(AGREEMENT_FIELD_BY_KEY[key].identityValue, key).toBe(false);
      expect(AGREEMENT_FIELD_BY_KEY[key].mode, key).toBe("DECIDED");
    }
  });

  it("derives platform and (for exactly one account) collaborator page context from the counterparty", () => {
    const one = buildMasterDataDraft(partnerAuthorized({ accounts: [{ platform: "Instagram", profileUrl: "https://example.test/x", displayName: "Page Name" }] }));
    expect(one.platforms?.value).toEqual(["instagram"]);
    expect(one.collaboratorPageLink?.value).toBe("https://example.test/x");
    expect(one.collaboratorPageName?.value).toBe("Page Name");

    const two = buildMasterDataDraft(partnerAuthorized({ accounts: [{ uid: "a1", partnerAccountRef: "a1", platform: "Instagram" }, { uid: "a2", partnerAccountRef: "a2", platform: "YouTube", normalizedIdentity: "youtube:a" }] }));
    expect(two.platforms?.value).toEqual(["instagram", "youtube"]);
    expect(two.collaboratorPageLink).toBeUndefined();
    expect(two.collaboratorPageName).toBeUndefined();
  });

  it("a Vendor is prefilled from the Vendor's own data and gets no platform context", () => {
    const vendor = vendorDocSchema.parse({ uid: "v-uid", vendorRef: "v-ref", version: 1, displayName: "Vendor Co", displayNameLower: "vendor co", vendorType: "AGENCY", status: "ACTIVE", email: "v@example.test", regionIds: ["Goa"], createdAt: NOW, createdByUserRef: "x", updatedAt: NOW, updatedByUserRef: "x" });
    const draft = buildMasterDataDraft({ type: "VENDOR", counterparty: { type: "VENDOR", vendorRef: "v-ref" }, scope: { ownerUid: null, regionIds: ["Goa"], teamIds: [], partnerUid: null, vendorUid: "v-uid" }, displayName: vendor.displayName, vendor });
    expect(draft.counterpartyName?.value).toBe("Vendor Co");
    expect(draft.emailAddress?.value).toBe("v@example.test");
    expect(draft.state?.value).toBe("Goa");
    expect(draft.platforms).toBeUndefined();
  });
});

function decide(over: Partial<ApplyFieldDecisionInput> & Pick<ApplyFieldDecisionInput, "fieldKey" | "decision">) {
  return applyFieldDecision({ existing: undefined, value: undefined, actorUserRef: ACTOR, now: NOW, ...over });
}

describe("applyFieldDecision", () => {
  it("ACCEPTED keeps the existing value and records who decided", () => {
    const existing = buildMasterDataDraft(partnerAuthorized({ partner: { email: "a@example.test" } })).emailAddress;
    const result = decide({ fieldKey: "emailAddress", decision: "ACCEPTED", existing });
    expect(result).toMatchObject({ ok: true, entry: { value: "a@example.test", origin: "MASTER_DATA", decision: "ACCEPTED", decidedByUserRef: ACTOR, decidedAt: NOW } });
  });

  it("ACCEPTED with nothing to accept is refused; ACCEPTED with a different value must be CORRECTED", () => {
    expect(decide({ fieldKey: "emailAddress", decision: "ACCEPTED" })).toMatchObject({ ok: false });
    const existing = buildMasterDataDraft(partnerAuthorized({ partner: { email: "a@example.test" } })).emailAddress;
    expect(decide({ fieldKey: "emailAddress", decision: "ACCEPTED", existing, value: "b@example.test" })).toMatchObject({ ok: false });
    expect(decide({ fieldKey: "emailAddress", decision: "ACCEPTED", existing, value: "a@example.test" })).toMatchObject({ ok: true });
  });

  it("ACCEPTED with a value and no entry is a value a human entered (MANUAL)", () => {
    expect(decide({ fieldKey: "signedDate", decision: "ACCEPTED", value: "2023-12-20" })).toMatchObject({ ok: true, entry: { value: "2023-12-20", origin: "MANUAL", decision: "ACCEPTED" } });
  });

  it("CORRECTED replaces the value, keeps the extractor's proposal beside it and the origin", () => {
    const run = extractionRunDocSchema.parse({
      runRef: "run_0123456789abcdef0123",
      agreementRef: "agr_0123456789abcdef0123",
      artifactRef: "ca_0123456789abcdef0123",
      status: "EXTRACTED",
      parserVersion: "p-1",
      pageCount: 1,
      charCount: 10,
      proposals: [{ fieldKey: "emailAddress", normalizedValue: "x@example.test", confidence: "HIGH", requiresHumanConfirmation: true, source: { page: 2 } }],
      createdAt: NOW,
      createdByUserRef: "u",
    });
    const attached = attachProposalsToDraft({}, run, "PARTNER");
    const result = decide({ fieldKey: "emailAddress", decision: "CORRECTED", existing: attached.draft.emailAddress, value: "y@example.test" });
    expect(result).toMatchObject({ ok: true, entry: { value: "y@example.test", origin: "EXTRACTED", decision: "CORRECTED", extractedValue: "x@example.test" } });
    if (result.ok) expect(result.entry.provenance).toMatchObject({ extractionRunRef: run.runRef, page: 2, confidence: "HIGH" });
  });

  it("UNAVAILABLE / NOT_APPLICABLE keep no value; an identity field takes an acknowledgement and never a value", () => {
    expect(decide({ fieldKey: "address", decision: "UNAVAILABLE" })).toMatchObject({ ok: true, entry: { value: null, decision: "UNAVAILABLE" } });
    const ack = decide({ fieldKey: "panNumber", decision: "ACCEPTED" });
    expect(ack).toMatchObject({ ok: true, entry: { value: null, extractedValue: null, decision: "ACCEPTED" } });
    if (ack.ok) expect(agreementDraftSchema.safeParse({ panNumber: ack.entry }).success).toBe(true);
  });

  it("re-accepting a value the extractor proposed but a human had marked UNAVAILABLE restores its EXTRACTED origin", () => {
    const existing = { value: null, origin: "EXTRACTED" as const, decision: "UNAVAILABLE" as const, extractedValue: "z@example.test", decidedByUserRef: ACTOR, decidedAt: NOW, provenance: { label: "L", extractionRunRef: null, page: null, confidence: null } };
    expect(decide({ fieldKey: "emailAddress", decision: "ACCEPTED", existing, value: "z@example.test" })).toMatchObject({ ok: true, entry: { origin: "EXTRACTED", value: "z@example.test" } });
    expect(decide({ fieldKey: "emailAddress", decision: "ACCEPTED", existing, value: "other@example.test" })).toMatchObject({ ok: true, entry: { origin: "MANUAL", value: "other@example.test" } });
  });
});

function run(proposals: unknown[], over: Record<string, unknown> = {}) {
  return extractionRunDocSchema.parse({
    runRef: "run_0123456789abcdef0123",
    agreementRef: "agr_0123456789abcdef0123",
    artifactRef: "ca_0123456789abcdef0123",
    status: "EXTRACTED",
    parserVersion: "parser-9",
    pageCount: 3,
    charCount: 100,
    proposals,
    createdAt: NOW,
    createdByUserRef: "u",
    ...over,
  });
}
const proposal = (fieldKey: string, normalizedValue: unknown, page = 1) => ({ fieldKey, normalizedValue, confidence: "MEDIUM", requiresHumanConfirmation: true, source: { page } });

describe("attachProposalsToDraft", () => {
  it("attaches non-restricted proposals as EXTRACTED + PENDING with confidence/page provenance and the extracted value beside", () => {
    const result = attachProposalsToDraft({}, run([proposal("currency", "INR", 2), proposal("paymentCycle", "MONTHLY")]), "PARTNER");
    expect(result).toMatchObject({ attachedCount: 2, keptDecisionCount: 0, skippedCount: 0 });
    expect(result.draft.currency).toMatchObject({ value: "INR", origin: "EXTRACTED", decision: "PENDING", extractedValue: "INR", decidedByUserRef: null });
    expect(result.draft.currency?.provenance).toMatchObject({ extractionRunRef: "run_0123456789abcdef0123", page: 2, confidence: "MEDIUM" });
    expect(result.draft.currency?.provenance.label).toContain("parser-9");
  });

  it("never overwrites a decided entry; replaces a still-PENDING one", () => {
    const decided: AgreementDraft = {
      currency: { value: "USD", origin: "MANUAL", decision: "CORRECTED", extractedValue: null, decidedByUserRef: ACTOR, decidedAt: NOW, provenance: { label: "L", extractionRunRef: null, page: null, confidence: null } },
      paymentCycle: { value: "WEEKLY", origin: "MASTER_DATA", decision: "PENDING", extractedValue: null, decidedByUserRef: null, decidedAt: null, provenance: { label: "L", extractionRunRef: null, page: null, confidence: null } },
    };
    const result = attachProposalsToDraft(decided, run([proposal("currency", "INR"), proposal("paymentCycle", "MONTHLY")]), "PARTNER");
    expect(result.keptDecisionCount).toBe(1);
    expect(result.draft.currency?.value).toBe("USD");
    expect(result.draft.currency?.decision).toBe("CORRECTED");
    expect(result.draft.paymentCycle).toMatchObject({ value: "MONTHLY", origin: "EXTRACTED", decision: "PENDING" });
  });

  it("an identity proposal becomes a value-less acknowledgement entry; nothing restricted is copied", () => {
    const result = attachProposalsToDraft({}, run([proposal("panNumber", null), proposal("bankAccountNumber", null)]), "PARTNER");
    expect(result.draft.panNumber).toMatchObject({ value: null, extractedValue: null, origin: "EXTRACTED", decision: "PENDING" });
    expect(JSON.stringify(result.draft)).not.toMatch(/[A-Z]{5}\d{4}[A-Z]/);
    expect(agreementDraftSchema.safeParse(result.draft).success).toBe(true);
  });

  it("skips: a valueless non-identity proposal, an invalid value, a non-extractable field, a field that does not apply to the counterparty", () => {
    const result = attachProposalsToDraft(
      {},
      run([proposal("currency", null), proposal("paymentCycle", "SOMETIMES"), proposal("remarks", "note"), proposal("aadhaarNumber", null)]),
      "VENDOR",
    );
    expect(result.attachedCount).toBe(0);
    expect(result.skippedCount).toBe(4);
    expect(result.draft).toEqual({});
  });

  it("never mutates the input draft", () => {
    const input: AgreementDraft = {};
    attachProposalsToDraft(input, run([proposal("currency", "INR")]), "PARTNER");
    expect(input).toEqual({});
  });
});

// A complete confirmed version, produced by the same pure pipeline the service uses.
function confirmedVersion(): AgreementVersionDoc {
  let draft: AgreementDraft = buildMasterDataDraft(partnerAuthorized({ partner: { email: "a@example.test", phone: "+91 90000 00000", regionIds: ["Kerala"] } }));
  for (const seed of READY_DECISIONS) {
    const value = seed.value === undefined ? undefined : seed.value;
    const result = applyFieldDecision({ existing: draft[seed.fieldKey], fieldKey: seed.fieldKey, decision: seed.decision, value, actorUserRef: ACTOR, now: NOW });
    if (!result.ok) throw new Error(`${seed.fieldKey}: ${result.message}`);
    draft = { ...draft, [seed.fieldKey]: result.entry };
  }
  // accept the remaining master-data prefills
  for (const key of ["contactNumber", "emailAddress", "state"] as AgreementFieldKey[]) {
    const result = applyFieldDecision({ existing: draft[key], fieldKey: key, decision: "ACCEPTED", value: undefined, actorUserRef: ACTOR, now: NOW });
    if (!result.ok) throw new Error(result.message);
    draft = { ...draft, [key]: result.entry };
  }
  const assembled = assembleConfirmedAgreement({ draft, counterpartyType: "PARTNER", actorUserRef: ACTOR, confirmedAt: NOW });
  if (!assembled.ok) throw new Error(JSON.stringify(assembled.blockers));
  return agreementVersionDocSchema.parse({
    agreementRef: "agr_0123456789abcdef0123",
    version: 1,
    status: "DRAFT",
    docVersion: 3,
    counterparty: { type: "PARTNER", partnerRef: "p-ref", partnerAccountRefs: [], platformScope: [] },
    sourceMode: assembled.sourceMode,
    source: { contractArtifactRef: null, extractionRunRef: null, parserVersion: null },
    draft: {},
    terms: assembled.terms,
    contactSnapshot: assembled.contactSnapshot,
    identityStatusSnapshot: { state: "MISSING", components: { pan: "MISSING", aadhaar: "MISSING", gst: "MISSING", bank: "MISSING" }, capturedAt: NOW },
    fieldProvenance: assembled.fieldProvenance,
    effective: assembled.effective,
    confirmation: { confirmedByUserRef: ACTOR, confirmedAt: NOW },
    createdAt: NOW,
    createdByUserRef: ACTOR,
    updatedAt: NOW,
    updatedByUserRef: ACTOR,
  });
}

describe("draftFromConfirmedVersion (revision prefill)", () => {
  it("carries the frozen values as MANUAL with 'previous version n' provenance and reassembles to IDENTICAL terms", () => {
    const base = confirmedVersion();
    const draft = draftFromConfirmedVersion(base);
    expect(agreementDraftSchema.safeParse(draft).success).toBe(true);
    for (const entry of Object.values(draft)) {
      expect(entry?.origin).toBe("MANUAL");
      expect(entry?.provenance.label).toBe("previous version 1");
      expect(["ACCEPTED", "UNAVAILABLE", "NOT_APPLICABLE"]).toContain(entry?.decision);
    }
    const again = assembleConfirmedAgreement({ draft, counterpartyType: "PARTNER", actorUserRef: "other-actor", confirmedAt: "2027-01-01T00:00:00.000Z" });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.terms).toEqual(base.terms);
    expect(again.contactSnapshot).toEqual(base.contactSnapshot);
    expect(again.effective).toEqual(base.effective);
    expect(again.sourceMode).toBe("MANUAL");
  });

  it("carries identity fields as value-less decisions only and never reads master data", () => {
    const draft = draftFromConfirmedVersion(confirmedVersion());
    for (const [key, entry] of Object.entries(draft)) if (AGREEMENT_FIELD_BY_KEY[key as AgreementFieldKey].identityValue) expect(entry?.value).toBeNull();
  });
});

describe("reconciliationEntriesForVersion", () => {
  it("for a confirmed version lists the frozen values with their frozen decisions; restricted fields carry no value", () => {
    const entries = reconciliationEntriesForVersion(confirmedVersion());
    const byKey = new Map(entries.map((entry) => [entry.fieldKey, entry]));
    expect(byKey.get("currency")).toMatchObject({ value: "INR", decision: "CORRECTED", restricted: false });
    expect(byKey.get("effectiveDate")?.value).toBe("2024-01-01");
    expect(byKey.get("counterpartyName")?.value).toBe("Acme Talent Private Limited");
    for (const entry of entries) if (entry.restricted) expect(entry.value).toBeNull();
    expect(byKey.get("panNumber")).toMatchObject({ restricted: true, value: null });
  });

  it("for an unconfirmed version lists the working draft without restricted values", () => {
    const base = confirmedVersion();
    const draft: AgreementDraft = { ...buildMasterDataDraft(partnerAuthorized({ partner: { email: "a@example.test" } })), ...attachProposalsToDraft({}, run([proposal("panNumber", null)]), "PARTNER").draft };
    const unconfirmed = { ...base, draft, terms: null, contactSnapshot: null, identityStatusSnapshot: null, fieldProvenance: null, effective: null, confirmation: null } as AgreementVersionDoc;
    const entries = reconciliationEntriesForVersion(unconfirmed);
    expect(entries.find((entry) => entry.fieldKey === "emailAddress")).toMatchObject({ value: "a@example.test", origin: "MASTER_DATA", decision: "PENDING" });
    expect(entries.find((entry) => entry.fieldKey === "panNumber")).toMatchObject({ restricted: true, value: null, extractedValue: null });
  });
});

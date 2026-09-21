// Step 14B.1 - the READ side of Agreement-led onboarding, and the component-level KYC `INCOMPLETE` state, against the running Firestore/Auth
// emulator (real services, gates, grants and owning duplicate checks; only the HTTP session lookup is replaced for the route tests).
//
//   preview     works with NO existing Partner / Vendor, persists NOTHING, carries identity PRESENCE only, raw snippets only with finance_contracts,
//               a scanned / unreadable PDF is MANUAL_REVIEW_REQUIRED, and it tells the actor whether they may create the record
//   duplicates  in-scope candidates {ref, displayName, regions, status, signals, strength}; an out-of-scope STRONG match is only a neutral flag;
//               supporting-only out-of-scope matches leave no trace; a lookup that cannot run is `unknown`; bounded; no identity value anywhere
//   KYC         INCOMPLETE = the canonical value is absent but a document of that type is on file (or GST applies without a number): identity
//               status, picker preview, workspace row and the Agreement KYC status agree, restricted for an actor without the identity category
//   routes      the four onboarding routes as real handlers: methods, status mapping, typed 409 blockers, multipart bounds, no logic of their own
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/server/authz/types";
import { findPartnerDocsByDisplayNameLower, getPartnerDocsByRefs, partnersCollection } from "@/server/partners/firestore";
import { createPartnerAccount } from "@/server/partners/partner-account-service";
import { checkForVendorDuplicates } from "@/server/vendors/duplicate-check";
import { getVendorDocsByRefs, vendorsCollection } from "@/server/vendors/firestore";
import { getActorScopeGrants } from "@/server/authz/scope";
import { getAdminFirestore } from "@/server/firebase/admin";

let httpActor: ActorContext | null = null;
vi.mock("@/server/administration/http", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/administration/http")>();
  return { ...original, resolveRequestActor: async () => httpActor };
});

import * as onboardingRoute from "@/app/api/finance/onboarding/route";
import * as duplicatesRoute from "@/app/api/finance/onboarding/duplicates/route";
import * as previewRoute from "@/app/api/finance/onboarding/preview/route";

import { createInMemoryArtifactStore, setContractArtifactStoreForTests } from "./contract-artifacts/store";
import { sha256Hex } from "./contract-artifacts/validation";
import {
  checkOnboardingDuplicates,
  createAgreementDraft,
  getAgreementKycStatus,
  getCounterpartyPreview,
  listAgreementsWorkspace,
  previewOnboardingFromContract,
  type OnboardingDuplicateCandidateDto,
} from "./index";
import { agreementClaimId, financeAgreementsCollection, financeContractArtifactsCollection } from "./firestore";
import { computeIdentityStatus } from "./identity-status";
import { blockerCodes, createOnboardingHarness, failed, must, type OnboardingHarness } from "@/server/testing/finance-onboarding-harness";
import { makeBlankPdf, makeNotAPdf, makeTextPdf } from "./testing/pdf-fixtures";
import { SAMPLE_AADHAAR, SAMPLE_CONTRACT_PAGES } from "./testing/sample-contract";

vi.setConfig({ testTimeout: 90_000 });

const BASE = "http://localhost:3000/api/finance";
const SECRETS = ["ABCPE1234F", "29ABCPE1234F1Z5", "123456789012", "HDFC0001234", SAMPLE_AADHAAR, "2341 2341 2346"];

let h: OnboardingHarness;
let creator: ActorContext;
let head: ActorContext;
let noCreate: ActorContext;
let outsider: ActorContext;
let viewer: ActorContext;
let store: ReturnType<typeof createInMemoryArtifactStore>;
let putCalls = 0;

beforeAll(async () => {
  h = await createOnboardingHarness("ons");
  creator = await h.actor("partnership_manager");
  head = await h.actor("partnership_head");
  noCreate = await h.actor("partnership_manager", { override: { partners: { actions: { create: false } }, vendors: { actions: { create: false } } } });
  outsider = await h.actor("partnership_manager", { grants: [{ type: "REGION", region: h.R_OUT }] });
  viewer = await h.seededActor("viewer");
  store = createInMemoryArtifactStore();
  const put = store.put.bind(store);
  store.put = async (input) => {
    putCalls += 1;
    return put(input);
  };
  setContractArtifactStoreForTests(store);
}, 120_000);

afterAll(async () => {
  httpActor = null;
  setContractArtifactStoreForTests(null);
  await h.teardown();
});

// A synthetic signed Agreement whose bytes are unique per call.
let pdfSeq = 0;
function agreementPdf(): Buffer {
  pdfSeq += 1;
  const [first, ...rest] = SAMPLE_CONTRACT_PAGES;
  return makeTextPdf([[...first!, `Reference: ONS${h.runId}-${pdfSeq}`], ...rest]);
}

// =====================================================================================================================
describe("preview: an ephemeral proposal for a NEW counterparty", () => {
  it("works with no existing Partner or Vendor, proposes the master profile with confidence, and persists NOTHING", async () => {
    const bytes = agreementPdf();
    const sha = sha256Hex(new Uint8Array(bytes));
    putCalls = 0;
    const dto = must(await previewOnboardingFromContract(creator, { type: "PARTNER", fileName: "C:\\fakepath\\Signed Agreement.pdf", bytes: new Uint8Array(bytes) }), "preview");

    expect(dto).toMatchObject({ counterpartyType: "PARTNER", fileName: "Signed Agreement.pdf", detectedPlatform: "instagram", canCreateCounterparty: true, canCreatePartnerAccounts: true });
    expect(dto.extraction.status).toMatch(/^(EXTRACTED|PARTIAL)$/);
    expect(dto.profile.counterpartyName).toMatchObject({ value: "Sample Creator Studio" });
    expect(dto.profile.emailAddress?.value).toBe("hello@samplecreator.example");
    expect(dto.profile.contactNumber?.value).toBe("+919876543210");
    expect(dto.profile.state?.value).toBe("Karnataka");
    expect(dto.profile.collaboratorPageLink?.value).toContain("instagram.com/sample.creator");
    expect(dto.agreement.effectiveDate?.value).toBe("2025-04-01");

    // nothing was persisted anywhere: no artifact bytes, no artifact / extraction / Agreement / Partner / Vendor / Account of this actor
    expect(putCalls).toBe(0);
    expect(store.size).toBe(0);
    expect((await financeContractArtifactsCollection().where("sha256", "==", sha).get()).size).toBe(0);
    expect((await financeContractArtifactsCollection().where("uploadedByUserRef", "==", creator.userRef).get()).size).toBe(0);
    expect((await financeAgreementsCollection().where("createdByUserRef", "==", creator.userRef).get()).size).toBe(0);
    expect((await partnersCollection().where("createdByUserRef", "==", creator.userRef).get()).size).toBe(0);
    expect((await vendorsCollection().where("createdByUserRef", "==", creator.userRef).get()).size).toBe(0);
  });

  it("identity fields report PRESENCE only, for every actor: no PAN / Aadhaar / GSTIN / bank value anywhere in the DTO", async () => {
    const bytes = new Uint8Array(agreementPdf());
    for (const actor of [creator, head]) {
      const dto = must(await previewOnboardingFromContract(actor, { type: "PARTNER", fileName: "a.pdf", bytes }), "preview");
      expect(dto.identityFound).toEqual({ pan: true, aadhaar: true, gst: true, bank: true });
      const text = JSON.stringify(dto);
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    }
  });

  it("raw contract snippets only with finance_contracts (a Head), identity masked; a Manager gets none", async () => {
    const bytes = new Uint8Array(agreementPdf());
    const asManager = must(await previewOnboardingFromContract(creator, { type: "PARTNER", fileName: "a.pdf", bytes }), "manager");
    expect(asManager).toMatchObject({ contractDetailVisible: false, snippets: null });
    const asHead = must(await previewOnboardingFromContract(head, { type: "PARTNER", fileName: "a.pdf", bytes }), "head");
    expect(asHead.contractDetailVisible).toBe(true);
    expect(asHead.snippets!.length).toBeGreaterThan(3);
    const text = JSON.stringify(asHead.snippets);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(asHead.snippets!.map((snippet) => snippet.fieldKey)).not.toContain("panNumber");
  });

  it("a scanned / image-only PDF is MANUAL_REVIEW_REQUIRED with reasons and no proposals; a non-PDF, an empty and an oversized file are refused", async () => {
    const scan = must(await previewOnboardingFromContract(creator, { type: "VENDOR", fileName: "scan.pdf", bytes: new Uint8Array(makeBlankPdf(2)) }), "scan");
    expect(scan.extraction.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(scan.extraction.reasons.map((reason) => reason.code)).toContain("no_extractable_text");
    expect(Object.values(scan.profile).every((field) => field === null)).toBe(true);
    expect(scan).toMatchObject({ counterpartyType: "VENDOR", canCreatePartnerAccounts: false, identityFound: { pan: false, aadhaar: false, gst: false, bank: false } });

    expect(failed(await previewOnboardingFromContract(creator, { type: "PARTNER", fileName: "x.pdf", bytes: new Uint8Array(makeNotAPdf()) })).message).toMatch(/not a PDF|not a valid PDF/);
    expect(failed(await previewOnboardingFromContract(creator, { type: "PARTNER", fileName: "x.pdf", bytes: new Uint8Array(0) })).message).toMatch(/empty/);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(new TextEncoder().encode("%PDF-1.4"));
    expect(failed(await previewOnboardingFromContract(creator, { type: "PARTNER", fileName: "x.pdf", bytes: big })).message).toMatch(/larger than/);
    expect(putCalls).toBe(0);
  });

  it("tells an actor who cannot create records so (they may still preview): canCreateCounterparty is the owning create right", async () => {
    const bytes = new Uint8Array(agreementPdf());
    const dto = must(await previewOnboardingFromContract(noCreate, { type: "PARTNER", fileName: "a.pdf", bytes }), "preview");
    expect(dto).toMatchObject({ canCreateCounterparty: false, canCreatePartnerAccounts: true });
    expect(must(await previewOnboardingFromContract(noCreate, { type: "VENDOR", fileName: "a.pdf", bytes }), "vendor")).toMatchObject({ canCreateCounterparty: false, canCreatePartnerAccounts: false });
  });

  it("is gated by finance + manage_agreements and validates its input strictly", async () => {
    const bytes = new Uint8Array(agreementPdf());
    expect(failed(await previewOnboardingFromContract(viewer, { type: "PARTNER", fileName: "a.pdf", bytes }))).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
    expect(failed(await previewOnboardingFromContract(null, { type: "PARTNER", fileName: "a.pdf", bytes }))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
    expect(failed(await previewOnboardingFromContract(creator, { type: "CREATOR", fileName: "a.pdf", bytes })).code).toBe("invalid_input");
    expect(failed(await previewOnboardingFromContract(creator, { type: "PARTNER", fileName: "a.pdf", bytes, counterpartyRef: "x" })).code).toBe("invalid_input");
    expect(failed(await previewOnboardingFromContract(creator, { type: "PARTNER", fileName: "", bytes })).code).toBe("invalid_input");
  });
});

// =====================================================================================================================
describe("duplicates: the owning checks, normalized, filtered by the actor's LIVE scope", () => {
  const candidates = (dto: { candidates: OnboardingDuplicateCandidateDto[] }) => dto.candidates.map((candidate) => `${candidate.ref}:${candidate.strength}:${candidate.signals.join("+")}`);

  it("Partner: email is STRONG (normalized), phone alone SUPPORTING, phone + exact name STRONG, name alone SUPPORTING, Account identity STRONG - and no identity value is in the DTO", async () => {
    const email = h.uniqueEmail().toLowerCase();
    const phone = "+919000000123";
    const name = h.uniqueName("Dup Partner");
    const partner = await h.seedPartner({ email, phone, name });
    const handle = h.uniqueHandle("dupacc");
    const account = await createPartnerAccount(head, partner.partnerRef, { platform: "Instagram", handle }, `req-dup-${h.runId}`);
    expect(account.ok).toBe(true);

    const base = { type: "PARTNER" as const, displayName: h.uniqueName("Someone Else") };
    const byEmail = must(await checkOnboardingDuplicates(creator, { ...base, email: `  ${email.toUpperCase()} ` }), "email");
    expect(byEmail.status).toBe("possible");
    expect(candidates(byEmail)).toEqual([`${partner.partnerRef}:STRONG:EMAIL`]);
    expect(byEmail.candidates[0]).toEqual({ type: "PARTNER", ref: partner.partnerRef, displayName: name, regions: [h.R_IN], status: "ACTIVE", signals: ["EMAIL"], strength: "STRONG" });

    const byPhone = must(await checkOnboardingDuplicates(creator, { ...base, phone: "+91 90000 00123" }), "phone");
    expect(candidates(byPhone)).toEqual([`${partner.partnerRef}:SUPPORTING:PHONE`]);
    const byPhoneAndName = must(await checkOnboardingDuplicates(creator, { type: "PARTNER", displayName: name.toUpperCase(), phone }), "phone+name");
    expect(candidates(byPhoneAndName)).toEqual([`${partner.partnerRef}:STRONG:PHONE+DISPLAY_NAME`]);
    const byName = must(await checkOnboardingDuplicates(creator, { type: "PARTNER", displayName: `  ${name.toLowerCase()}  ` }), "name");
    expect(candidates(byName)).toEqual([`${partner.partnerRef}:SUPPORTING:DISPLAY_NAME`]);

    // a different-spelling name is NEVER a match (exact normalized equality only, never fuzzy)
    expect(must(await checkOnboardingDuplicates(creator, { type: "PARTNER", displayName: `${name}s` }), "fuzzy")).toMatchObject({ status: "none", candidates: [] });

    // Account identity: the same page by handle (any case / @) is STRONG; another platform is not
    const byHandle = must(await checkOnboardingDuplicates(creator, { ...base, accounts: [{ platform: " instagram ", handle: `@${handle.toUpperCase()}` }] }), "account");
    expect(candidates(byHandle)).toEqual([`${partner.partnerRef}:STRONG:ACCOUNT_IDENTITY`]);
    expect(must(await checkOnboardingDuplicates(creator, { ...base, accounts: [{ platform: "YouTube", handle }] }), "other platform").candidates).toEqual([]);

    // no identity value in any DTO
    for (const dto of [byEmail, byPhone, byPhoneAndName, byName, byHandle]) {
      const text = JSON.stringify(dto);
      for (const value of [email, phone, handle]) expect(text.toLowerCase()).not.toContain(value.toLowerCase());
      expect(Object.keys(dto).sort()).toEqual(["candidates", "checkedAt", "status", "strongMatchOutsideYourAccess", "type"]);
    }
  });

  it("an OUT-OF-SCOPE strong match is only the neutral flag; an out-of-scope supporting-only match leaves no trace; a visible one is still listed", async () => {
    const email = h.uniqueEmail().toLowerCase();
    const name = h.uniqueName("Hidden Dup Partner");
    const hidden = await h.seedPartner({ regionIds: [h.R_OUT], email, name });
    const visible = await h.seedPartner({ email: h.uniqueEmail().toLowerCase() });
    const account = await createPartnerAccount(await h.actor("partnership_manager", { grants: [{ type: "REGION", region: h.R_OUT }] }), hidden.partnerRef, { platform: "Instagram", handle: h.uniqueHandle("hid") }, `req-hid-${h.runId}`);
    expect(account.ok).toBe(true);
    const leaks = [hidden.partnerRef, hidden.uid, name, email, h.R_OUT];

    const strong = must(await checkOnboardingDuplicates(creator, { type: "PARTNER", displayName: "x", email }), "strong");
    expect(strong).toMatchObject({ status: "possible", candidates: [], strongMatchOutsideYourAccess: true });
    for (const leak of leaks) expect(JSON.stringify(strong)).not.toContain(leak);

    const supportingOnly = must(await checkOnboardingDuplicates(creator, { type: "PARTNER", displayName: name }), "supporting");
    expect(supportingOnly).toMatchObject({ status: "none", candidates: [], strongMatchOutsideYourAccess: false });
    for (const leak of leaks) expect(JSON.stringify(supportingOnly)).not.toContain(leak);

    // the hidden Account identity is a strong match too - flagged, not disclosed
    const byAccount = must(await checkOnboardingDuplicates(creator, { type: "PARTNER", displayName: "x", accounts: [{ platform: "Instagram", handle: (await getAccountHandle(hidden.partnerRef))! }] }), "account");
    expect(byAccount).toMatchObject({ strongMatchOutsideYourAccess: true, candidates: [] });

    // mixed: the visible candidate is listed, the hidden one is only the flag
    const mixed = must(await checkOnboardingDuplicates(creator, { type: "PARTNER", displayName: "x", email: `${email}`, phone: visible.phone ?? undefined }), "mixed");
    expect(mixed.strongMatchOutsideYourAccess).toBe(true);
    // ... and the record's own region sees it as a normal candidate
    const asOutsider = must(await checkOnboardingDuplicates(outsider, { type: "PARTNER", displayName: "x", email }), "outsider");
    expect(candidates(asOutsider)).toEqual([`${hidden.partnerRef}:STRONG:EMAIL`]);
    expect(asOutsider.strongMatchOutsideYourAccess).toBe(false);
    // and the outsider cannot see the in-scope-for-creator record
    expect(must(await checkOnboardingDuplicates(outsider, { type: "PARTNER", displayName: "x", email: visible.email! }), "outsider2")).toMatchObject({ candidates: [], strongMatchOutsideYourAccess: true });
  });

  it("Vendor: email STRONG, exact name SUPPORTING (the Vendor module's own signal), out-of-scope strong = neutral flag", async () => {
    const email = h.uniqueEmail().toLowerCase();
    const vendor = await h.seedVendor({ email });
    const byEmail = must(await checkOnboardingDuplicates(creator, { type: "VENDOR", displayName: "x", email }), "email");
    expect(candidates(byEmail)).toEqual([`${vendor.vendorRef}:STRONG:EMAIL`]);
    const byName = must(await checkOnboardingDuplicates(creator, { type: "VENDOR", displayName: vendor.displayName }), "name");
    expect(candidates(byName)).toEqual([`${vendor.vendorRef}:SUPPORTING:DISPLAY_NAME`]);

    const hiddenEmail = h.uniqueEmail().toLowerCase();
    const hidden = await h.seedVendor({ regionIds: [h.R_OUT], email: hiddenEmail, name: h.uniqueName("Hidden Dup Vendor") });
    const flagged = must(await checkOnboardingDuplicates(creator, { type: "VENDOR", displayName: "x", email: hiddenEmail }), "hidden");
    expect(flagged).toMatchObject({ strongMatchOutsideYourAccess: true, candidates: [] });
    for (const leak of [hidden.vendorRef, hidden.displayName, hiddenEmail, h.R_OUT]) expect(JSON.stringify(flagged)).not.toContain(leak);
    expect(must(await checkOnboardingDuplicates(creator, { type: "VENDOR", displayName: hidden.displayName }), "hidden name")).toMatchObject({ status: "none", strongMatchOutsideYourAccess: false });
  });

  it("a lookup that cannot run is `unknown` (never `none`), whatever else was found", async () => {
    const email = h.uniqueEmail().toLowerCase();
    const partner = await h.seedPartner({ email });
    const deps = { checkPartners: async () => { throw new Error("down"); }, checkVendors: checkForVendorDuplicates, findPartnersByName: findPartnerDocsByDisplayNameLower, loadPartners: getPartnerDocsByRefs, loadVendors: getVendorDocsByRefs, loadGrants: getActorScopeGrants } as unknown as Parameters<typeof checkOnboardingDuplicates>[2];
    const dto = must(await checkOnboardingDuplicates(creator, { type: "PARTNER", displayName: partner.displayName, email }, deps), "unknown");
    expect(dto.status).toBe("unknown");
    expect(dto.candidates.map((candidate) => candidate.signals)).toEqual([["DISPLAY_NAME"]]); // what the other lookups did find is still shown
  });

  it("is bounded (never more than 10 candidates) and gated (finance + manage_agreements), with strict input", async () => {
    const phone = "+919000000777";
    for (let index = 0; index < 12; index += 1) await h.seedPartner({ phone, email: h.uniqueEmail().toLowerCase() });
    const dto = must(await checkOnboardingDuplicates(creator, { type: "PARTNER", displayName: "nobody", phone }), "bounded");
    expect(dto.candidates.length).toBeGreaterThan(0);
    expect(dto.candidates.length).toBeLessThanOrEqual(10);

    expect(failed(await checkOnboardingDuplicates(viewer, { type: "PARTNER", displayName: "x" }))).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
    expect(failed(await checkOnboardingDuplicates(null, { type: "PARTNER", displayName: "x" }))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
    expect(failed(await checkOnboardingDuplicates(creator, { type: "PARTNER", displayName: "x", scope: "GLOBAL" })).code).toBe("invalid_input");
    expect(failed(await checkOnboardingDuplicates(creator, { type: "VENDOR", displayName: "x", accounts: [{ platform: "Instagram", handle: "a" }] })).code).toBe("invalid_input");
    expect(failed(await checkOnboardingDuplicates(creator, { type: "PARTNER", displayName: "" })).code).toBe("invalid_input");
  });
});

async function getAccountHandle(partnerRef: string): Promise<string | undefined> {
  const snapshot = await getAdminFirestore().collection("partnerAccounts").where("partnerRef", "==", partnerRef).get();
  return snapshot.docs[0]?.data().handle as string | undefined;
}

// =====================================================================================================================
describe("component-level KYC INCOMPLETE: a document on file, the details not entered", () => {
  const SECRET_LINK = "secret-evidence-link";
  const SECRET_FILE = "secret-pan-scan";

  async function agreementFor(actor: ActorContext, counterparty: { type: "PARTNER"; partnerRef: string } | { type: "VENDOR"; vendorRef: string }) {
    const clientRequestId = h.uniqueClientRequestId();
    const created = must(await createAgreementDraft(actor, { clientRequestId, counterparty }, `req-kyc-${h.runId}`), "draft");
    h.trackAgreement(created.agreement.head.agreementRef);
    h.trackClaim(agreementClaimId(actor.uid, clientRequestId));
    return created.agreement.head.agreementRef;
  }

  it("PAN evidence on file but no PAN entered: identity status, picker preview, workspace row and Agreement KYC status all read INCOMPLETE; nothing else changes", async () => {
    const partner = await h.seedPartner();
    await h.seedRestrictedIdentity({ type: "PARTNER", uid: partner.uid, ref: partner.partnerRef }, { evidence: ["pan"] });
    const agreementRef = await agreementFor(head, { type: "PARTNER", partnerRef: partner.partnerRef });

    const status = await computeIdentityStatus("PARTNER", partner.uid);
    expect(status).toMatchObject({ state: "INCOMPLETE", components: { pan: "INCOMPLETE", aadhaar: "MISSING", gst: "MISSING", bank: "MISSING" } });

    const preview = must(await getCounterpartyPreview(head, { type: "PARTNER", ref: partner.partnerRef }), "preview");
    expect(preview.kyc).toMatchObject({ state: "INCOMPLETE", valuesVisible: true, components: { pan: "INCOMPLETE", aadhaar: "MISSING", gst: "MISSING", bank: "MISSING" } });
    expect(preview.gstinStatus).toBe("MISSING");

    const kyc = must(await getAgreementKycStatus(head, agreementRef), "kyc status");
    expect(kyc).toMatchObject({ state: "INCOMPLETE", valuesVisible: true, components: { pan: "INCOMPLETE", bank: "MISSING" }, evidenceTypesPresent: ["pan"] });

    const workspace = must(await listAgreementsWorkspace(head, { q: partner.displayName }), "workspace");
    expect(workspace.rows.find((row) => row.agreementRef === agreementRef)!.kyc).toMatchObject({ state: "INCOMPLETE", components: { pan: "INCOMPLETE" } });

    // an actor WITHOUT the identity category: the overall state is visible, every component RESTRICTED, and no evidence detail leaks
    const asManager = must(await getCounterpartyPreview(creator, { type: "PARTNER", ref: partner.partnerRef }), "manager preview");
    expect(asManager.kyc).toMatchObject({ state: "INCOMPLETE", valuesVisible: false, components: { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" } });
    expect(asManager.gstinStatus).toBe("RESTRICTED");
    const managerKyc = must(await getAgreementKycStatus(creator, agreementRef), "manager kyc");
    expect(managerKyc.components).toEqual({ pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" });
    expect(managerKyc.evidenceTypesPresent).toBeUndefined();
    for (const dto of [preview, kyc, asManager, managerKyc, workspace]) {
      const text = JSON.stringify(dto);
      expect(text).not.toContain(SECRET_LINK);
      expect(text).not.toContain(SECRET_FILE);
      expect(text).not.toContain("QWERT4321Z");
    }
  });

  it("Vendor: a bank document on file but no bank details = bank INCOMPLETE; PAN present, GST not applicable; the state is INCOMPLETE, not AVAILABLE", async () => {
    const vendor = await h.seedVendor();
    await h.seedRestrictedIdentity({ type: "VENDOR", uid: vendor.uid, ref: vendor.vendorRef }, { pan: true, gst: "not_applicable", evidence: ["bank"] });
    const status = await computeIdentityStatus("VENDOR", vendor.uid);
    expect(status).toMatchObject({ state: "INCOMPLETE", components: { pan: "PRESENT", aadhaar: "NOT_APPLICABLE", gst: "NOT_APPLICABLE", bank: "INCOMPLETE" } });
    const preview = must(await getCounterpartyPreview(head, { type: "VENDOR", ref: vendor.vendorRef }), "preview");
    expect(preview.kyc.components).toMatchObject({ pan: "PRESENT", gst: "NOT_APPLICABLE", bank: "INCOMPLETE" });
    expect(preview.gstinStatus).toBe("NOT_APPLICABLE");
  });

  it("GST that applies but has no number entered is INCOMPLETE (with or without a GST document); GSTIN status says so", async () => {
    const withDoc = await h.seedVendor();
    await h.seedRestrictedIdentity({ type: "VENDOR", uid: withDoc.uid, ref: withDoc.vendorRef }, { pan: true, bank: true, gst: "applicable_no_number", evidence: ["gst"] });
    expect((await computeIdentityStatus("VENDOR", withDoc.uid)).components.gst).toBe("INCOMPLETE");
    expect(must(await getCounterpartyPreview(head, { type: "VENDOR", ref: withDoc.vendorRef }), "preview").gstinStatus).toBe("INCOMPLETE");
    expect((await computeIdentityStatus("VENDOR", withDoc.uid)).state).toBe("INCOMPLETE");

    const docOnly = await h.seedVendor();
    await h.seedRestrictedIdentity({ type: "VENDOR", uid: docOnly.uid, ref: docOnly.vendorRef }, { pan: true, bank: true, evidence: ["gst"] });
    expect((await computeIdentityStatus("VENDOR", docOnly.uid)).components.gst).toBe("INCOMPLETE");
  });

  it("everything entered = AVAILABLE with no INCOMPLETE component; `other` evidence never makes a component incomplete; nothing recorded = MISSING", async () => {
    const complete = await h.seedPartner();
    await h.seedRestrictedIdentity({ type: "PARTNER", uid: complete.uid, ref: complete.partnerRef }, { pan: true, aadhaar: true, bank: true, gst: "not_applicable", evidence: ["pan", "bank", "other"] });
    const status = await computeIdentityStatus("PARTNER", complete.uid);
    expect(status).toMatchObject({ state: "AVAILABLE", components: { pan: "PRESENT", aadhaar: "PRESENT", gst: "NOT_APPLICABLE", bank: "PRESENT" } });
    expect(JSON.stringify(status)).not.toContain("INCOMPLETE");

    const otherOnly = await h.seedPartner();
    await h.seedRestrictedIdentity({ type: "PARTNER", uid: otherOnly.uid, ref: otherOnly.partnerRef }, { evidence: ["other"] });
    expect(await computeIdentityStatus("PARTNER", otherOnly.uid)).toMatchObject({ state: "MISSING", components: { pan: "MISSING", aadhaar: "MISSING", gst: "MISSING", bank: "MISSING" } });

    const nothing = await h.seedPartner();
    expect(await computeIdentityStatus("PARTNER", nothing.uid)).toMatchObject({ state: "MISSING" });
  });
});

// =====================================================================================================================
describe("routes: thin handlers over the services", () => {
  const post = async (handler: { POST: (request: Request) => Promise<Response> }, path: string, actor: ActorContext | null, init: { json?: unknown; body?: BodyInit; headers?: Record<string, string> }) => {
    httpActor = actor;
    const request = new Request(`${BASE}${path}`, { method: "POST", headers: init.json !== undefined ? { "Content-Type": "application/json" } : init.headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
    const response = await handler.POST(request);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const get = async (path: string, actor: ActorContext | null) => {
    httpActor = actor;
    const response = await onboardingRoute.GET(new Request(`${BASE}${path}`));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const form = (fields: Record<string, string | File>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  };
  const pdfFile = () => new File([new Uint8Array(agreementPdf())], "Agreement.pdf", { type: "application/pdf" });

  it("POST /onboarding/preview: 401 with no session, 403 for a Viewer, 415 without multipart, 400 for a missing file or a non-PDF, 200 with the proposal", async () => {
    expect((await post(previewRoute, "/onboarding/preview", null, { body: form({ counterpartyType: "PARTNER", file: pdfFile() }) })).status).toBe(401);
    expect(await post(previewRoute, "/onboarding/preview", viewer, { body: form({ counterpartyType: "PARTNER", file: pdfFile() }) })).toEqual({ status: 403, body: { error: "Forbidden." } });
    expect((await post(previewRoute, "/onboarding/preview", creator, { json: { counterpartyType: "PARTNER" } })).status).toBe(415);
    expect((await post(previewRoute, "/onboarding/preview", creator, { body: form({ counterpartyType: "PARTNER" }) })).status).toBe(400);
    const notPdf = await post(previewRoute, "/onboarding/preview", creator, { body: form({ counterpartyType: "PARTNER", file: new File(["hello"], "a.pdf") }) });
    expect(notPdf.status).toBe(400);
    const ok = await post(previewRoute, "/onboarding/preview", creator, { body: form({ counterpartyType: "PARTNER", file: pdfFile() }) });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ counterpartyType: "PARTNER", fileName: "Agreement.pdf", identityFound: { pan: true } });
    for (const secret of SECRETS) expect(JSON.stringify(ok.body)).not.toContain(secret);
    expect((await post(previewRoute, "/onboarding/preview", creator, { body: form({ counterpartyType: "CREATOR", file: pdfFile() }) })).status).toBe(400);
    // an oversized declared body is refused before it is buffered
    const oversized = await post(previewRoute, "/onboarding/preview", creator, { headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(20 * 1024 * 1024) }, body: "x" });
    expect(oversized.status).toBe(413);
  });

  it("POST /onboarding/duplicates: 200 with the safe DTO, 403 / 401 denials, 400 for invalid JSON or input", async () => {
    const partner = await h.seedPartner({ email: h.uniqueEmail().toLowerCase() });
    const ok = await post(duplicatesRoute, "/onboarding/duplicates", creator, { json: { type: "PARTNER", displayName: "x", email: partner.email } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "possible", strongMatchOutsideYourAccess: false, candidates: [{ ref: partner.partnerRef, strength: "STRONG" }] });
    expect((await post(duplicatesRoute, "/onboarding/duplicates", viewer, { json: { type: "PARTNER", displayName: "x" } })).status).toBe(403);
    expect((await post(duplicatesRoute, "/onboarding/duplicates", null, { json: { type: "PARTNER", displayName: "x" } })).status).toBe(401);
    expect((await post(duplicatesRoute, "/onboarding/duplicates", creator, { json: { type: "PARTNER" } })).status).toBe(400);
    expect((await post(duplicatesRoute, "/onboarding/duplicates", creator, { headers: { "Content-Type": "application/json" }, body: "{not json" })).status).toBe(400);
  });

  it("POST /onboarding: 200 outcomes, 409 with a typed blocker code, 403 / 401 denials, 400 for invalid input; GET reads the ledger (404 for an unknown or another actor's request)", async () => {
    const clientRequestId = h.uniqueClientRequestId();
    h.trackRequest(creator, clientRequestId);
    const body = { clientRequestId, type: "PARTNER", reviewedProfile: { displayName: h.uniqueName("Route Partner"), email: h.uniqueEmail(), regionIds: [h.R_IN] }, accounts: [{ platform: "Instagram", handle: h.uniqueHandle("rt") }], duplicateDecision: { kind: "CREATE_NEW", acknowledgedDuplicates: false } };
    const created = await post(onboardingRoute, "/onboarding", creator, { json: body });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ outcome: "COMPLETED", mode: "CREATE_NEW", replayed: false, counterpartyType: "PARTNER" });
    h.trackAgreement(created.body.agreementRef as string);

    const replay = await post(onboardingRoute, "/onboarding", creator, { json: body });
    expect(replay).toMatchObject({ status: 200, body: { outcome: "COMPLETED", replayed: true, agreementRef: created.body.agreementRef } });

    const status = await get(`/onboarding?clientRequestId=${clientRequestId}`, creator);
    expect(status).toMatchObject({ status: 200, body: { outcome: "COMPLETED", agreementRef: created.body.agreementRef } });
    expect((await get(`/onboarding?onboardingRef=${created.body.onboardingRef as string}`, creator)).status).toBe(200);
    expect((await get(`/onboarding?clientRequestId=${clientRequestId}`, head)).status).toBe(404);
    expect((await get(`/onboarding?clientRequestId=onb-never-started-1`, creator)).status).toBe(404);
    expect((await get(`/onboarding`, creator)).status).toBe(400);
    expect((await get(`/onboarding?clientRequestId=${clientRequestId}`, viewer)).status).toBe(403);
    expect((await get(`/onboarding?clientRequestId=${clientRequestId}`, null)).status).toBe(401);

    // a refusal before anything is written: 409 + the typed blocker code
    const refused = await post(onboardingRoute, "/onboarding", noCreate, { json: { ...body, clientRequestId: h.uniqueClientRequestId(), reviewedProfile: { ...body.reviewedProfile, displayName: h.uniqueName("Refused"), email: h.uniqueEmail() } } });
    expect(refused.status).toBe(409);
    expect(blockerCodes({ ok: false, code: "not_ready", message: "", blockers: refused.body.blockers as Array<{ code: string; message: string }> })).toEqual(["counterparty_create_not_permitted"]);

    expect((await post(onboardingRoute, "/onboarding", viewer, { json: body })).status).toBe(403);
    expect((await post(onboardingRoute, "/onboarding", null, { json: body })).status).toBe(401);
    expect((await post(onboardingRoute, "/onboarding", creator, { json: { ...body, clientRequestId: "x" } })).status).toBe(400);
    expect((await post(onboardingRoute, "/onboarding", creator, { headers: { "Content-Type": "application/json" }, body: "{oops" })).status).toBe(400);
    // the same clientRequestId with a changed payload is a 409 conflict
    expect((await post(onboardingRoute, "/onboarding", creator, { json: { ...body, reviewedProfile: { ...body.reviewedProfile, displayName: "Changed Name" } } })).status).toBe(409);
  });
});


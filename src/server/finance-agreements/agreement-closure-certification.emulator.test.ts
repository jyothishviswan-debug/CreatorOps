// Step 14C - FINANCE AGREEMENTS CLOSURE CERTIFICATION: the gaps the accepted 14A / 14B / 14B.1 / 14C evidence does not already carry.
// Runs against the private Firestore/Auth emulator with the FAKE Drive adapter and an in-memory contract-artifact store (nothing reaches Google).
//
//   1. FULL-JOURNEY RUNTIME KYC BOUNDARY - a new Partner (Instagram + YouTube) and a new Vendor onboarded through the OWNING services, the real
//      sample contract (PAN / GSTIN / Aadhaar / bank / IFSC lines) uploaded, extracted, attached, KYC applied to the CANONICAL owning store,
//      confirmed, stored (fake Drive), activated, revised (a second signed file), suspended, resumed and ended. Afterwards EVERY document of
//      EVERY financeAgreement* / financeContract* collection (and every subcollection) is walked: no identity value, no identity-value key.
//      The raw extracted values live only in the restricted extraction store. The fake Drive holds only the exact Agreement PDFs.
//   2. EXISTING-COUNTERPARTY CLOSURE - per-component KYC readiness, only the missing component is filled, master data untouched, one Drive file
//      per version and the same reference in Finance and the Partner / Vendor projection.
//   3. ATOMIC SUPERSESSION / NO DUAL ACTIVE through the whole revise path, and revision-without-new-file honesty.
//   4. OVERLAP RESOLUTION BY ENDING (real endAgreement, real "now"): ending one of two overlapping open-ended Agreements resolves the CURRENT
//      month but never rewrites an elapsed month it governed (ENDED governs only through its end date).
//   5. REPO-WIDE STATIC SCANS - no Payable / Invoice / Payment implementation anywhere in src (collections, services, routes, pages beyond the
//      three fixture placeholder pages); no test seam is reachable from production code; no wildcard / minimumRole / rank grant.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { getPartnerDocByRef } from "@/server/partners/firestore";
import { getVendorDocByRef } from "@/server/vendors/firestore";
import { listVendorPartnerLinkDocsForVendor } from "@/server/vendors/firestore";
import { restrictedFinancialIdentitiesCollection, restrictedIdentityDocId } from "@/server/shared/restricted-financial-identity";
import { createOnboardingHarness, failed, must, type OnboardingHarness } from "@/server/testing/finance-onboarding-harness";

import {
  activateAgreementVersion,
  applyExtractedKycToCanonical,
  attachExtractionProposals,
  confirmAgreementVersion,
  createAgreementDraft,
  createAgreementRevision,
  createCounterpartyFromOnboarding,
  decideField,
  endAgreement,
  extractContract,
  getAgreementDetail,
  getAgreementDocumentStatus,
  getAgreementKycStatus,
  listAgreementEvents,
  listCounterpartyAgreementDocuments,
  NO_NEW_SIGNED_DOCUMENT_MESSAGE,
  resumeAgreement,
  storeAgreementDocument,
  suspendAgreement,
  uploadContractArtifact,
  type AgreementDetailDto,
  type OnboardingRequest,
} from "./index";
import { contractArtifactClaimId } from "./contract-service";
import { getAgreementCommercialPolicy } from "./policy-adapter";
import { createPolicyHarness } from "./testing/policy-harness";
import { createInMemoryArtifactStore, setContractArtifactStoreForTests } from "./contract-artifacts/store";
import { sha256Hex } from "./contract-artifacts/validation";
import { agreementClaimId, FINANCE_AGREEMENT_COLLECTIONS, financeAgreementClaimsCollection, financeAgreementRestrictedExtractionsCollection, financeAgreementsCollection, financeContractArtifactsCollection } from "./firestore";
import { installFakeAgreementDocumentStorage } from "./testing/agreement-document-fixtures";
import { makeTextPdf } from "./testing/pdf-fixtures";
import { SAMPLE_CONTRACT_PAGES } from "./testing/sample-contract";
import type { FieldDecisionSeed } from "./testing/agreement-service-fixtures";
import { READY_DECISIONS } from "./testing/agreement-service-fixtures";

vi.setConfig({ testTimeout: 120_000 });

// The values inside the synthetic sample contract (sample-contract.ts) - invented, shaped like real ones.
const SENSITIVE = { pan: "ABCPE1234F", gstin: "29ABCPE1234F1Z5", aadhaarSpaced: "2341 2341 2346", aadhaar: "234123412346", account: "123456789012", ifsc: "HDFC0001234" };
const SENSITIVE_VALUES = Object.values(SENSITIVE);
const IDENTITY_KEYS = /"(panNumber|panHolderName|aadhaarNumber|accountNumber|accountHolderName|bankName|ifsc|ifscCode|gstin|gstNumber|gstCertificate|pan|aadhaar|bank)"\s*:/;

// The READY decisions as a signed-Agreement extraction needs them: CORRECTED wherever a value is carried (an attached extraction already
// holds a proposed value, and only CORRECTED replaces it), with the SUPPORTED qualifying unit.
const READY: FieldDecisionSeed[] = READY_DECISIONS.map((seed) => {
  if (seed.fieldKey === "qualifyingUnit") return { ...seed, value: "approved_content_thread" };
  return seed.value !== undefined && seed.decision === "ACCEPTED" ? { ...seed, decision: "CORRECTED" as const } : seed;
});

let h: OnboardingHarness;
let manager: ActorContext; // finance manage + owning create rights, scoped to the private region (no finance_contracts, no identity category)
let head: ActorContext; // + activate / lifecycle + finance_contracts + the identity category
let drive = installFakeAgreementDocumentStorage();
const createdArtifacts: string[] = [];
const createdClaims: string[] = [];
const createdRuns: string[] = [];
const createdAgreements: string[] = [];

beforeAll(async () => {
  h = await createOnboardingHarness("ccl");
  manager = await h.actor("partnership_manager");
  head = await h.actor("partnership_head");
  setContractArtifactStoreForTests(createInMemoryArtifactStore());
  drive = installFakeAgreementDocumentStorage();
}, 120_000);

afterAll(async () => {
  setContractArtifactStoreForTests(null);
  drive.restore();
  const db = getAdminFirestore();
  await Promise.all(createdRuns.map((run) => financeAgreementRestrictedExtractionsCollection().doc(run).delete()));
  await Promise.all(createdArtifacts.map((ref) => financeContractArtifactsCollection().doc(ref).delete()));
  await Promise.all(createdClaims.map((id) => financeAgreementClaimsCollection().doc(id).delete()));
  for (const ref of createdAgreements) await db.recursiveDelete(financeAgreementsCollection().doc(ref));
  await h.teardown();
});

// ---- helpers ---------------------------------------------------------------------------------------------------------------------
let seq = 0;
const rid = () => `req-ccl-${h.runId}-${(seq += 1)}`;
const docVersionOf = (detail: AgreementDetailDto) => detail.selectedVersion!.docVersion;
const fresh = async (actor: ActorContext, agreementRef: string, version?: number) => must(await getAgreementDetail(actor, agreementRef, version ? { version } : {}), "detail");

async function decideAll(actor: ActorContext, detail: AgreementDetailDto, seeds: FieldDecisionSeed[]): Promise<AgreementDetailDto> {
  let current = detail;
  for (const seed of seeds) {
    current = must(
      await decideField(actor, { agreementRef: current.head.agreementRef, version: current.selectedVersion!.version, expectedDocVersion: docVersionOf(current), fieldKey: seed.fieldKey, decision: seed.decision, ...(seed.value !== undefined ? { value: seed.value } : {}) }, rid()),
      `decide ${seed.fieldKey}`,
    );
  }
  return current;
}

async function acceptPending(actor: ActorContext, detail: AgreementDetailDto): Promise<AgreementDetailDto> {
  const pending = Object.entries(detail.selectedVersion!.draft)
    .filter(([, entry]) => entry?.decision === "PENDING")
    .map(([fieldKey]) => ({ fieldKey, decision: "ACCEPTED" as const }));
  return decideAll(actor, detail, pending as FieldDecisionSeed[]);
}

// A distinct signed PDF per call (so two versions never share a checksum): the sample contract with one extra unique line.
function signedPdf(label: string): Buffer {
  return makeTextPdf([...SAMPLE_CONTRACT_PAGES.map((lines, index) => (index === 0 ? [...lines, `Reference: ${label}`] : lines))]);
}

// Real upload -> real extraction -> attach (proposals PENDING). Tracks everything for cleanup.
async function uploadExtractAttach(actor: ActorContext, detail: AgreementDetailDto, counterparty: { type: "PARTNER" | "VENDOR"; ref: string }, file: { bytes: Buffer; fileName: string }): Promise<AgreementDetailDto> {
  const uploaded = must(await uploadContractArtifact(actor, { fileName: file.fileName, bytes: file.bytes, counterparty }, rid()), "upload");
  createdArtifacts.push(uploaded.artifact.artifactRef);
  createdClaims.push(contractArtifactClaimId(counterparty.type, counterparty.ref, sha256Hex(file.bytes)));
  const extraction = must(await extractContract(actor, { agreementRef: detail.head.agreementRef, version: detail.selectedVersion!.version, artifactRef: uploaded.artifact.artifactRef }, rid()), "extract");
  createdRuns.push(extraction.run.runRef);
  return must(await attachExtractionProposals(actor, { agreementRef: detail.head.agreementRef, version: detail.selectedVersion!.version, expectedDocVersion: docVersionOf(detail), extractionRunRef: extraction.run.runRef }, rid()), "attach").agreement;
}

const applyKyc = (actor: ActorContext, agreementRef: string, version: number, components: string[]) => applyExtractedKycToCanonical(actor, { agreementRef, version, components, mode: "FILL_MISSING" }, rid());

type PartnerOver = { accounts?: OnboardingRequest["accounts"] };
function partnerRequest(over: PartnerOver = {}): OnboardingRequest {
  return {
    clientRequestId: h.uniqueClientRequestId(),
    type: "PARTNER",
    reviewedProfile: { displayName: h.uniqueName("Closure Partner"), email: h.uniqueEmail(), phone: h.uniquePhone(), regionIds: [h.R_IN] },
    accounts: over.accounts ?? [],
    duplicateDecision: { kind: "CREATE_NEW", acknowledgedDuplicates: false },
  };
}
function vendorRequest(): OnboardingRequest {
  return {
    clientRequestId: h.uniqueClientRequestId(),
    type: "VENDOR",
    reviewedProfile: { displayName: h.uniqueName("Closure Vendor"), email: h.uniqueEmail(), phone: h.uniquePhone(), regionIds: [h.R_IN], vendorType: "AGENCY" },
    duplicateDecision: { kind: "CREATE_NEW", acknowledgedDuplicates: false },
  };
}

async function onboard(actor: ActorContext, request: OnboardingRequest) {
  h.trackRequest(actor, request.clientRequestId);
  const outcome = must(await createCounterpartyFromOnboarding(actor, request, rid()), "onboarding");
  expect(outcome.outcome, JSON.stringify(outcome)).toBe("COMPLETED");
  h.trackAgreement(outcome.agreementRef!);
  createdAgreements.push(outcome.agreementRef!);
  return outcome;
}

// ---- The walker: EVERY document of every Finance collection ----------------------------------------------------------------------
// The restricted extraction store is the ONE Finance collection allowed to hold raw extracted values (server-only, category-gated, never
// on a DTO); it is walked separately. Everything else must be free of any identity value or identity-value key.
async function walkDocument(ref: FirebaseFirestore.DocumentReference, out: Array<{ path: string; json: string }>): Promise<void> {
  const snapshot = await ref.get();
  if (snapshot.exists) out.push({ path: ref.path, json: JSON.stringify(snapshot.data()) });
  for (const sub of await ref.listCollections()) for (const doc of (await sub.listDocuments())) await walkDocument(doc, out);
}

async function walkFinanceCollections(): Promise<{ unrestricted: Array<{ path: string; json: string }>; restricted: Array<{ path: string; json: string }> }> {
  const db = getAdminFirestore();
  const unrestricted: Array<{ path: string; json: string }> = [];
  const restricted: Array<{ path: string; json: string }> = [];
  const roots = (await db.listCollections()).filter((collection) => /^finance/i.test(collection.id));
  for (const root of roots) {
    const target = root.id === FINANCE_AGREEMENT_COLLECTIONS.financeAgreementRestrictedExtractions ? restricted : unrestricted;
    for (const doc of await root.listDocuments()) await walkDocument(doc, target);
  }
  return { unrestricted, restricted };
}

function expectNoIdentity(docs: Array<{ path: string; json: string }>, label: string) {
  expect(docs.length, `${label}: the walk is not vacuous`).toBeGreaterThan(0);
  for (const doc of docs) {
    for (const value of SENSITIVE_VALUES) expect(doc.json.includes(value), `${label}: ${doc.path} holds ${value.slice(0, 4)}...`).toBe(false);
    // An identity FIELD key may appear only as a provenance / draft-decision entry ({"origin":...} / {"decision":...} / {"value":null,...}: "value not stored on the Agreement")
    // and a component key only with a status word (PRESENT / MISSING / INCOMPLETE / NOT_APPLICABLE) - never with a value. (The walk covers every
    // Finance document in the emulator, including other test files' open drafts running in parallel.)
    const withoutAllowed = doc.json.replace(/"(pan|aadhaar|gst|bank)":"(PRESENT|MISSING|INCOMPLETE|NOT_APPLICABLE)"/g, "").replace(/"\w+":\{"(origin|decision)":/g, "").replace(/"\w+":\{"value":null,/g, "");
    const keyHit = IDENTITY_KEYS.exec(withoutAllowed);
    expect(keyHit ? withoutAllowed.slice(Math.max(0, keyHit.index - 40), keyHit.index + 120) : null, `${label}: ${doc.path} carries an identity-value key`).toBeNull();
    expect(doc.json, `${label}: ${doc.path} holds a PAN-shaped value`).not.toMatch(/\b[A-Z]{5}\d{4}[A-Z]\b/);
    expect(doc.json, `${label}: ${doc.path} holds a GSTIN-shaped value`).not.toMatch(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/);
    expect(doc.json, `${label}: ${doc.path} holds an IFSC-shaped value`).not.toMatch(/\b[A-Z]{4}0[A-Z0-9]{6}\b/);
  }
}

// =====================================================================================================================
describe("FULL JOURNEY - a new Partner (Instagram + YouTube): the Finance boundary holds through onboarding, extraction, KYC, confirm, store, activate, revise, suspend, resume, end", () => {
  it("walks EVERY Finance document and the fake Drive: no unrestricted PAN / Aadhaar / bank / IFSC / GSTIN / KYC bytes; the canonical owning store holds the KYC; the Drive holds only the exact Agreement PDFs", async () => {
    drive.storage.reset();
    const request = partnerRequest({ accounts: [{ platform: "Instagram", handle: h.uniqueHandle("ig"), displayName: "Closure on Instagram" }, { platform: "YouTube", handle: h.uniqueHandle("yt") }] });
    const outcome = await onboard(manager, request);
    const partnerRef = outcome.counterparty!.ref;
    const agreementRef = outcome.agreementRef!;
    const partner = (await getPartnerDocByRef(partnerRef))!;
    const cp = { type: "PARTNER" as const, ref: partnerRef };

    // ---- v1: real upload + extraction + attach; decide; the KYC is applied to the CANONICAL owning store by the Head (identity category) ----
    const v1Bytes = signedPdf("v1");
    let detail = await uploadExtractAttach(manager, await fresh(manager, agreementRef), cp, { bytes: v1Bytes, fileName: "v1 signed.pdf" });
    detail = await acceptPending(manager, await decideAll(manager, detail, READY));
    expect(must(await getAgreementKycStatus(head, agreementRef), "kyc before")).toMatchObject({ state: "MISSING" });

    const applied = must(await applyKyc(head, agreementRef, 1, ["pan", "gst", "aadhaar"]), "apply KYC");
    expect(applied).toMatchObject({ counterpartyType: "PARTNER", components: ["pan", "gst", "aadhaar"] });
    // the canonical owning store now holds the values ...
    const canonical = (await restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("PARTNER", partner.uid)).get()).data()!;
    expect(JSON.stringify(canonical)).toContain(SENSITIVE.pan);
    // ... and Finance shows STATUS only: bank was never extractable, so the state is INCOMPLETE with bank MISSING
    expect(must(await getAgreementKycStatus(head, agreementRef), "kyc after")).toMatchObject({ state: "INCOMPLETE", components: { pan: "PRESENT", gst: "PRESENT", aadhaar: "PRESENT", bank: "MISSING" } });
    // a Manager (no identity category) sees the state only
    expect(JSON.stringify(must(await getAgreementKycStatus(manager, agreementRef), "manager kyc"))).not.toContain(SENSITIVE.pan);

    detail = await fresh(manager, agreementRef);
    detail = must(await confirmAgreementVersion(manager, { agreementRef, version: 1, expectedDocVersion: docVersionOf(detail) }, rid()), "confirm v1");
    const stored1 = must(await storeAgreementDocument(manager, { agreementRef, version: 1 }, rid()), "store v1");
    expect(stored1.agreement.selectedVersion!.document).toMatchObject({ status: "STORED" });
    detail = await fresh(head, agreementRef);
    detail = must(await activateAgreementVersion(head, { agreementRef, version: 1, expectedDocVersion: detail.head.docVersion }, rid()), "activate v1");
    expect(detail.head.status).toBe("ACTIVE");

    // ---- v2: a revision WITH a new signed file (its own physical file), superseding v1 atomically ----
    const revised = must(await createAgreementRevision(head, { agreementRef, expectedDocVersion: detail.head.docVersion }, rid()), "revise");
    expect(revised.selectedVersion!.version).toBe(2);
    const v2Bytes = signedPdf("v2");
    let v2 = await uploadExtractAttach(manager, revised, cp, { bytes: v2Bytes, fileName: "v2 signed.pdf" });
    v2 = await acceptPending(manager, await decideAll(manager, v2, [...READY.filter((seed) => seed.fieldKey !== "effectiveDate" && seed.fieldKey !== "terminationDate"), { fieldKey: "effectiveDate", decision: "CORRECTED", value: "2025-01-01" }, { fieldKey: "terminationDate", decision: "CORRECTED", value: "2025-12-31" }]));
    expect(must(await confirmAgreementVersion(manager, { agreementRef, version: 2, expectedDocVersion: docVersionOf(v2) }, rid()), "confirm v2").selectedVersion!.confirmed).toBe(true);
    must(await storeAgreementDocument(manager, { agreementRef, version: 2 }, rid()), "store v2");
    const beforeActivate = await fresh(head, agreementRef, 2);
    const active2 = must(await activateAgreementVersion(head, { agreementRef, version: 2, expectedDocVersion: beforeActivate.head.docVersion }, rid()), "activate v2");
    expect(active2.head).toMatchObject({ status: "ACTIVE", activeVersion: 2 });
    // atomic supersession: v1 is SUPERSEDED, v2 ACTIVE, never two live versions
    const versions = (await fresh(head, agreementRef)).versions;
    expect(versions.map((version) => [version.version, version.status])).toEqual(expect.arrayContaining([[1, "SUPERSEDED"], [2, "ACTIVE"]]));
    expect(versions.filter((version) => version.status === "ACTIVE" || version.status === "SUSPENDED")).toHaveLength(1);

    // ---- suspend / resume / end (history is never deleted) ----
    let live = await fresh(head, agreementRef);
    live = must(await suspendAgreement(head, { agreementRef, expectedDocVersion: live.head.docVersion, reason: "Paused for the closure certification" }, rid()), "suspend");
    expect(live.head.status).toBe("SUSPENDED");
    live = must(await resumeAgreement(head, { agreementRef, expectedDocVersion: live.head.docVersion }, rid()), "resume");
    expect(live.head.status).toBe("ACTIVE");
    live = must(await endAgreement(head, { agreementRef, expectedDocVersion: live.head.docVersion, reason: "Relationship concluded for the closure certification" }, rid()), "end");
    expect(live.head.status).toBe("ENDED");
    const finalVersions = (await fresh(head, agreementRef)).versions;
    expect(finalVersions.map((version) => version.version).sort()).toEqual([1, 2]);

    // ---- the fake Drive: exactly two physical files (one per version), the EXACT uploaded bytes, no KYC evidence, no identity value in any metadata ----
    expect(drive.storage.files).toHaveLength(2);
    const byVersion = new Map(drive.storage.files.map((file) => [file.metadata.version, file]));
    expect(sha256Hex(Buffer.from(byVersion.get(1)!.bytes))).toBe(sha256Hex(v1Bytes));
    expect(sha256Hex(Buffer.from(byVersion.get(2)!.bytes))).toBe(sha256Hex(v2Bytes));
    expect(Buffer.from(byVersion.get(1)!.bytes).equals(v1Bytes)).toBe(true);
    expect(byVersion.get(1)!.fileId).not.toBe(byVersion.get(2)!.fileId);
    for (const file of drive.storage.files) {
      expect(file.mimeType).toBe("application/pdf");
      expect(file.target).toBe("PARTNER");
      expect(Object.keys(file.metadata).sort()).toEqual(["agreementRef", "artifactSha256", "counterpartyRef", "counterpartyType", "version"]);
      expect(JSON.stringify([file.metadata, file.driveFileName, file.originalFileName])).not.toMatch(/ABCPE1234F|29ABCPE1234F1Z5|234123412346|123456789012|HDFC0001234/);
    }
    // the v1 reference stayed immutable when v2 was created (the projection still reads v1's own file)
    const listed = must(await listCounterpartyAgreementDocuments(head, { counterpartyType: "PARTNER", ref: partnerRef }), "list");
    const v1Row = listed.documents.find((row) => row.version === 1)!;
    const v2Row = listed.documents.find((row) => row.version === 2)!;
    expect(v1Row.document.link).toBe(byVersion.get(1)!.webViewLink);
    expect(v2Row.document.link).toBe(byVersion.get(2)!.webViewLink);
    expect(listed.documents.map((row) => [row.version, row.lifecycle])).toEqual(expect.arrayContaining([[1, "SUPERSEDED"], [2, "ENDED"]]));

    // ---- the walk: EVERY document of EVERY finance* collection ----
    const { unrestricted, restricted } = await walkFinanceCollections();
    expectNoIdentity(unrestricted, "unrestricted Finance documents");
    expect(unrestricted.some((doc) => doc.path.startsWith(`${FINANCE_AGREEMENT_COLLECTIONS.financeAgreements}/${agreementRef}/versions/2`))).toBe(true);
    expect(unrestricted.some((doc) => doc.path.startsWith(`${FINANCE_AGREEMENT_COLLECTIONS.financeAgreements}/${agreementRef}/events/`))).toBe(true);
    // the raw extracted values live ONLY in the restricted extraction store (server-only, never on a DTO)
    expect(restricted.some((doc) => doc.json.includes(SENSITIVE.pan))).toBe(true);
    // no DTO for any actor leaks a value: the Head's detail, the audit trail and the KYC status
    const events = must(await listAgreementEvents(head, agreementRef), "events");
    for (const dto of [await fresh(head, agreementRef), await fresh(manager, agreementRef), events, listed]) {
      const json = JSON.stringify(dto);
      for (const value of SENSITIVE_VALUES) expect(json.includes(value), `DTO holds ${value}`).toBe(false);
    }
  });
});

// =====================================================================================================================
describe("FULL JOURNEY - a new Vendor: canonical Vendor + canonical restricted KYC, no represented-Partner link, its own Drive target", () => {
  it("onboard -> extract -> KYC (PAN + GST only: a Vendor has no Aadhaar) -> confirm -> store -> activate; the Finance boundary holds and the Drive file targets the VENDOR folder", async () => {
    drive.storage.reset();
    const outcome = await onboard(manager, vendorRequest());
    const vendorRef = outcome.counterparty!.ref;
    const agreementRef = outcome.agreementRef!;
    const vendor = (await getVendorDocByRef(vendorRef))!;
    expect(outcome.accounts).toEqual([]);
    // never a represented-Partner link, never a Partner Account
    expect(await listVendorPartnerLinkDocsForVendor(vendorRef)).toEqual([]);

    const bytes = signedPdf("vendor-v1");
    let detail = await uploadExtractAttach(manager, await fresh(manager, agreementRef), { type: "VENDOR", ref: vendorRef }, { bytes, fileName: "vendor signed.pdf" });
    detail = await acceptPending(manager, await decideAll(manager, detail, READY));
    // Aadhaar is Partner-only: refused for a Vendor, PAN + GST are applied to the canonical VENDOR store
    expect(failed(await applyKyc(head, agreementRef, 1, ["aadhaar"]))).toMatchObject({ code: "invalid_input" });
    must(await applyKyc(head, agreementRef, 1, ["pan", "gst"]), "apply vendor KYC");
    const canonical = (await restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("VENDOR", vendor.uid)).get()).data()!;
    expect(canonical).toMatchObject({ subjectType: "VENDOR", pan: { number: SENSITIVE.pan }, aadhaar: null });
    expect(must(await getAgreementKycStatus(head, agreementRef), "kyc")).toMatchObject({ components: { pan: "PRESENT", gst: "PRESENT", aadhaar: "NOT_APPLICABLE", bank: "MISSING" } });

    detail = await fresh(manager, agreementRef);
    must(await confirmAgreementVersion(manager, { agreementRef, version: 1, expectedDocVersion: docVersionOf(detail) }, rid()), "confirm");
    must(await storeAgreementDocument(manager, { agreementRef, version: 1 }, rid()), "store");
    const before = await fresh(head, agreementRef);
    expect(must(await activateAgreementVersion(head, { agreementRef, version: 1, expectedDocVersion: before.head.docVersion }, rid()), "activate").head.status).toBe("ACTIVE");

    expect(drive.storage.files).toHaveLength(1);
    const file = drive.storage.files[0]!;
    expect(file.target).toBe("VENDOR");
    expect(file.metadata).toMatchObject({ counterpartyType: "VENDOR", counterpartyRef: vendorRef, agreementRef, version: 1 });
    expect(Buffer.from(file.bytes).equals(bytes)).toBe(true);
    // the same file id / link in Finance and in the Vendor projection
    const listed = must(await listCounterpartyAgreementDocuments(head, { counterpartyType: "VENDOR", ref: vendorRef }), "list");
    expect(listed.documents).toHaveLength(1);
    expect(listed.documents[0]!.document.link).toBe(file.webViewLink);
    expect(must(await getAgreementDocumentStatus(head, { agreementRef }), "status").document.link).toBe(file.webViewLink);
    // still no represented-Partner link after activation
    expect(await listVendorPartnerLinkDocsForVendor(vendorRef)).toEqual([]);

    const { unrestricted } = await walkFinanceCollections();
    expectNoIdentity(unrestricted, "unrestricted Finance documents (vendor journey)");
  });
});

// =====================================================================================================================
describe("EXISTING counterparty closure: only the MISSING KYC component is filled; master data and the other components are untouched; one Drive file per version", () => {
  it("PAN missing (Aadhaar / GST / bank on file): status names exactly PAN; applying PAN leaves the other components byte-identical; a second apply of an existing component is refused; the Partner record is unchanged", async () => {
    drive.storage.reset();
    const partner = await h.seedPartner();
    const subject = { type: "PARTNER" as const, uid: partner.uid, ref: partner.partnerRef };
    await h.seedRestrictedIdentity(subject, { aadhaar: true, bank: true, gst: "number", evidence: [] });
    const identityRef = restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("PARTNER", partner.uid));
    const partnerRefDoc = getAdminFirestore().collection("partners").doc(partner.uid);
    const partnerBefore = JSON.stringify((await partnerRefDoc.get()).data());

    const clientRequestId = h.uniqueClientRequestId();
    const created = must(await createAgreementDraft(manager, { clientRequestId, counterparty: { type: "PARTNER", partnerRef: partner.partnerRef } }, rid()), "create");
    const agreementRef = created.agreement.head.agreementRef;
    createdAgreements.push(agreementRef);
    h.trackClaim(agreementClaimId(manager.uid, clientRequestId));

    // per-component readiness BEFORE anything: PAN is the only missing component
    expect(must(await getAgreementKycStatus(head, agreementRef), "kyc")).toMatchObject({ state: "INCOMPLETE", components: { pan: "MISSING", aadhaar: "PRESENT", gst: "PRESENT", bank: "PRESENT" } });

    const bytes = signedPdf("existing-v1");
    let detail = await uploadExtractAttach(manager, created.agreement, { type: "PARTNER", ref: partner.partnerRef }, { bytes, fileName: "existing signed.pdf" });
    detail = await acceptPending(manager, await decideAll(manager, detail, READY));

    const before = (await identityRef.get()).data()!;
    // the PAN is missing => FILL_MISSING applies; an existing component is never silently replaced
    expect(failed(await applyKyc(head, agreementRef, 1, ["aadhaar"]))).toMatchObject({ code: "conflict" });
    expect(failed(await applyKyc(head, agreementRef, 1, ["pan", "gst"]))).toMatchObject({ code: "conflict" });
    expect(JSON.stringify((await identityRef.get()).data())).toBe(JSON.stringify(before));
    must(await applyKyc(head, agreementRef, 1, ["pan"]), "apply PAN");
    const after = (await identityRef.get()).data()!;
    expect(after).toMatchObject({ pan: { number: SENSITIVE.pan }, version: 2 });
    for (const key of ["aadhaar", "gst", "bank", "evidence"]) expect(JSON.stringify(after[key]), key).toBe(JSON.stringify(before[key]));
    // all complete => the Agreement KYC status is AVAILABLE and nothing further is offered
    expect(must(await getAgreementKycStatus(head, agreementRef), "kyc after")).toMatchObject({ state: "AVAILABLE", components: { pan: "PRESENT", aadhaar: "PRESENT", gst: "PRESENT", bank: "PRESENT" } });
    // the Partner master record is never written by any of it
    expect(JSON.stringify((await partnerRefDoc.get()).data())).toBe(partnerBefore);

    detail = await fresh(manager, agreementRef);
    must(await confirmAgreementVersion(manager, { agreementRef, version: 1, expectedDocVersion: docVersionOf(detail) }, rid()), "confirm");
    must(await storeAgreementDocument(manager, { agreementRef, version: 1 }, rid()), "store");
    const status = await fresh(head, agreementRef);
    must(await activateAgreementVersion(head, { agreementRef, version: 1, expectedDocVersion: status.head.docVersion }, rid()), "activate");

    // one durable file, exact bytes, the same reference in Finance and the Partner projection - and stored ONCE however often it is asked
    expect(drive.storage.files).toHaveLength(1);
    must(await storeAgreementDocument(manager, { agreementRef, version: 1 }, rid()), "store again");
    expect(drive.storage.files).toHaveLength(1);
    expect(drive.storage.calls.filter((call) => call.outcome === "created")).toHaveLength(1);
    const file = drive.storage.files[0]!;
    expect(Buffer.from(file.bytes).equals(bytes)).toBe(true);
    const listed = must(await listCounterpartyAgreementDocuments(head, { counterpartyType: "PARTNER", ref: partner.partnerRef }), "list");
    expect(listed.documents.map((row) => row.document.link)).toEqual([file.webViewLink]);
    expect((await fresh(head, agreementRef)).selectedVersion!.document.link).toBe(file.webViewLink);

    // a revision WITHOUT a new signed file says so explicitly (never shown as the prior file) and is not blocked from activation
    const live = await fresh(head, agreementRef);
    const revised = must(await createAgreementRevision(head, { agreementRef, expectedDocVersion: live.head.docVersion }, rid()), "revise");
    const noFile = must(await confirmAgreementVersion(manager, { agreementRef, version: 2, expectedDocVersion: docVersionOf(await acceptPending(manager, await decideAll(manager, revised, [{ fieldKey: "terminationDate", decision: "CORRECTED", value: "2025-06-30" }]))) }, rid()), "confirm v2");
    expect(noFile.selectedVersion!.document).toMatchObject({ status: "NOT_APPLICABLE", message: NO_NEW_SIGNED_DOCUMENT_MESSAGE, hasLink: false });
    expect(noFile.selectedVersion!.document.link).toBeUndefined();
    expect(failed(await storeAgreementDocument(manager, { agreementRef, version: 2 }, rid()))).toBeTruthy();
    expect(drive.storage.files).toHaveLength(1);
    const beforeActivate = await fresh(head, agreementRef, 2);
    expect(must(await activateAgreementVersion(head, { agreementRef, version: 2, expectedDocVersion: beforeActivate.head.docVersion }, rid()), "activate v2").head).toMatchObject({ status: "ACTIVE", activeVersion: 2 });
    // v1's reference is immutable and still v1's own file
    const listedAfter = must(await listCounterpartyAgreementDocuments(head, { counterpartyType: "PARTNER", ref: partner.partnerRef }), "list after");
    expect(listedAfter.documents.find((row) => row.version === 1)!.document.link).toBe(file.webViewLink);
    expect(listedAfter.documents.find((row) => row.version === 2)!.document).toMatchObject({ status: "NOT_APPLICABLE", hasLink: false });
  });
});

// =====================================================================================================================
// Overlap resolution by ENDING (real endAgreement, real "now"). An ENDED version governs only THROUGH its end date, so ending one of two
// overlapping open-ended Agreements resolves every month that lies wholly after the end date (the current month, unless today is its last UTC
// day) and NEVER rewrites an elapsed month the ended Agreement really governed - history is not re-attributed.
describe("overlap resolved by ending one Agreement (real clock)", () => {
  const p = createPolicyHarness("ccz");
  beforeAll(() => p.setup(), 60_000);
  afterAll(() => p.teardown());

  it("ending B resolves the CURRENT month to A, leaves the elapsed month a conflict (B governed it), and never touches A", async () => {
    const now = new Date();
    const monthKey = (offset: number) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    };
    const previous = monthKey(-1);
    const current = monthKey(0);
    const lastDayOfCurrent = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const openEnded = p.policyTerms({ effectiveDate: p.seed("effectiveDate", `${previous}-01`), terminationDate: p.decide("terminationDate", "UNAVAILABLE") });

    const partner = await p.seedPartner();
    const a = await p.activeAgreement(partner, p.decisionsWith(openEnded));
    const b = await p.activeAgreement(partner, p.decisionsWith(openEnded));
    const refs = [a.head.agreementRef, b.head.agreementRef].sort();
    expect(await getAgreementCommercialPolicy(partner.partnerRef, previous)).toEqual({ kind: "conflict", reason: "multiple_applicable_agreements", agreementRefs: refs });
    expect(await getAgreementCommercialPolicy(partner.partnerRef, current)).toEqual({ kind: "conflict", reason: "multiple_applicable_agreements", agreementRefs: refs });

    const headActor = await p.actorFor("partnership_head");
    must(await endAgreement(headActor, { agreementRef: b.head.agreementRef, expectedDocVersion: b.head.docVersion, reason: "Ended to resolve the overlap" }, p.requestId()), "end B");

    // the elapsed month B governed (through its end date) stays a conflict: ending is not retroactive
    expect(await getAgreementCommercialPolicy(partner.partnerRef, previous)).toEqual({ kind: "conflict", reason: "multiple_applicable_agreements", agreementRefs: refs });
    // the current month: B no longer covers the WHOLE month (it ended today), so only A governs - unless today is the month's last UTC day
    if (now.getUTCDate() < lastDayOfCurrent) {
      expect(await getAgreementCommercialPolicy(partner.partnerRef, current)).toMatchObject({ agreementRef: a.head.agreementRef, agreementVersion: 1 });
    } else {
      expect(await getAgreementCommercialPolicy(partner.partnerRef, current)).toMatchObject({ kind: "conflict" });
    }
    // A is untouched (still ACTIVE)
    expect((await getAgreementDetail(headActor, a.head.agreementRef)).ok).toBe(true);
  });
});

// =====================================================================================================================
// REPO-WIDE STATIC SCANS (closure conditions: no Payable / Invoice / Payment implementation; test seams unreachable from production;
// no wildcard / rank / role-name grant anywhere the closure touched).
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const srcDir = path.join(repoRoot, "src");
const relative = (file: string) => path.relative(repoRoot, file).split(path.sep).join("/");
const isTestFile = (file: string) => /\.(test|spec)\.tsx?$/.test(file);

function walkAll(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walkAll(full, into);
    else into.push(full);
  }
  return into;
}
const codeOf = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(\s)\/\/.*$/gm, "$1");

const allSrc = walkAll(srcDir);
const productionSrc = allSrc.filter((file) => /\.(ts|tsx)$/.test(file) && !isTestFile(file) && !/\/testing\//.test(relative(file)));

// Step 15A: Payables now EXIST - they are the next module of the canonical Finance flow
// (Agreement -> Payable -> Invoice -> approval -> Payment(s)), with their own module, routes and
// static guards (src/server/finance-payables/finance-payables-static.test.ts).
// Step 16A: Invoices now EXIST too, the same way - their own module, routes and static guards
// (src/server/finance-invoices/finance-invoices-static.test.ts).
// Step 16B (pre-existing gap fixed here, unrelated to Step 15C - discovered and corrected during
// Step 15C's own emulator regression, not caused by it - see that step's completion report): the
// real Invoice UI landed and replaced the invoices placeholder page, exactly as Payables UI did to
// this same block in Step 15B, but this file's own PLACEHOLDERS/INVOICE_OWNERS were never updated
// to match. What this block still certifies, unchanged and in full, is that PAYMENTS do not exist
// anywhere, and that everything Payable- or Invoice-shaped lives in exactly the places that are
// allowed to own it.
describe("no Payment implementation exists anywhere in src (Payables landed in Step 15A, Invoices landed in Step 16A/16B)", () => {
  // Payments remains the one fixture-only placeholder page (still not implemented). Invoices' own
  // placeholder page is gone - Step 16B replaced it with the real workspace.
  const PLACEHOLDERS = ["src/app/finance/payments/page.tsx"];
  // The only places a Payable-named path may live: the Payables module, its API routes, and (as of
  // Step 15B) its real UI - the three canonical routes under src/app/finance/payables/** and the
  // feature code under src/features/finance-payables/**.
  const PAYABLE_OWNERS = [/^src\/app\/finance\/payables\//, /^src\/features\/finance-payables\//, /^src\/server\/finance-payables\//, /^src\/app\/api\/finance\/payables\//];
  // The only places an Invoice-named path may live: the Invoices module, its API routes, and (as of
  // Step 16B) its real UI - the three canonical routes under src/app/finance/invoices/** and the
  // feature code under src/features/finance-invoices/**.
  const INVOICE_OWNERS = [/^src\/app\/finance\/invoices\//, /^src\/features\/finance-invoices\//, /^src\/server\/finance-invoices\//, /^src\/app\/api\/finance\/invoices\//];

  it("the only paths in src named payment / settlement are the Payments placeholder page, and every payable-/invoice-named path belongs to its own module, its routes or its placeholder page", () => {
    const paymentNamed = allSrc.map(relative).filter((file) => /(payment|settlement)/i.test(file));
    expect(paymentNamed.sort()).toEqual(["src/app/finance/payments/page.tsx"]);
    // no Payments API route exists
    expect(allSrc.map(relative).filter((file) => file.startsWith("src/app/api/") && /(payment|settlement)/i.test(file))).toEqual([]);

    // A payable-named path belongs to the Payables module itself, OR (Step 16A) to the Invoices
    // module - an Invoice legitimately pins and reads a Payable, so a file like
    // src/server/finance-invoices/payable-source.ts is expected and is still owned by Invoices, not
    // Payables (its own static guard - finance-invoices-static.test.ts - separately proves it never
    // writes Payable data).
    const payableNamed = allSrc.map(relative).filter((file) => /payable/i.test(file));
    expect(payableNamed.length).toBeGreaterThan(10);
    for (const file of payableNamed) expect(PAYABLE_OWNERS.some((owner) => owner.test(file)) || INVOICE_OWNERS.some((owner) => owner.test(file)), file).toBe(true);

    const invoiceNamed = allSrc.map(relative).filter((file) => /invoice/i.test(file));
    expect(invoiceNamed.length).toBeGreaterThan(10);
    for (const file of invoiceNamed) expect(INVOICE_OWNERS.some((owner) => owner.test(file)), file).toBe(true);
  });

  it("the placeholder page is a FIXTURE page: it imports only the shared shell / view / static fixtures - no server module, no fetch, no server action, no Firestore", () => {
    for (const file of PLACEHOLDERS) {
      const source = codeOf(readFileSync(path.join(repoRoot, file), "utf8"));
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
      expect(imports.sort(), file).toEqual(["@/features/finance/FinancePageShell", "@/features/finance/fixtures", "@/ui/WorkspaceView"].sort());
      expect(source, file).not.toMatch(/\bfetch\(|["']use server["']|firestore|@\/server|getAdmin/i);
    }
    // ... and the fixtures module is static data: no I/O, no server import
    for (const file of allSrc.filter((f) => relative(f).startsWith("src/features/finance/fixtures/") && /\.(ts|tsx)$/.test(f))) {
      const source = codeOf(readFileSync(file, "utf8"));
      expect(source, relative(file)).not.toMatch(/\bfetch\(|["']use server["']|firebase|firestore|@\/server|process\.env/i);
    }
  });

  it("no server / API / library code names a Payment / settlement collection, model, service function or Firestore path, and Payable / Invoice vocabulary appears only inside their own module and routes", () => {
    const serverSide = productionSrc.filter((file) => /^src\/(server|lib|app\/api)\//.test(relative(file)));
    expect(serverSide.length).toBeGreaterThan(300);
    for (const file of serverSide) {
      const source = codeOf(readFileSync(file, "utf8"));
      // a bare string literal equal to one of the words is how a collection / path / key would be declared
      expect(source, relative(file)).not.toMatch(/["'`](payments?|settlements?)["'`]/i);
      expect(source, relative(file)).not.toMatch(/\b(create|record|approve|settle|mark|issue|submit|generate)(Payment|Settlement)s?\b/);
      expect(source, relative(file)).not.toMatch(/\.(collection|collectionGroup)\(\s*["'`][^"'`]*(payment|settlement)/i);

      // Outside the Payables module and its routes, the Payable vocabulary is still forbidden -
      // no other module may declare a Payable collection or a Payable service function.
      if (!PAYABLE_OWNERS.some((owner) => owner.test(relative(file)))) {
        expect(source, relative(file)).not.toMatch(/["'`]payables?["'`]/i);
        expect(source, relative(file)).not.toMatch(/\b(create|record|approve|settle|mark|issue|submit|generate)Payables?\b/);
        expect(source, relative(file)).not.toMatch(/\.(collection|collectionGroup)\(\s*["'`][^"'`]*payable/i);
      }
      // Outside the Invoices module and its routes, the Invoice vocabulary is still forbidden - no
      // other module may declare an Invoice collection or an Invoice service function. The two
      // Finance placeholder pages import nothing server-side (proven separately above) so they never
      // reach this server/lib/api-scoped file set at all.
      if (!INVOICE_OWNERS.some((owner) => owner.test(relative(file)))) {
        expect(source, relative(file)).not.toMatch(/["'`]invoices?["'`]/i);
        expect(source, relative(file)).not.toMatch(/\b(create|record|approve|reject|reopen|void|submit)Invoices?\b/);
        expect(source, relative(file)).not.toMatch(/\.(collection|collectionGroup)\(\s*["'`][^"'`]*invoice/i);
      }
    }
    // Firestore configuration carries no Payment / settlement collection, exactly one Payable-shaped
    // collection group (the Payables head collection) and exactly the Invoices module's own two
    // collection groups (the Invoices head collection and its number-claim collection).
    for (const config of ["firestore.indexes.json", "firestore.rules"]) {
      const text = readFileSync(path.join(repoRoot, config), "utf8");
      expect(text, config).not.toMatch(/payment|settlement/i);
    }
    const indexes = JSON.parse(readFileSync(path.join(repoRoot, "firestore.indexes.json"), "utf8")) as { indexes: Array<{ collectionGroup: string }> };
    expect([...new Set(indexes.indexes.map((index) => index.collectionGroup).filter((name) => /payable/i.test(name)))]).toEqual(["financePayables"]);
    expect([...new Set(indexes.indexes.map((index) => index.collectionGroup).filter((name) => /invoice/i.test(name)))]).toEqual(["financeInvoices"]);
    expect(readFileSync(path.join(repoRoot, "firestore.rules"), "utf8")).not.toMatch(/payable/i);
    expect(readFileSync(path.join(repoRoot, "firestore.rules"), "utf8")).not.toMatch(/invoice/i);
  });

  it("Payable and Invoice permissions are each consumed ONLY by their own module and routes, and no Payment permission is consumed anywhere", () => {
    const CATALOG = ["src/server/authz/actions.ts", "src/server/authz/module-actions.ts", "src/server/authz/seed-access-data.ts"];
    const production = allSrc.filter((file) => /\.(ts|tsx)$/.test(file) && !isTestFile(file));

    // Payments: still catalog-only, exactly as Step 14A closed it.
    const paymentUsers = production.filter((file) => /\brecord_payments\b/.test(readFileSync(file, "utf8"))).map(relative).sort();
    expect(paymentUsers).toEqual(CATALOG);

    // Payables: the catalog plus the Payables module / routes, and nothing else.
    const payableUsers = production.filter((file) => /\b(manage|approve|adjust|void)_payables\b/.test(readFileSync(file, "utf8"))).map(relative).sort();
    expect(payableUsers.length).toBeGreaterThan(CATALOG.length);
    for (const file of payableUsers) expect(CATALOG.includes(file) || PAYABLE_OWNERS.some((owner) => owner.test(file)), file).toBe(true);

    // Invoices: the catalog plus the Invoices module / routes, and nothing else.
    const invoiceUsers = production.filter((file) => /\b(manage_invoices|approve_invoices|void_invoices|override_invoice_mismatch)\b/.test(readFileSync(file, "utf8"))).map(relative).sort();
    expect(invoiceUsers.length).toBeGreaterThan(CATALOG.length);
    for (const file of invoiceUsers) expect(CATALOG.includes(file) || INVOICE_OWNERS.some((owner) => owner.test(file)), file).toBe(true);
  });

  it("the Finance Agreement module itself carries no money calculation: no proration, tax, settlement or payout function is exported from it", () => {
    for (const file of productionSrc.filter((f) => relative(f).startsWith("src/server/finance-agreements/") || relative(f).startsWith("src/server/composition/"))) {
      const source = codeOf(readFileSync(file, "utf8"));
      expect(source, relative(file)).not.toMatch(/\bexport\s+(async\s+)?function\s+\w*(prorat|payout|disburse|remit|settle|calculatePay|computePay|taxAmount)\w*/i);
    }
  });
});

describe("test seams and injection points are unreachable from production code", () => {
  const SEAMS = ["setCommercialPolicyProviderForTests", "setAgreementDocumentStorageForTests", "setContractArtifactStoreForTests", "setOnboardingFaultHookForTests"];

  it("no production file (outside the seam's own module and its barrel) calls a *ForTests seam", () => {
    const definitionFiles = allSrc.filter((file) => /\.(ts|tsx)$/.test(file) && !isTestFile(file)).filter((file) => SEAMS.some((seam) => new RegExp(`(function|const)\\s+${seam}\\b`).test(readFileSync(file, "utf8")))).map(relative);
    expect(definitionFiles.length, "the seams are all still defined (the scan is not vacuous)").toBe(SEAMS.length);
    for (const file of productionSrc) {
      const source = codeOf(readFileSync(file, "utf8"));
      for (const seam of SEAMS) {
        if (!source.includes(seam)) continue;
        // only the defining module (and index barrels re-exporting it) may name it
        expect(definitionFiles.includes(relative(file)) || /\/index\.ts$/.test(relative(file)), `${relative(file)} names ${seam}`).toBe(true);
      }
    }
  });

  it("the instrumentation hook is the only production entry that starts the composition, and it is Node-runtime only", () => {
    const callers = productionSrc.filter((file) => /\bregisterServerProviders\s*\(/.test(codeOf(readFileSync(file, "utf8"))) && !/register-providers\.ts$/.test(file)).map(relative);
    expect(callers).toEqual(["src/instrumentation.ts"]);
    const source = codeOf(readFileSync(path.join(srcDir, "instrumentation.ts"), "utf8"));
    expect(source).toMatch(/NEXT_RUNTIME\s*===\s*"nodejs"/);
    expect(source).toMatch(/import\("@\/server\/composition\/register-providers"\)/);
  });
});

describe("explicit grants only across everything the closure touched (no rank / wildcard / minimumRole / role-name authorization)", () => {
  const touched = productionSrc.filter((file) => {
    const p = relative(file);
    return p.startsWith("src/server/finance-agreements/") || p.startsWith("src/server/composition/") || p.startsWith("src/features/finance-agreements/") || p.startsWith("src/app/api/finance/") || p.startsWith("src/app/finance/") || p === "src/server/shared/counterparty-dependency-guards.ts" || p === "src/instrumentation.ts";
  });

  it("no role read, role name, rank, minimumRole or wildcard grant appears in any of them", () => {
    expect(touched.length).toBeGreaterThan(100);
    for (const file of touched) {
      const source = codeOf(readFileSync(file, "utf8"));
      expect(source, relative(file)).not.toMatch(/\bactor\.role\b|\.role\s*(===|!==|==|!=)/);
      expect(source, relative(file)).not.toMatch(/["'`](viewer|analyst|partnership_manager|partnership_head|super_admin)["'`]/);
      expect(source, relative(file)).not.toMatch(/\bminimumRole\b|\broleRank\b|\bROLE_RANK\b|\bhasRoleAtLeast\b|\bisAtLeast\w*Role\b/i);
      // a wildcard permission / action / feature grant
      expect(source, relative(file)).not.toMatch(/(actions?|features?|permissions?|grants?)\s*:\s*\[?\s*["'`]\*["'`]/);
      expect(source, relative(file)).not.toMatch(/["'`](finance|partners|vendors)[:.]\*["'`]/);
    }
  });
});

// Step 14A - contract UPLOAD + EXTRACTION services against the running Firestore/Auth emulator (no Firestore mocks).
// Proves: the 10 MB PDF bound, idempotent-by-content upload, sanitized/opaque artifact DTOs (no locator/bucket/path/URL),
// live-scope neutrality for forged / foreign / out-of-scope refs, safe failure for malformed and scanned PDFs, the three
// extraction statuses, per-field provenance, that extraction never touches the head/version/Partner/Vendor/KYC records
// (nothing becomes operational until the explicit attach + a human decision), and that raw snippets / identity values are
// visible ONLY through finance_contracts (+ the counterparty's identity category for values).
//
// The artifact BYTES go to an in-memory ContractArtifactStore injected through setContractArtifactStoreForTests (restored
// afterEach) - the real Storage adapter is never used. The single mock is a DENY-ONLY wrapper over canAccessSensitive so a
// synthetic actor can hold finance_contracts without the identity category: seeded role grants are per ROLE (a shared
// document other test files read concurrently), so they are never edited here.
//
// Hermetic: every synthetic actor's ONLY scope is a per-run private REGION; private-region Partners/Vendors with unique ids;
// every created document (agreement heads + subcollections, claims, artifacts, restricted extractions, identities, grants)
// is removed afterwards.
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { COLLECTIONS } from "@/server/authz/firestore";
import { scopeGrantDocId } from "@/server/authz/scope";
import { seedAccessControlData } from "@/server/authz/seed-access-data";
import type { ActorContext, ScopeGrant, ScopeGrantInput } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { partnerAccountsCollection, partnersCollection } from "@/server/partners/firestore";
import { partnerAccountDocSchema, partnerDocSchema, type PartnerDoc } from "@/server/partners/types";
import { restrictedFinancialIdentitiesCollection, restrictedIdentityDocId, restrictedFinancialIdentityDocSchema } from "@/server/shared/restricted-financial-identity";
import { vendorsCollection } from "@/server/vendors/firestore";
import { vendorDocSchema, type VendorDoc } from "@/server/vendors/types";

// Deny-only: a listed (actor, category) pair is refused; everything else falls through to the REAL seeded grants.
const sensitiveDeny = vi.hoisted(() => new Map<string, Set<string>>());
vi.mock("@/server/authz/sensitive", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/authz/sensitive")>();
  return {
    ...original,
    canAccessSensitive: async (actor: { uid: string; role: string }, category: string) => {
      if (sensitiveDeny.get(actor.uid)?.has(category)) return false;
      return original.canAccessSensitive(actor as never, category);
    },
  };
});

import { ContractArtifactStoreError, createInMemoryArtifactStore, setContractArtifactStoreForTests } from "./contract-artifacts/store";
import { MAX_CONTRACT_PDF_BYTES } from "./contract-artifacts/validation";
import { contractArtifactClaimId, getContractArtifactSummary, uploadContractArtifact, type UploadContractArtifactOutcome } from "./contract-service";
import { extractContract, getExtractionResult } from "./extraction-service";
import {
  attachExtractionProposals,
  confirmAgreementVersion,
  createAgreementDraft,
  decideField,
  getAgreementDetail,
  type AgreementDetailDto,
  type CreateAgreementDraftOutcome,
} from "./index";
import type { ExtractionResultDto } from "./client-dto";
import { agreementClaimId, financeAgreementClaimsCollection, financeAgreementRestrictedExtractionsCollection, financeAgreementsCollection, financeContractArtifactsCollection } from "./firestore";
import { READY_DECISIONS, type FieldDecisionSeed } from "./testing/agreement-service-fixtures";
import { makeBlankPdf, makeEncryptedPdf, makeGarbagePdf, makeNotAPdf, makeTextPdf, makeTruncatedPdf } from "./testing/pdf-fixtures";
import { SAMPLE_AADHAAR, SAMPLE_CONTRACT_PAGES } from "./testing/sample-contract";
import { contractArtifactDocSchema, type AgreementCounterpartyInput, type FinanceAgreementsErrorResult, type FinanceAgreementsServiceResult } from "./types";

vi.setConfig({ testTimeout: 60_000 });

const runId = Date.now();
const R_IN = `fex-in-${runId}`;
const R_OUT = `fex-out-${runId}`;
const NEUTRAL = { ok: false, code: "not_found", message: "Not found." };

// The sample contract's identity values / snippet fragments: none may ever reach an ordinary DTO or an agreement doc.
const IDENTITY_STRINGS = ["ABCPE1234F", "29ABCPE1234F1Z5", "123456789012", "HDFC0001234", SAMPLE_AADHAAR, "2341 2341 2346"];
// (The PAN holder NAME is deliberately not in this list: it overlaps the ordinary counterparty name "Sample Creator Studio"; its own
// field is asserted RESTRICTED / value-less below, so the name is still never exposed AS the PAN holder.)
const SNIPPET_FRAGMENTS = ["Name as per PAN", "Aadhaar No", "Account Number:", "PAN: "];

const cleanup: FirebaseFirestore.DocumentReference[] = [];
const agreementRefs: string[] = [];
const claimIds: string[] = [];
const artifactRefs: string[] = [];
const restrictedRunRefs: string[] = [];
const grantDocIds: string[] = [];
let counter = 0;
let store = createInMemoryArtifactStore();

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
}, 60_000);

beforeEach(() => {
  store = createInMemoryArtifactStore();
  setContractArtifactStoreForTests(store);
});

afterEach(() => {
  setContractArtifactStoreForTests(null);
});

afterAll(async () => {
  const db = getAdminFirestore();
  for (const ref of agreementRefs.splice(0)) await db.recursiveDelete(financeAgreementsCollection().doc(ref));
  await Promise.all(claimIds.splice(0).map((id) => financeAgreementClaimsCollection().doc(id).delete()));
  await Promise.all(artifactRefs.splice(0).map((ref) => financeContractArtifactsCollection().doc(ref).delete()));
  await Promise.all(restrictedRunRefs.splice(0).map((ref) => financeAgreementRestrictedExtractionsCollection().doc(ref).delete()));
  await Promise.all(cleanup.splice(0).map((ref) => ref.delete()));
  await Promise.all(grantDocIds.splice(0).map((id) => db.collection(COLLECTIONS.scopeAssignments).doc(id).delete()));
});

// ---- Actors ------------------------------------------------------------------------------------------------------------
type Role = ActorContext["role"];

// A synthetic actor: the given ROLE's explicit feature/action/sensitive grants (accessGrants/{role}, sensitiveAccessGrants/{role})
// + a scope made of exactly the REGION grants named here - nothing else. `deny` subtracts sensitive categories for THIS actor only.
async function actor(role: Role, options: { grants?: ScopeGrantInput[]; deny?: string[] } = {}): Promise<ActorContext> {
  const grants = options.grants ?? [{ type: "REGION", region: R_IN }];
  const uid = `fex-${role}-${runId}-${randomUUID().slice(0, 6)}`;
  const grantedAt = new Date().toISOString();
  for (const input of grants) {
    const id = scopeGrantDocId(uid, input);
    await getAdminFirestore()
      .collection(COLLECTIONS.scopeAssignments)
      .doc(id)
      .set({ ...input, uid, grantedAt, grantedBy: "fex-test" } as ScopeGrant);
    grantDocIds.push(id);
  }
  if (options.deny?.length) sensitiveDeny.set(uid, new Set(options.deny));
  return { uid, email: `${uid}@example.test`, role, displayName: `FEX ${role}`, userRef: `fex-ref-${uid}` };
}

const outOfScope = (role: Role) => actor(role, { grants: [{ type: "REGION", region: R_OUT }] });

// ---- Fixtures ----------------------------------------------------------------------------------------------------------
async function seedPartner(regionIds: string[] = [R_IN]): Promise<PartnerDoc> {
  counter += 1;
  const uid = `fex-partner-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = `FEX Partner ${counter} ${runId}`;
  const partner = partnerDocSchema.parse({
    uid,
    partnerRef: `ref-${uid}`,
    version: 1,
    displayName,
    displayNameLower: displayName.toLowerCase(),
    legalName: null,
    email: `partner-${counter}@example.test`,
    phone: "+91 90000 00000",
    status: "ACTIVE",
    regionIds,
    createdAt: now,
    createdByUserRef: "fex-test",
    updatedAt: now,
    updatedByUserRef: "fex-test",
  });
  const ref = partnersCollection().doc(uid);
  await ref.set(partner);
  cleanup.push(ref);
  return partner;
}

async function seedAccount(partner: PartnerDoc, platform: string) {
  counter += 1;
  const uid = `fex-account-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const account = partnerAccountDocSchema.parse({
    uid,
    partnerAccountRef: `ref-${uid}`,
    version: 1,
    partnerRef: partner.partnerRef,
    platform,
    normalizedIdentity: `${platform.trim().toLowerCase()}:${uid}`,
    status: "ACTIVE",
    createdAt: now,
    createdByUserRef: "fex-test",
    updatedAt: now,
    updatedByUserRef: "fex-test",
  });
  const ref = partnerAccountsCollection().doc(uid);
  await ref.set(account);
  cleanup.push(ref);
  return account;
}

async function seedVendor(regionIds: string[] = [R_IN]): Promise<VendorDoc> {
  counter += 1;
  const uid = `fex-vendor-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = `FEX Vendor ${counter} ${runId}`;
  const vendor = vendorDocSchema.parse({
    uid,
    vendorRef: `ref-${uid}`,
    version: 1,
    displayName,
    displayNameLower: displayName.toLowerCase(),
    vendorType: "AGENCY",
    email: `vendor-${counter}@example.test`,
    status: "ACTIVE",
    regionIds,
    createdAt: now,
    createdByUserRef: "fex-test",
    updatedAt: now,
    updatedByUserRef: "fex-test",
  });
  const ref = vendorsCollection().doc(uid);
  await ref.set(vendor);
  cleanup.push(ref);
  return vendor;
}

// An existing canonical KYC record (invented values) whose documents extraction must never touch.
async function seedRestrictedIdentity(subject: { type: "PARTNER" | "VENDOR"; uid: string; ref: string }) {
  const now = new Date().toISOString();
  const doc = restrictedFinancialIdentityDocSchema.parse({
    uid: restrictedIdentityDocId(subject.type, subject.uid),
    subjectType: subject.type,
    subjectRef: subject.ref,
    version: 1,
    pan: { number: "QWERT4321Z" },
    aadhaar: null,
    gst: null,
    bank: { accountHolderName: "Zed Holder Name", accountNumber: "998877665544", ifsc: "TEST0009876", bankName: "Test Bank", branchName: "Test Branch" },
    updatedAt: now,
    updatedByUserRef: "fex-test",
  });
  const ref = restrictedFinancialIdentitiesCollection().doc(doc.uid);
  await ref.set(doc);
  cleanup.push(ref);
  return ref;
}

// ---- Result / call helpers ---------------------------------------------------------------------------------------------
function must<T>(result: FinanceAgreementsServiceResult<T>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.code} - ${result.message}${result.blockers ? ` ${JSON.stringify(result.blockers)}` : ""}`);
  return result.data;
}
function failed<T>(result: FinanceAgreementsServiceResult<T>): FinanceAgreementsErrorResult {
  if (result.ok) throw new Error("expected a failure");
  return result;
}

const partnerCp = (partner: PartnerDoc, accountRefs?: string[]): AgreementCounterpartyInput => ({ type: "PARTNER", partnerRef: partner.partnerRef, ...(accountRefs ? { partnerAccountRefs: accountRefs } : {}) });
const vendorCp = (vendor: VendorDoc): AgreementCounterpartyInput => ({ type: "VENDOR", vendorRef: vendor.vendorRef });
const cpOf = (counterparty: AgreementCounterpartyInput) => (counterparty.type === "PARTNER" ? { type: "PARTNER" as const, ref: counterparty.partnerRef } : { type: "VENDOR" as const, ref: counterparty.vendorRef });

let reqCounter = 0;
const requestId = () => `req-${runId}-${(reqCounter += 1)}`;

async function newAgreement(who: ActorContext, counterparty: AgreementCounterpartyInput): Promise<CreateAgreementDraftOutcome> {
  const clientRequestId = `crid-${runId}-${(counter += 1)}-${randomUUID().slice(0, 6)}`;
  const outcome = must(await createAgreementDraft(who, { clientRequestId, counterparty }, requestId()), "create");
  agreementRefs.push(outcome.agreement.head.agreementRef);
  claimIds.push(agreementClaimId(who.uid, clientRequestId));
  return outcome;
}

// Uploads bytes and registers the artifact + claim for cleanup.
async function upload(who: ActorContext, counterparty: AgreementCounterpartyInput, bytes: Uint8Array, fileName = "contract.pdf") {
  const cp = cpOf(counterparty);
  const result = await uploadContractArtifact(who, { fileName, bytes, counterparty: cp }, requestId());
  if (result.ok) {
    artifactRefs.push(result.data.artifact.artifactRef);
    const stored = await financeContractArtifactsCollection().doc(result.data.artifact.artifactRef).get();
    const sha = (stored.data() as { sha256: string }).sha256;
    claimIds.push(contractArtifactClaimId(cp.type, cp.ref, sha));
  }
  return result;
}

async function extract(who: ActorContext, agreementRef: string, artifactRef: string, version = 1) {
  const result = await extractContract(who, { agreementRef, version, artifactRef }, requestId());
  if (result.ok) restrictedRunRefs.push(result.data.run.runRef);
  return result;
}

const SAMPLE_PDF = () => makeTextPdf(SAMPLE_CONTRACT_PAGES);

// Uploads + extracts the sample contract for a fresh agreement.
async function extractedSample(manager: ActorContext, counterparty: AgreementCounterpartyInput) {
  const created = await newAgreement(manager, counterparty);
  const uploaded = must(await upload(manager, counterparty, SAMPLE_PDF()), "upload");
  const agreementRef = created.agreement.head.agreementRef;
  const result = must(await extract(manager, agreementRef, uploaded.artifact.artifactRef), "extract");
  return { agreementRef, artifactRef: uploaded.artifact.artifactRef, created, result };
}

// A doc's exact content + last write time: identical before and after == untouched.
async function fingerprint(ref: FirebaseFirestore.DocumentReference) {
  const snapshot = await ref.get();
  return { exists: snapshot.exists, data: JSON.stringify(snapshot.data() ?? null), updateTime: snapshot.updateTime?.toMillis() ?? null };
}

// Every document the agreement owns (head + every subcollection doc), as one JSON string per doc.
async function agreementDocsJson(agreementRef: string): Promise<string[]> {
  const head = financeAgreementsCollection().doc(agreementRef);
  const out: string[] = [JSON.stringify((await head.get()).data() ?? null)];
  for (const collection of await head.listCollections()) {
    const snapshot = await collection.get();
    for (const doc of snapshot.docs) out.push(JSON.stringify(doc.data()));
  }
  return out;
}

// A JSON-walk: every key and every string in the value.
function walk(value: unknown, visit: (kind: "key" | "string", text: string) => void): void {
  if (typeof value === "string") visit("string", value);
  else if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      visit("key", key);
      walk(child, visit);
    }
  }
}

function expectNoIdentity(value: unknown, label: string) {
  const json = JSON.stringify(value);
  for (const secret of IDENTITY_STRINGS) expect(json, `${label}: ${secret}`).not.toContain(secret);
}
function expectNoSnippetText(value: unknown, label: string) {
  const json = JSON.stringify(value);
  for (const fragment of SNIPPET_FRAGMENTS) expect(json, `${label}: ${fragment}`).not.toContain(fragment);
}

const field = (dto: ExtractionResultDto, key: string) => dto.fields.find((f) => f.fieldKey === key);

// ======================================================================================================================
describe("uploadContractArtifact", () => {
  it("accepts a PDF of EXACTLY 10 MB, rejects +1 byte, empty and non-PDF bytes with a safe reason and no echoed bytes", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const cp = partnerCp(partner);
    const header = SAMPLE_PDF();

    const exactly = Buffer.concat([header, Buffer.alloc(MAX_CONTRACT_PDF_BYTES - header.length, 0x20)]);
    expect(exactly.length).toBe(MAX_CONTRACT_PDF_BYTES);
    const ok = must(await upload(manager, cp, exactly, "big.pdf"), "10 MB");
    expect(ok.created).toBe(true);
    expect(ok.artifact.sizeBytes).toBe(MAX_CONTRACT_PDF_BYTES);

    const over = Buffer.concat([exactly, Buffer.from([0x20])]);
    expect(failed(await upload(manager, cp, over))).toMatchObject({ code: "invalid_input", message: "The contract file is larger than the 10 MB limit." });
    expect(failed(await upload(manager, cp, Buffer.alloc(0)))).toMatchObject({ code: "invalid_input", message: "The contract file is empty." });
    const notPdf = failed(await upload(manager, cp, makeNotAPdf()));
    expect(notPdf).toMatchObject({ code: "invalid_input", message: "The contract file is not a PDF." });
    expect(JSON.stringify(notPdf)).not.toContain("plain text file");
    // a rejected upload stores nothing (only the accepted 10 MB object exists)
    expect(store.size).toBe(1);
  });

  it("creates ONE restricted artifact document; the DTO exposes only safe metadata (JSON-walk: no locator / bucket / path / URL key or value)", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const outcome = must(await upload(manager, partnerCp(partner), SAMPLE_PDF(), "../../secret dir/Signed Contract (final).pdf"), "upload");
    expect(outcome.created).toBe(true);

    const dto = outcome.artifact;
    expect(dto).toMatchObject({ mimeType: "application/pdf", status: "UPLOADED", fileName: "Signed Contract (final).pdf", counterparty: { type: "PARTNER", ref: partner.partnerRef }, uploadedByUserRef: manager.userRef });
    expect(dto.artifactRef).toMatch(/^ca_[0-9a-f]{20}$/);
    expect(dto.sha256Prefix).toMatch(/^[0-9a-f]{12}$/);
    expect(dto.sizeBytes).toBe(SAMPLE_PDF().length);

    const stored = contractArtifactDocSchema.parse((await financeContractArtifactsCollection().doc(dto.artifactRef).get()).data());
    expect(stored.storageLocator.length).toBeGreaterThan(0);
    walk(dto, (kind, text) => {
      if (kind === "key") expect(text).not.toMatch(/locator|bucket|path|url|signed|storage/i);
      else {
        expect(text).not.toContain(stored.storageLocator);
        expect(text).not.toMatch(/finance-contracts\/|https?:\/\/|gs:\/\//i);
      }
    });
    // the bytes are behind the store interface, addressed only by the server-only locator
    expect(Buffer.from(await store.get(stored.storageLocator)).equals(SAMPLE_PDF())).toBe(true);
  });

  it("is idempotent by content: the same bytes for the same counterparty re-use the artifact (also under concurrency); other bytes or another counterparty get their own", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const otherPartner = await seedPartner();
    const cp = partnerCp(partner);

    const first = must(await upload(manager, cp, SAMPLE_PDF()), "first");
    const again = must(await upload(manager, cp, SAMPLE_PDF(), "renamed.pdf"), "again");
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.artifact.artifactRef).toBe(first.artifact.artifactRef);
    expect(again.artifact.fileName).toBe(first.artifact.fileName);
    expect(store.size).toBe(1);

    const different = must(await upload(manager, cp, makeTextPdf([["different contract body with enough characters to count as text"]])), "different");
    expect(different.artifact.artifactRef).not.toBe(first.artifact.artifactRef);
    const foreign = must(await upload(manager, partnerCp(otherPartner), SAMPLE_PDF()), "other counterparty");
    expect(foreign.artifact.artifactRef).not.toBe(first.artifact.artifactRef);

    const racing = makeTextPdf([["concurrent upload body with enough characters to count as text"]]);
    const results = await Promise.all([1, 2, 3, 4].map(() => upload(manager, cp, racing)));
    const outcomes = results.map((result) => must(result, "race") as UploadContractArtifactOutcome);
    expect(new Set(outcomes.map((o) => o.artifact.artifactRef)).size).toBe(1);
    expect(outcomes.filter((o) => o.created)).toHaveLength(1);
  });

  it("is gated: unauthenticated, Viewer and Analyst are unauthorized; Manager, Head and Super Admin may upload", async () => {
    const partner = await seedPartner();
    const cp = partnerCp(partner);
    expect(failed(await uploadContractArtifact(null, { fileName: "c.pdf", bytes: SAMPLE_PDF(), counterparty: cpOf(cp) }, requestId()))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
    for (const role of ["viewer", "analyst"] as const) expect(failed(await upload(await actor(role), cp, SAMPLE_PDF()))).toMatchObject({ code: "unauthorized" });
    for (const role of ["partnership_manager", "partnership_head", "super_admin"] as const) expect(must(await upload(await actor(role), cp, SAMPLE_PDF()), role).artifact.status).toBe("UPLOADED");
  });

  it("a forged, foreign, out-of-scope or wrongly-typed counterparty is the SAME neutral not_found (nothing stored); bad input shapes are invalid_input", async () => {
    const manager = await actor("partnership_manager");
    const outsider = await seedPartner([R_OUT]);
    const insider = await seedPartner();
    const vendor = await seedVendor([R_OUT]);

    expect(failed(await upload(manager, partnerCp(outsider), SAMPLE_PDF()))).toEqual(NEUTRAL);
    expect(failed(await upload(manager, vendorCp(vendor), SAMPLE_PDF()))).toEqual(NEUTRAL);
    expect(failed(await upload(manager, { type: "PARTNER", partnerRef: "ref-does-not-exist" }, SAMPLE_PDF()))).toEqual(NEUTRAL);
    // a Partner ref named as a Vendor
    expect(failed(await uploadContractArtifact(manager, { fileName: "c.pdf", bytes: SAMPLE_PDF(), counterparty: { type: "VENDOR", ref: insider.partnerRef } }, requestId()))).toEqual(NEUTRAL);
    expect(store.size).toBe(0);

    for (const bad of [{ fileName: "c.pdf", counterparty: { type: "PARTNER", ref: insider.partnerRef } }, { fileName: "c.pdf", bytes: "not bytes", counterparty: { type: "PARTNER", ref: insider.partnerRef } }, { fileName: "", bytes: SAMPLE_PDF(), counterparty: { type: "PARTNER", ref: insider.partnerRef } }, { fileName: "c.pdf", bytes: SAMPLE_PDF(), counterparty: { type: "PARTNER", ref: insider.partnerRef }, scope: "GLOBAL" }]) {
      expect(failed(await uploadContractArtifact(manager, bad, requestId()))).toMatchObject({ code: "invalid_input" });
    }
  });

  it("a storage failure is a safe internal error that echoes nothing and leaves no artifact document", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    setContractArtifactStoreForTests({
      async put() {
        throw new ContractArtifactStoreError("not_configured", "FIREBASE_STORAGE_BUCKET is not set: secret-bucket-name");
      },
      async get() {
        throw new Error("unused");
      },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = failed(await uploadContractArtifact(manager, { fileName: "c.pdf", bytes: SAMPLE_PDF(), counterparty: cpOf(partnerCp(partner)) }, requestId()));
    errorSpy.mockRestore();
    expect(result).toEqual({ ok: false, code: "internal", message: "The contract could not be stored. Try again." });
    expect(JSON.stringify(result)).not.toContain("secret-bucket-name");
  });
});

// ======================================================================================================================
describe("extractContract", () => {
  it("a real text PDF extracts EXTRACTED/PARTIAL with per-field provenance; the ordinary DTO carries no identity value and no raw snippet", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const { result, agreementRef, artifactRef } = await extractedSample(manager, partnerCp(partner));

    expect(["EXTRACTED", "PARTIAL"]).toContain(result.run.status);
    expect(result.run).toMatchObject({ artifactRef, pageCount: 3 });
    expect(result.run.runRef).toMatch(/^run_[0-9a-f]{20}$/);
    expect(result.run.parserVersion).toMatch(/^unpdf@/);
    expect(result.fields.length).toBeGreaterThan(15);
    for (const item of result.fields) {
      expect(item.requiresHumanConfirmation).toBe(true);
      expect(["HIGH", "MEDIUM", "LOW", "UNKNOWN"]).toContain(item.confidence);
      expect(item.page).toBeGreaterThanOrEqual(1);
      expect(item.page).toBeLessThanOrEqual(3);
      expect(Array.isArray(item.warnings)).toBe(true);
    }
    expect(field(result, "effectiveDate")).toMatchObject({ normalizedValue: "2025-04-01", page: 2, valueState: "VISIBLE" });
    expect(field(result, "effectiveDate")!.warnings).toContain("day_month_order_assumed_dd_mm");
    expect(field(result, "incentive")).toMatchObject({ page: 3 });
    expect(field(result, "fixedComponent")).toMatchObject({ normalizedValue: { applicable: true, amountMinor: 2_500_000 } });
    for (const key of ["panNumber", "gstin", "aadhaarNumber", "bankAccountNumber", "ifsc", "panHolderName"]) expect(field(result, key)).toMatchObject({ valueState: "RESTRICTED", normalizedValue: null });

    // a Manager holds manage_agreements but neither finance_contracts nor the identity category
    expect(result.contractDetailVisible).toBe(false);
    expect(result.identityValuesVisible).toBe(false);
    expect(result.restricted).toBeNull();
    expectNoIdentity(result, "manager DTO");
    expectNoSnippetText(result, "manager DTO");

    // persisted separation: the ordinary run + every agreement doc hold no identity value / snippet; the restricted record does
    for (const json of await agreementDocsJson(agreementRef)) {
      for (const secret of IDENTITY_STRINGS) expect(json, secret).not.toContain(secret);
      expect(json).not.toContain("rawSnippet");
    }
    const restrictedJson = JSON.stringify((await financeAgreementRestrictedExtractionsCollection().doc(result.run.runRef).get()).data());
    expect(restrictedJson).toContain("ABCPE1234F");
    expect(restrictedJson).toContain("rawSnippet");
  });

  it("all three statuses are reachable: EXTRACTED, PARTIAL (no effective date) and MANUAL_REVIEW_REQUIRED (too few fields)", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const cp = partnerCp(partner);
    const created = await newAgreement(manager, cp);
    const agreementRef = created.agreement.head.agreementRef;
    const run = async (bytes: Uint8Array) => must(await extract(manager, agreementRef, must(await upload(manager, cp, bytes), "upload").artifact.artifactRef), "extract");

    const full = await run(SAMPLE_PDF());
    expect(full.run.status).toBe("EXTRACTED");

    const withoutEffective = await run(makeTextPdf(SAMPLE_CONTRACT_PAGES.map((page) => page.filter((line) => !/^Effective Date/i.test(line)))));
    expect(withoutEffective.run.status).toBe("PARTIAL");
    expect(withoutEffective.run.reasonCodes).toEqual(expect.arrayContaining(["missing_core_fields", "missing_core:effectiveDate"]));
    expect(withoutEffective.reasons.find((r) => r.code === "missing_core_fields")!.message).toMatch(/core fields/);

    const thin = await run(makeTextPdf([["A short memo that names nothing extractable but is long enough to count as real text."]]));
    expect(thin.run.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(thin.run.reasonCodes).toContain("few_fields");
  });

  it("a scanned / blank PDF is MANUAL_REVIEW_REQUIRED with no_extractable_text (no OCR adapter is said plainly) and no proposals", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const { result, artifactRef } = await (async () => {
      const created = await newAgreement(manager, partnerCp(partner));
      const uploaded = must(await upload(manager, partnerCp(partner), makeBlankPdf(3)), "upload");
      const done = must(await extract(manager, created.agreement.head.agreementRef, uploaded.artifact.artifactRef), "extract");
      return { result: done, artifactRef: uploaded.artifact.artifactRef };
    })();
    expect(result.run).toMatchObject({ status: "MANUAL_REVIEW_REQUIRED", reasonCodes: ["no_extractable_text"], pageCount: 3, charCount: 0 });
    expect(result.fields).toEqual([]);
    expect(result.reasons).toEqual([{ code: "no_extractable_text", message: expect.stringMatching(/No OCR adapter is configured/) }]);
    // the artifact records the outcome
    expect((await financeContractArtifactsCollection().doc(artifactRef).get()).data()).toMatchObject({ status: "MANUAL_REVIEW_REQUIRED" });
  });

  it.each([
    ["garbage after a PDF header", () => makeGarbagePdf(), "unreadable_pdf"],
    ["a truncated PDF", () => makeTruncatedPdf(), "unreadable_pdf"],
    ["an encrypted PDF", () => makeEncryptedPdf(), "encrypted"],
  ])("%s never throws: a safe MANUAL_REVIEW_REQUIRED with a reason code and no partial garbage", async (_label, make, reason) => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const created = await newAgreement(manager, partnerCp(partner));
    const uploaded = must(await upload(manager, partnerCp(partner), make()), "upload");
    const result = must(await extract(manager, created.agreement.head.agreementRef, uploaded.artifact.artifactRef), "extract");
    expect(result.run.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(result.run.reasonCodes).toContain(reason);
    expect(result.fields).toEqual([]);
    expect((await financeContractArtifactsCollection().doc(uploaded.artifact.artifactRef).get()).data()).toMatchObject({ status: "MANUAL_REVIEW_REQUIRED" });
  });

  it("a successful run marks the artifact EXTRACTED; a stored object that no longer matches its checksum is never parsed", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const { artifactRef } = await extractedSample(manager, partnerCp(partner));
    expect((await financeContractArtifactsCollection().doc(artifactRef).get()).data()).toMatchObject({ status: "EXTRACTED" });

    const created = await newAgreement(manager, partnerCp(partner));
    const uploaded = must(await upload(manager, partnerCp(partner), makeTextPdf([["a second contract body that is long enough to count as real text"]])), "upload");
    const locator = contractArtifactDocSchema.parse((await financeContractArtifactsCollection().doc(uploaded.artifact.artifactRef).get()).data()).storageLocator;
    // corrupt the stored bytes behind the store (same size class, different content)
    const swapped = createInMemoryArtifactStore();
    await swapped.put({ artifactRef: locator.replace(/^finance-contracts\//, "").replace(/\.pdf$/, ""), bytes: SAMPLE_PDF(), mimeType: "application/pdf" });
    setContractArtifactStoreForTests(swapped);
    const result = must(await extract(manager, created.agreement.head.agreementRef, uploaded.artifact.artifactRef), "extract");
    expect(result.run).toMatchObject({ status: "MANUAL_REVIEW_REQUIRED" });
    expect(result.run.reasonCodes).toEqual(["unreadable_pdf", "artifact_integrity_mismatch"]);
    expect(result.fields).toEqual([]);
  });

  it("NEVER attaches, confirms, activates or touches the head, version, events, Partner, Partner Account or KYC records (fingerprints identical)", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const account = await seedAccount(partner, "instagram");
    const identityRef = await seedRestrictedIdentity({ type: "PARTNER", uid: partner.uid, ref: partner.partnerRef });
    const created = await newAgreement(manager, partnerCp(partner, [account.partnerAccountRef]));
    const agreementRef = created.agreement.head.agreementRef;
    const uploaded = must(await upload(manager, partnerCp(partner), SAMPLE_PDF()), "upload");

    const watched = [financeAgreementsCollection().doc(agreementRef), financeAgreementsCollection().doc(agreementRef).collection("versions").doc("1"), partnersCollection().doc(partner.uid), partnerAccountsCollection().doc(account.uid), identityRef];
    const before = await Promise.all(watched.map(fingerprint));
    const eventsBefore = (await financeAgreementsCollection().doc(agreementRef).collection("events").get()).size;

    const result = must(await extract(manager, agreementRef, uploaded.artifact.artifactRef), "extract");
    expect(["EXTRACTED", "PARTIAL"]).toContain(result.run.status);

    expect(await Promise.all(watched.map(fingerprint))).toEqual(before);
    expect((await financeAgreementsCollection().doc(agreementRef).collection("events").get()).size).toBe(eventsBefore);

    const detail = must(await getAgreementDetail(manager, agreementRef), "detail");
    expect(detail.head).toMatchObject({ status: "DRAFT", openVersion: 1, activeVersion: null });
    // parser output never became a draft value / truth
    expect(Object.values(detail.selectedVersion!.draft).filter((entry) => entry?.origin === "EXTRACTED")).toEqual([]);
    expect(detail.selectedVersion).toMatchObject({ confirmed: false, status: "DRAFT", terms: null, source: { contractArtifactRef: null, extractionRunRef: null } });
  });

  it("the artifact must belong to the SAME counterparty as the agreement; forged / foreign / out-of-scope refs are the neutral not_found", async () => {
    const manager = await actor("partnership_manager");
    const partnerA = await seedPartner();
    const partnerB = await seedPartner();
    const vendor = await seedVendor();
    const agreementA = (await newAgreement(manager, partnerCp(partnerA))).agreement.head.agreementRef;
    const artifactOfB = must(await upload(manager, partnerCp(partnerB), SAMPLE_PDF()), "B").artifact.artifactRef;
    const artifactOfVendor = must(await upload(manager, vendorCp(vendor), SAMPLE_PDF()), "vendor").artifact.artifactRef;
    const artifactOfA = must(await upload(manager, partnerCp(partnerA), SAMPLE_PDF()), "A").artifact.artifactRef;

    expect(failed(await extract(manager, agreementA, artifactOfB))).toEqual(NEUTRAL);
    expect(failed(await extract(manager, agreementA, artifactOfVendor))).toEqual(NEUTRAL);
    expect(failed(await extract(manager, agreementA, `ca_${"0".repeat(20)}`))).toEqual(NEUTRAL);
    expect(failed(await extract(manager, `agr_${"0".repeat(20)}`, artifactOfA))).toEqual(NEUTRAL);
    // a different Vendor agreement cannot take a Partner's artifact either
    const vendorAgreement = (await newAgreement(manager, vendorCp(vendor))).agreement.head.agreementRef;
    expect(failed(await extract(manager, vendorAgreement, artifactOfA))).toEqual(NEUTRAL);

    // out of scope: same manager role, but scope R_OUT only
    const outsider = await outOfScope("partnership_manager");
    expect(failed(await extract(outsider, agreementA, artifactOfA))).toEqual(NEUTRAL);
    // malformed refs are an input error, not a probe
    expect(failed(await extractContract(manager, { agreementRef: agreementA, version: 1, artifactRef: "nope" }, requestId()))).toMatchObject({ code: "invalid_input" });
    expect(failed(await extractContract(manager, { agreementRef: agreementA, version: 1, artifactRef: artifactOfA, counterparty: { type: "VENDOR" } }, requestId()))).toMatchObject({ code: "invalid_input" });
    // nothing was ever recorded for any refusal
    expect((await financeAgreementsCollection().doc(agreementA).collection("extractionRuns").get()).size).toBe(0);
  });

  it("is gated: unauthenticated, Viewer and Analyst are unauthorized; only the named version that is the open unconfirmed one may be extracted into", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const created = await newAgreement(manager, partnerCp(partner));
    const agreementRef = created.agreement.head.agreementRef;
    const artifactRef = must(await upload(manager, partnerCp(partner), SAMPLE_PDF()), "upload").artifact.artifactRef;

    expect(failed(await extractContract(null, { agreementRef, version: 1, artifactRef }, requestId()))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
    for (const role of ["viewer", "analyst"] as const) expect(failed(await extract(await actor(role), agreementRef, artifactRef))).toMatchObject({ code: "unauthorized" });
    expect(failed(await extract(manager, agreementRef, artifactRef, 2))).toMatchObject({ code: "conflict" });
    expect(must(await extract(await actor("partnership_head"), agreementRef, artifactRef), "head").run.runRef).toMatch(/^run_/);
  });

  it("a confirmed version can no longer be extracted into (conflict) and stays byte-identical", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const created = await newAgreement(manager, partnerCp(partner));
    const agreementRef = created.agreement.head.agreementRef;
    let detail: AgreementDetailDto = created.agreement;
    const decide = async (seed: FieldDecisionSeed) => {
      detail = must(await decideField(manager, { agreementRef, version: 1, expectedDocVersion: detail.selectedVersion!.docVersion, fieldKey: seed.fieldKey, decision: seed.decision, ...(seed.value !== undefined ? { value: seed.value } : {}) }, requestId()), `decide ${seed.fieldKey}`);
    };
    for (const seed of READY_DECISIONS) await decide(seed);
    for (const [fieldKey, entry] of Object.entries(detail.selectedVersion!.draft)) if (entry?.decision === "PENDING") await decide({ fieldKey: fieldKey as FieldDecisionSeed["fieldKey"], decision: "ACCEPTED" });
    const confirmed = must(await confirmAgreementVersion(manager, { agreementRef, version: 1, expectedDocVersion: detail.selectedVersion!.docVersion }, requestId()), "confirm");
    expect(confirmed.selectedVersion!.confirmed).toBe(true);

    const versionRef = financeAgreementsCollection().doc(agreementRef).collection("versions").doc("1");
    const before = await fingerprint(versionRef);
    const artifactRef = must(await upload(manager, partnerCp(partner), SAMPLE_PDF()), "upload").artifact.artifactRef;
    expect(failed(await extract(manager, agreementRef, artifactRef))).toMatchObject({ code: "conflict" });
    expect(await fingerprint(versionRef)).toEqual(before);
    expect((await financeAgreementsCollection().doc(agreementRef).collection("extractionRuns").get()).size).toBe(0);
    // nothing became operational
    expect(must(await getAgreementDetail(manager, agreementRef), "detail").head.activeVersion).toBeNull();
  });
});

// ======================================================================================================================
describe("getExtractionResult: visibility by sensitive category", () => {
  it("manager (manage_agreements only): ordinary proposals, NO restricted block, identity fields RESTRICTED without a value or a match result", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const { agreementRef, result } = await extractedSample(manager, partnerCp(partner));

    const read = must(await getExtractionResult(manager, { agreementRef }), "read");
    expect(read.run.runRef).toBe(result.run.runRef);
    expect(read.restricted).toBeNull();
    expect(read.contractDetailVisible).toBe(false);
    expect(field(read, "effectiveDate")).toMatchObject({ valueState: "VISIBLE", normalizedValue: "2025-04-01", page: 2 });
    expect(field(read, "panNumber")).toMatchObject({ valueState: "RESTRICTED", normalizedValue: null });
    expectNoIdentity(read, "manager read");
    expectNoSnippetText(read, "manager read");
    walk(read, (kind, text) => {
      if (kind === "key") expect(text).not.toMatch(/rawSnippet|rawValue|locator|bucket|path|signed|match|mismatch/i);
    });
  });

  it("finance_contracts WITHOUT the identity category: raw snippets are visible but every identity value is RESTRICTED and masked out of every snippet", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const { agreementRef } = await extractedSample(manager, partnerCp(partner));
    const head = await actor("partnership_head", { deny: ["payment_details", "vendor_payment_details"] });

    const read = must(await getExtractionResult(head, { agreementRef }), "read");
    expect(read.contractDetailVisible).toBe(true);
    expect(read.identityValuesVisible).toBe(false);
    expect(read.restricted!.snippets.length).toBe(read.fields.length);
    const effective = read.restricted!.snippets.find((s) => s.fieldKey === "effectiveDate")!;
    expect(effective).toMatchObject({ page: 2, locator: "page 2", snippetState: "VISIBLE" });
    expect(effective.rawSnippet).toContain("Effective Date");
    // the address snippet sits right next to the identity block: it must be masked, and say so
    const address = read.restricted!.snippets.find((s) => s.fieldKey === "address")!;
    expect(address.rawSnippet).toContain("[restricted]");
    // the identity fields' own snippets are withheld outright
    for (const key of ["panNumber", "gstin", "aadhaarNumber", "bankAccountNumber", "ifsc", "panHolderName"]) {
      expect(read.restricted!.snippets.find((s) => s.fieldKey === key)).toMatchObject({ rawSnippet: null, snippetState: "RESTRICTED" });
      expect(field(read, key)).toMatchObject({ valueState: "RESTRICTED", normalizedValue: null });
    }
    expectNoIdentity(read, "head without identity category");
  });

  it("the identity category WITHOUT finance_contracts shows nothing restricted at all (each gate is independent)", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const { agreementRef } = await extractedSample(manager, partnerCp(partner));
    const head = await actor("partnership_head", { deny: ["finance_contracts"] });

    const read = must(await getExtractionResult(head, { agreementRef }), "read");
    expect(read.restricted).toBeNull();
    expect(read.identityValuesVisible).toBe(false);
    expect(field(read, "panNumber")).toMatchObject({ valueState: "RESTRICTED", normalizedValue: null });
    expectNoIdentity(read, "head without finance_contracts");
    expectNoSnippetText(read, "head without finance_contracts");
  });

  it("Head and Super Admin (finance_contracts + payment_details) see the raw snippets and the identity values", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const { agreementRef } = await extractedSample(manager, partnerCp(partner));

    for (const role of ["partnership_head", "super_admin"] as const) {
      const read = must(await getExtractionResult(await actor(role), { agreementRef }), role);
      expect(read.contractDetailVisible).toBe(true);
      expect(read.identityValuesVisible).toBe(true);
      expect(field(read, "panNumber")).toMatchObject({ valueState: "VISIBLE", normalizedValue: "ABCPE1234F", page: 1 });
      expect(field(read, "gstin")).toMatchObject({ valueState: "VISIBLE", normalizedValue: "29ABCPE1234F1Z5" });
      expect(field(read, "bankAccountNumber")).toMatchObject({ valueState: "VISIBLE", normalizedValue: "123456789012" });
      expect(field(read, "ifsc")).toMatchObject({ valueState: "VISIBLE", normalizedValue: "HDFC0001234" });
      expect(field(read, "aadhaarNumber")).toMatchObject({ valueState: "VISIBLE", normalizedValue: SAMPLE_AADHAAR });
      expect(read.restricted!.snippets.find((s) => s.fieldKey === "panNumber")!.rawSnippet).toContain("ABCPE1234F");
    }
  });

  it("a Vendor agreement checks vendor_payment_details (not payment_details) for identity values", async () => {
    const manager = await actor("partnership_manager");
    const vendor = await seedVendor();
    const { agreementRef } = await extractedSample(manager, vendorCp(vendor));

    const withoutVendorCategory = await actor("partnership_head", { deny: ["vendor_payment_details"] });
    const denied = must(await getExtractionResult(withoutVendorCategory, { agreementRef }), "denied");
    expect(denied.contractDetailVisible).toBe(true);
    expect(denied.identityValuesVisible).toBe(false);
    expect(field(denied, "panNumber")).toMatchObject({ valueState: "RESTRICTED", normalizedValue: null });
    expectNoIdentity(denied, "vendor head without vendor_payment_details");

    // holding vendor_payment_details while lacking the PARTNER category is enough for a Vendor agreement
    const withVendorCategoryOnly = await actor("partnership_head", { deny: ["payment_details"] });
    const allowed = must(await getExtractionResult(withVendorCategoryOnly, { agreementRef }), "allowed");
    expect(allowed.identityValuesVisible).toBe(true);
    expect(field(allowed, "panNumber")).toMatchObject({ valueState: "VISIBLE", normalizedValue: "ABCPE1234F" });
  });
});

// ======================================================================================================================
describe("getExtractionResult: runs, scope and gates", () => {
  it("the latest run is the default; an explicit runRef selects an older one; a forged, foreign or absent run is the neutral not_found", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const cp = partnerCp(partner);
    const created = await newAgreement(manager, cp);
    const agreementRef = created.agreement.head.agreementRef;
    const other = await newAgreement(manager, cp);

    // no run yet
    expect(failed(await getExtractionResult(manager, { agreementRef }))).toEqual(NEUTRAL);

    const blank = must(await upload(manager, cp, makeBlankPdf(1)), "blank").artifact.artifactRef;
    const first = must(await extract(manager, agreementRef, blank), "first");
    await new Promise((resolve) => setTimeout(resolve, 15));
    const sample = must(await upload(manager, cp, SAMPLE_PDF()), "sample").artifact.artifactRef;
    const second = must(await extract(manager, agreementRef, sample), "second");
    expect(first.run.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(second.run.status).not.toBe("MANUAL_REVIEW_REQUIRED");

    expect(must(await getExtractionResult(manager, { agreementRef }), "latest").run.runRef).toBe(second.run.runRef);
    expect(must(await getExtractionResult(manager, { agreementRef, extractionRunRef: first.run.runRef }), "explicit").run.runRef).toBe(first.run.runRef);
    expect(failed(await getExtractionResult(manager, { agreementRef, extractionRunRef: `run_${"0".repeat(20)}` }))).toEqual(NEUTRAL);
    // a run of ANOTHER agreement is not reachable through this one, even for the same counterparty
    expect(failed(await getExtractionResult(manager, { agreementRef: other.agreement.head.agreementRef, extractionRunRef: first.run.runRef }))).toEqual(NEUTRAL);
    expect(failed(await getExtractionResult(manager, { agreementRef, extractionRunRef: "nope" }))).toMatchObject({ code: "invalid_input" });
  });

  it("read gate is finance + LIVE scope: unauthenticated / Viewer / Analyst unauthorized; out-of-scope and forged agreements neutral; scope is re-read live", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const { agreementRef } = await extractedSample(manager, partnerCp(partner));

    expect(failed(await getExtractionResult(null, { agreementRef }))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
    for (const role of ["viewer", "analyst"] as const) expect(failed(await getExtractionResult(await actor(role), { agreementRef }))).toMatchObject({ code: "unauthorized" });
    expect(failed(await getExtractionResult(await outOfScope("partnership_head"), { agreementRef }))).toEqual(NEUTRAL);
    expect(failed(await getExtractionResult(manager, { agreementRef: `agr_${"0".repeat(20)}` }))).toEqual(NEUTRAL);
    expect(failed(await getExtractionResult(manager, { agreementRef, forged: true }))).toMatchObject({ code: "invalid_input" });

    // move the Partner out of the manager's region: the very next read is neutral (the head's stored snapshot is never trusted)
    expect(must(await getExtractionResult(manager, { agreementRef }), "before").run.artifactRef).toMatch(/^ca_/);
    await partnersCollection().doc(partner.uid).update({ regionIds: [R_OUT] });
    expect(failed(await getExtractionResult(manager, { agreementRef }))).toEqual(NEUTRAL);
  });
});

// ======================================================================================================================
describe("getContractArtifactSummary", () => {
  it("returns the safe DTO to an in-scope reader and re-verifies LIVE scope; forged / malformed / out-of-scope refs are neutral", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const artifact = must(await upload(manager, partnerCp(partner), SAMPLE_PDF(), "Contract.pdf"), "upload").artifact;

    const viewerLikeReader = await actor("partnership_head");
    const read = must(await getContractArtifactSummary(viewerLikeReader, artifact.artifactRef), "read");
    expect(read).toEqual(artifact);
    walk(read, (kind, text) => {
      if (kind === "key") expect(text).not.toMatch(/locator|bucket|path|url|signed|storage/i);
    });

    expect(failed(await getContractArtifactSummary(null, artifact.artifactRef))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
    expect(failed(await getContractArtifactSummary(await actor("viewer"), artifact.artifactRef))).toMatchObject({ code: "unauthorized" });
    expect(failed(await getContractArtifactSummary(await outOfScope("partnership_manager"), artifact.artifactRef))).toEqual(NEUTRAL);
    expect(failed(await getContractArtifactSummary(manager, `ca_${"0".repeat(20)}`))).toEqual(NEUTRAL);
    expect(failed(await getContractArtifactSummary(manager, "not-a-ref"))).toEqual(NEUTRAL);
    expect(failed(await getContractArtifactSummary(manager, { artifactRef: artifact.artifactRef }))).toEqual(NEUTRAL);

    await partnersCollection().doc(partner.uid).update({ regionIds: [R_OUT] });
    expect(failed(await getContractArtifactSummary(manager, artifact.artifactRef))).toEqual(NEUTRAL);
  });
});

// ======================================================================================================================
describe("extract -> attach: the explicit, separate hand-off", () => {
  it("attachExtractionProposals puts the proposals in the draft as PENDING (never accepted, no identity value) and nothing becomes operational; Partner / Account / platform context untouched", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const account = await seedAccount(partner, "instagram");
    const identityRef = await seedRestrictedIdentity({ type: "PARTNER", uid: partner.uid, ref: partner.partnerRef });
    const { agreementRef, result, created } = await extractedSample(manager, partnerCp(partner, [account.partnerAccountRef]));
    expect(created.agreement.head.counterparty.platformScope).toEqual(["instagram"]);

    const watched = [partnersCollection().doc(partner.uid), partnerAccountsCollection().doc(account.uid), identityRef];
    const before = await Promise.all(watched.map(fingerprint));
    const versionRef = financeAgreementsCollection().doc(agreementRef).collection("versions").doc("1");
    const versionBefore = await fingerprint(versionRef);

    const detailBefore = must(await getAgreementDetail(manager, agreementRef), "detail");
    const attached = must(await attachExtractionProposals(manager, { agreementRef, version: 1, expectedDocVersion: detailBefore.selectedVersion!.docVersion, extractionRunRef: result.run.runRef }, requestId()), "attach");
    expect(attached.attachedCount).toBeGreaterThan(10);

    const detail = attached.agreement;
    expect(await fingerprint(versionRef)).not.toEqual(versionBefore);
    const draft = detail.selectedVersion!.draft;
    expect(draft.effectiveDate).toMatchObject({ value: "2025-04-01", origin: "EXTRACTED", decision: "PENDING", provenance: { extractionRunRef: result.run.runRef, page: 2 } });
    expect(draft.panNumber).toMatchObject({ value: null, origin: "EXTRACTED", decision: "PENDING" });
    for (const entry of Object.values(draft)) if (entry?.origin === "EXTRACTED") expect(entry.decision).toBe("PENDING");
    expect(detail.selectedVersion).toMatchObject({ confirmed: false, status: "DRAFT", terms: null, source: { contractArtifactRef: expect.stringMatching(/^ca_/), extractionRunRef: result.run.runRef } });
    expect(detail.head).toMatchObject({ status: "DRAFT", activeVersion: null, openVersion: 1 });

    for (const json of await agreementDocsJson(agreementRef)) for (const secret of IDENTITY_STRINGS) expect(json, secret).not.toContain(secret);
    const events = await financeAgreementsCollection().doc(agreementRef).collection("events").where("kind", "==", "extraction_attached").get();
    expect(events.size).toBe(1);
    expect(events.docs[0]!.data().metadata).toMatchObject({ runRef: result.run.runRef, artifactRef: expect.stringMatching(/^ca_/) });
    expectNoIdentity(events.docs[0]!.data(), "attach event");

    expect(await Promise.all(watched.map(fingerprint))).toEqual(before);
  });
});

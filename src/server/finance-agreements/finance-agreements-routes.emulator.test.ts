// Step 14A - the thin Finance Agreements API routes (src/app/api/finance/**) against the running
// Firestore/Auth emulator. The routes are called as real handlers (Request in, Response out); ONLY the
// session lookup (`resolveRequestActor`) is replaced, exactly as the Partner Reviews route tests do -
// every service, gate, grant and Firestore transaction underneath is real.
//
// Proves: 401 unauthenticated / 403 denial (never says which layer) / neutral 404 for forged and
// out-of-scope refs / 400 bad input / 409 not_ready with blockers / 201 vs 200 create idempotency, the
// Manager (prepares) vs Head (activates) split on the lifecycle routes, the multipart upload (10 MB
// boundary, non-PDF, non-multipart, oversized Content-Length refused before the body is read, and no
// storage locator / bucket / path / URL in any response), and the whole
// create -> upload -> extract -> attach -> reconcile -> decide -> confirm -> activate journey through routes,
// which never writes a Partner, Vendor or KYC record.
//
// Hermetic: every actor's ONLY scope is a per-run private REGION; fixtures are private-region
// Partners/Vendors with unique ids; the artifact bytes live in the in-memory store; everything created is removed.
import { randomUUID } from "node:crypto";

import { DocumentReference, Transaction, WriteBatch } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { COLLECTIONS } from "@/server/authz/firestore";
import { scopeGrantDocId } from "@/server/authz/scope";
import { seedAccessControlData } from "@/server/authz/seed-access-data";
import type { ActorContext, ScopeGrant, ScopeGrantInput } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { partnersCollection } from "@/server/partners/firestore";
import { partnerDocSchema, type PartnerDoc } from "@/server/partners/types";
import { restrictedFinancialIdentitiesCollection, restrictedFinancialIdentityDocSchema, restrictedIdentityDocId } from "@/server/shared/restricted-financial-identity";
import { vendorsCollection } from "@/server/vendors/firestore";
import { vendorDocSchema, type VendorDoc } from "@/server/vendors/types";

// Only the session lookup is replaced (the finance http.ts re-exports it from the administration module).
let httpActor: ActorContext | null = null;
vi.mock("@/server/administration/http", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/administration/http")>();
  return { ...original, resolveRequestActor: async () => httpActor };
});

import * as agreementsRoute from "@/app/api/finance/agreements/route";
import * as detailRoute from "@/app/api/finance/agreements/[agreementRef]/route";
import * as versionsRoute from "@/app/api/finance/agreements/[agreementRef]/versions/route";
import * as eventsRoute from "@/app/api/finance/agreements/[agreementRef]/events/route";
import * as extractionRoute from "@/app/api/finance/agreements/[agreementRef]/extraction/route";
import * as attachRoute from "@/app/api/finance/agreements/[agreementRef]/extraction/attach/route";
import * as reconciliationRoute from "@/app/api/finance/agreements/[agreementRef]/reconciliation/route";
import * as fieldsRoute from "@/app/api/finance/agreements/[agreementRef]/fields/route";
import * as masterDataRoute from "@/app/api/finance/agreements/[agreementRef]/master-data/route";
import * as kycRoute from "@/app/api/finance/agreements/[agreementRef]/kyc/route";
import * as kycStatusRoute from "@/app/api/finance/agreements/[agreementRef]/kyc-status/route";
import * as confirmRoute from "@/app/api/finance/agreements/[agreementRef]/confirm/route";
import * as activateRoute from "@/app/api/finance/agreements/[agreementRef]/activate/route";
import * as reviseRoute from "@/app/api/finance/agreements/[agreementRef]/revise/route";
import * as suspendRoute from "@/app/api/finance/agreements/[agreementRef]/suspend/route";
import * as resumeRoute from "@/app/api/finance/agreements/[agreementRef]/resume/route";
import * as endRoute from "@/app/api/finance/agreements/[agreementRef]/end/route";
import * as documentRoute from "@/app/api/finance/agreements/[agreementRef]/document/route";
import * as counterpartyDocumentsRoute from "@/app/api/finance/counterparties/documents/route";
import * as uploadRoute from "@/app/api/finance/contracts/upload/route";
import * as extractRoute from "@/app/api/finance/contracts/extract/route";

import { createInMemoryArtifactStore, setContractArtifactStoreForTests } from "./contract-artifacts/store";
import { contractArtifactClaimId } from "./contract-service";
import { installFakeAgreementDocumentStorage } from "./testing/agreement-document-fixtures";
import { MAX_CONTRACT_PDF_BYTES, sha256Hex } from "./contract-artifacts/validation";
import { FINANCE_AGREEMENT_COLLECTIONS, agreementClaimId, financeAgreementClaimsCollection, financeAgreementRestrictedExtractionsCollection, financeAgreementsCollection, financeContractArtifactsCollection } from "./firestore";
import { READY_DECISIONS } from "./testing/agreement-service-fixtures";
import { makeTextPdf } from "./testing/pdf-fixtures";
import { SAMPLE_CONTRACT_PAGES } from "./testing/sample-contract";
import { CONTRACT_UPLOAD_MAX_REQUEST_BYTES } from "./upload-request";

vi.setConfig({ testTimeout: 90_000 });

const runId = Date.now();
const R_IN = `far-in-${runId}`;
const R_OUT = `far-out-${runId}`;
const FORBIDDEN = { error: "Forbidden." };
const NOT_FOUND = { error: "Not found." };
const FORGED_REF = `agr_${"0".repeat(20)}`;
const BASE = "http://localhost:3000/api/finance";

const cleanup: FirebaseFirestore.DocumentReference[] = [];
const agreementRefs: string[] = [];
const claimIds: string[] = [];
const artifactRefs: string[] = [];
const restrictedRunRefs: string[] = [];
const grantDocIds: string[] = [];
let counter = 0;
let store = createInMemoryArtifactStore();
// Step 14B.1: the original signed document goes to the FAKE Drive adapter (no Google call); real bytes are in the in-memory artifact store.
let drive = installFakeAgreementDocumentStorage();

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
}, 60_000);

beforeEach(() => {
  store = createInMemoryArtifactStore();
  setContractArtifactStoreForTests(store);
  drive = installFakeAgreementDocumentStorage();
  httpActor = null;
});

afterEach(() => {
  setContractArtifactStoreForTests(null);
  drive.restore();
  httpActor = null;
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

// ---- Actors -----------------------------------------------------------------------------------------------------------
type Role = ActorContext["role"];

// The given ROLE's explicit feature/action/sensitive grants + a scope made of exactly the region grants named here.
async function actor(role: Role, region: string | null = R_IN): Promise<ActorContext> {
  const uid = `far-${role}-${runId}-${randomUUID().slice(0, 6)}`;
  if (region) {
    const input: ScopeGrantInput = { type: "REGION", region };
    const id = scopeGrantDocId(uid, input);
    await getAdminFirestore()
      .collection(COLLECTIONS.scopeAssignments)
      .doc(id)
      .set({ ...input, uid, grantedAt: new Date().toISOString(), grantedBy: "far-test" } as ScopeGrant);
    grantDocIds.push(id);
  }
  return { uid, email: `${uid}@example.test`, role, displayName: `FAR ${role}`, userRef: `far-ref-${uid}` };
}

// ---- Fixtures ---------------------------------------------------------------------------------------------------------
async function seedPartner(over: { email?: string | null; phone?: string | null } = {}): Promise<PartnerDoc> {
  counter += 1;
  const uid = `far-partner-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = `FAR Partner ${counter} ${runId}`;
  const partner = partnerDocSchema.parse({
    uid,
    partnerRef: `ref-${uid}`,
    version: 1,
    displayName,
    displayNameLower: displayName.toLowerCase(),
    legalName: null,
    email: over.email === undefined ? `partner-${counter}@example.test` : over.email,
    phone: over.phone === undefined ? "+91 90000 00000" : over.phone,
    status: "ACTIVE",
    regionIds: [R_IN],
    createdAt: now,
    createdByUserRef: "far-test",
    updatedAt: now,
    updatedByUserRef: "far-test",
  });
  const ref = partnersCollection().doc(uid);
  await ref.set(partner);
  cleanup.push(ref);
  return partner;
}

async function seedVendor(): Promise<VendorDoc> {
  counter += 1;
  const uid = `far-vendor-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = `FAR Vendor ${counter} ${runId}`;
  const vendor = vendorDocSchema.parse({
    uid,
    vendorRef: `ref-${uid}`,
    version: 1,
    displayName,
    displayNameLower: displayName.toLowerCase(),
    vendorType: "AGENCY",
    email: `vendor-${counter}@example.test`,
    status: "ACTIVE",
    regionIds: [R_IN],
    createdAt: now,
    createdByUserRef: "far-test",
    updatedAt: now,
    updatedByUserRef: "far-test",
  });
  const ref = vendorsCollection().doc(uid);
  await ref.set(vendor);
  cleanup.push(ref);
  return vendor;
}

// Synthetic identity values (invented): none may ever appear in a route response for an actor without the categories.
const SECRETS = { pan: "QWERT4321Z", account: "998877665544", ifsc: "TEST0009876", holder: "Zed Holder Name" };

async function seedRestrictedIdentity(partner: PartnerDoc) {
  const doc = restrictedFinancialIdentityDocSchema.parse({
    uid: restrictedIdentityDocId("PARTNER", partner.uid),
    subjectType: "PARTNER",
    subjectRef: partner.partnerRef,
    version: 1,
    pan: { number: SECRETS.pan },
    aadhaar: null,
    gst: { applicable: false },
    bank: { accountHolderName: SECRETS.holder, accountNumber: SECRETS.account, ifsc: SECRETS.ifsc, bankName: "Test Bank", branchName: "Test Branch" },
    updatedAt: new Date().toISOString(),
    updatedByUserRef: "far-test",
  });
  const ref = restrictedFinancialIdentitiesCollection().doc(doc.uid);
  await ref.set(doc);
  cleanup.push(ref);
}

// Every response body of the current test, as text (reset by the journey test that inspects it).
let transcript: string[] = [];

// ---- HTTP helpers -----------------------------------------------------------------------------------------------------
type RouteResult = { status: number; body: any; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (request: Request, context: { params: Promise<{ agreementRef: string }> }) => Promise<Response>;

async function send(handler: Handler, as: ActorContext | null, init: { method: "GET" | "POST"; path: string; agreementRef?: string; json?: unknown; rawBody?: string; form?: FormData; headers?: Record<string, string> }): Promise<RouteResult> {
  httpActor = as;
  const headers = new Headers(init.headers);
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.rawBody !== undefined) {
    body = init.rawBody;
    headers.set("content-type", "application/json");
  } else if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers.set("content-type", "application/json");
  }
  const response = await handler(new Request(`${BASE}${init.path}`, { method: init.method, headers, body }), { params: Promise.resolve({ agreementRef: init.agreementRef ?? "" }) });
  let parsed: unknown = null;
  const text = await response.text();
  transcript.push(text);
  if (text) parsed = JSON.parse(text);
  return { status: response.status, body: parsed, headers: response.headers };
}

const get = (handler: Handler, as: ActorContext | null, path: string, agreementRef?: string) => send(handler, as, { method: "GET", path, agreementRef });
const post = (handler: Handler, as: ActorContext | null, path: string, json: unknown, agreementRef?: string) => send(handler, as, { method: "POST", path, json, agreementRef });

function ok(result: RouteResult, label: string, status = 200): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (result.status !== status) throw new Error(`${label}: expected ${status}, got ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

// ---- Journey helpers (all through routes) ---------------------------------------------------------------------------
const partnerCp = (partner: PartnerDoc) => ({ type: "PARTNER", partnerRef: partner.partnerRef });
const vendorCp = (vendor: VendorDoc) => ({ type: "VENDOR", vendorRef: vendor.vendorRef });

async function createAgreement(as: ActorContext, counterparty: object): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const clientRequestId = `crid-${runId}-${(counter += 1)}-${randomUUID().slice(0, 6)}`;
  const detail = ok(await post(agreementsRoute.POST, as, "/agreements", { clientRequestId, counterparty }), "create", 201);
  agreementRefs.push(detail.head.agreementRef);
  claimIds.push(agreementClaimId(as.uid, clientRequestId));
  return detail;
}

// Decides each seed in order through the fields route, threading the version doc's docVersion.
async function decide(as: ActorContext, detail: any, seeds: Array<{ fieldKey: string; decision: string; value?: unknown }>): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  let current = detail;
  for (const seed of seeds) {
    current = ok(
      await post(fieldsRoute.POST, as, `/agreements/${current.head.agreementRef}/fields`, {
        version: current.selectedVersion.version,
        expectedDocVersion: current.selectedVersion.docVersion,
        fieldKey: seed.fieldKey,
        decision: seed.decision,
        ...(seed.value !== undefined ? { value: seed.value } : {}),
      }, current.head.agreementRef),
      `decide ${seed.fieldKey}`,
    );
  }
  return current;
}

async function acceptPending(as: ActorContext, detail: any): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const pending = Object.entries(detail.selectedVersion.draft as Record<string, { decision: string }>)
    .filter(([, entry]) => entry.decision === "PENDING")
    .map(([fieldKey]) => ({ fieldKey, decision: "ACCEPTED" }));
  return decide(as, detail, pending);
}

async function confirm(as: ActorContext, detail: any): Promise<RouteResult> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return post(confirmRoute.POST, as, `/agreements/${detail.head.agreementRef}/confirm`, { version: detail.selectedVersion.version, expectedDocVersion: detail.selectedVersion.docVersion }, detail.head.agreementRef);
}

// create -> decide READY -> accept pending -> confirm. Returns the confirmed detail.
async function confirmedAgreement(manager: ActorContext, counterparty: object): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const created = await createAgreement(manager, counterparty);
  const decided = await acceptPending(manager, await decide(manager, created, READY_DECISIONS));
  return ok(await confirm(manager, decided), "confirm");
}

async function activate(as: ActorContext, detail: any): Promise<RouteResult> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return post(activateRoute.POST, as, `/agreements/${detail.head.agreementRef}/activate`, { version: detail.selectedVersion.version, expectedDocVersion: detail.head.docVersion }, detail.head.agreementRef);
}

async function fresh(as: ActorContext, agreementRef: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return ok(await get(detailRoute.GET, as, `/agreements/${agreementRef}`, agreementRef), "detail");
}

function multipart(fields: { file?: { bytes: Uint8Array; name: string; type?: string }; counterpartyType?: string; counterpartyRef?: string }): FormData {
  const form = new FormData();
  if (fields.file) form.set("file", new File([fields.file.bytes as BlobPart], fields.file.name, { type: fields.file.type ?? "application/pdf" }));
  if (fields.counterpartyType !== undefined) form.set("counterpartyType", fields.counterpartyType);
  if (fields.counterpartyRef !== undefined) form.set("counterpartyRef", fields.counterpartyRef);
  return form;
}

const upload = (as: ActorContext | null, form: FormData, headers?: Record<string, string>) => send(uploadRoute.POST, as, { method: "POST", path: "/contracts/upload", form, headers });

// A syntactically valid PDF header padded to an exact size (upload stores and hashes; it does not parse).
function paddedPdf(sizeBytes: number): Uint8Array {
  const bytes = new Uint8Array(sizeBytes);
  bytes.set(Buffer.from("%PDF-1.4\n"));
  return bytes;
}

const SAMPLE_PDF = () => makeTextPdf(SAMPLE_CONTRACT_PAGES);

// A JSON walk: no storage locator / bucket / path / URL key or value anywhere in a response.
function expectNoStorageExposure(value: unknown, label: string): void {
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) node.forEach((child, index) => walk(child, `${path}[${index}]`));
    else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        expect(key, `${label}: key ${path}.${key}`).not.toMatch(/locator|bucket|storagePath|objectPath|signedUrl|downloadUrl|gcs|\burl\b|uri$/i);
        walk(child, `${path}.${key}`);
      }
    } else if (typeof node === "string" && !path.endsWith(".fileName")) {
      expect(node, `${label}: value at ${path}`).not.toMatch(/finance-contracts|gs:\/\/|storage\.googleapis|X-Goog|firebasestorage|\.appspot\.com/i);
      // An extracted CONTENT value may legitimately be a link (a collaborator page URL); no other string may be a URL.
      if (!/(normalizedValue|extractedValue|\.value)(\.|\[|$)/.test(path)) expect(node, `${label}: URL at ${path}`).not.toMatch(/https?:\/\//i);
    }
  };
  walk(value, "$");
}

// ---- Firestore write instrumentation -----------------------------------------------------------------------------------
function instrumentWrites() {
  const paths: string[] = [];
  type AnyFn = (...args: unknown[]) => unknown;
  const spies: Array<{ mockRestore: () => void }> = [];
  const wrap = (proto: object, name: string, pathOf: (self: unknown, args: unknown[]) => string) => {
    const original = (proto as unknown as Record<string, AnyFn>)[name]!;
    spies.push(
      vi.spyOn(proto as unknown as Record<string, AnyFn>, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
        paths.push(pathOf(this, args));
        return original.apply(this, args);
      }),
    );
  };
  for (const op of ["set", "create", "update", "delete"]) {
    wrap(Transaction.prototype, op, (_self, args) => (args[0] as { path: string }).path);
    wrap(WriteBatch.prototype, op, (_self, args) => (args[0] as { path: string }).path);
    wrap(DocumentReference.prototype, op, (self) => (self as { path: string }).path);
  }
  return { paths, stop: () => spies.splice(0).forEach((spy) => spy.mockRestore()) };
}

// ---- Endpoint table (every route) ----------------------------------------------------------------------------------------
type Endpoint = { name: string; handler: Handler; method: "GET" | "POST"; path: (ref: string) => string; body?: (ref: string) => object; needsRef: boolean };

// Bodies are VALID-shaped so a forged ref is judged by the ref alone (input shape is checked before scope).
const ENDPOINTS: Endpoint[] = [
  { name: "GET agreements", handler: agreementsRoute.GET, method: "GET", path: () => "/agreements?counterpartyType=PARTNER&ref=ref-x", needsRef: false },
  { name: "GET agreement", handler: detailRoute.GET, method: "GET", path: (ref) => `/agreements/${ref}`, needsRef: true },
  { name: "GET versions", handler: versionsRoute.GET, method: "GET", path: (ref) => `/agreements/${ref}/versions`, needsRef: true },
  { name: "GET events", handler: eventsRoute.GET, method: "GET", path: (ref) => `/agreements/${ref}/events`, needsRef: true },
  { name: "GET extraction", handler: extractionRoute.GET, method: "GET", path: (ref) => `/agreements/${ref}/extraction`, needsRef: true },
  { name: "GET reconciliation", handler: reconciliationRoute.GET, method: "GET", path: (ref) => `/agreements/${ref}/reconciliation`, needsRef: true },
  { name: "GET kyc-status", handler: kycStatusRoute.GET, method: "GET", path: (ref) => `/agreements/${ref}/kyc-status`, needsRef: true },
  { name: "POST extraction/attach", handler: attachRoute.POST, method: "POST", path: (ref) => `/agreements/${ref}/extraction/attach`, body: () => ({ version: 1, expectedDocVersion: 1, extractionRunRef: `run_${"0".repeat(20)}` }), needsRef: true },
  { name: "POST fields", handler: fieldsRoute.POST, method: "POST", path: (ref) => `/agreements/${ref}/fields`, body: () => ({ version: 1, expectedDocVersion: 1, fieldKey: "counterpartyName", decision: "ACCEPTED" }), needsRef: true },
  { name: "POST master-data", handler: masterDataRoute.POST, method: "POST", path: (ref) => `/agreements/${ref}/master-data`, body: () => ({ version: 1, fieldKey: "emailAddress", mode: "FILL_MISSING", expectedCounterpartyVersion: 1 }), needsRef: true },
  { name: "POST kyc", handler: kycRoute.POST, method: "POST", path: (ref) => `/agreements/${ref}/kyc`, body: () => ({ version: 1, components: ["pan"], mode: "FILL_MISSING" }), needsRef: true },
  { name: "POST confirm", handler: confirmRoute.POST, method: "POST", path: (ref) => `/agreements/${ref}/confirm`, body: () => ({ version: 1, expectedDocVersion: 1 }), needsRef: true },
  { name: "POST activate", handler: activateRoute.POST, method: "POST", path: (ref) => `/agreements/${ref}/activate`, body: () => ({ version: 1, expectedDocVersion: 1 }), needsRef: true },
  { name: "POST revise", handler: reviseRoute.POST, method: "POST", path: (ref) => `/agreements/${ref}/revise`, body: () => ({ expectedDocVersion: 1 }), needsRef: true },
  { name: "POST suspend", handler: suspendRoute.POST, method: "POST", path: (ref) => `/agreements/${ref}/suspend`, body: () => ({ expectedDocVersion: 1, reason: "test reason" }), needsRef: true },
  { name: "POST resume", handler: resumeRoute.POST, method: "POST", path: (ref) => `/agreements/${ref}/resume`, body: () => ({ expectedDocVersion: 1 }), needsRef: true },
  { name: "POST end", handler: endRoute.POST, method: "POST", path: (ref) => `/agreements/${ref}/end`, body: () => ({ expectedDocVersion: 1, reason: "test reason" }), needsRef: true },
];

const callEndpoint = (endpoint: Endpoint, as: ActorContext | null, ref: string) =>
  send(endpoint.handler, as, { method: endpoint.method, path: endpoint.path(ref), agreementRef: ref, ...(endpoint.body ? { json: endpoint.body(ref) } : {}) });

// The two routes with a bespoke request shape (create needs a counterparty, upload is multipart, extract names an artifact).
const createAttempt = (as: ActorContext | null, partner: PartnerDoc) => post(agreementsRoute.POST, as, "/agreements", { clientRequestId: `crid-${runId}-attempt-${(counter += 1)}`, counterparty: partnerCp(partner) });
const extractAttempt = (as: ActorContext | null, agreementRef: string) => post(extractRoute.POST, as, "/contracts/extract", { agreementRef, version: 1, artifactRef: `ca_${"0".repeat(20)}` });
const uploadAttempt = (as: ActorContext | null, partner: PartnerDoc) => upload(as, multipart({ file: { bytes: paddedPdf(2048), name: "c.pdf" }, counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef }));

// =====================================================================================================================
describe("authentication and denial", () => {
  it("every route answers 401 {error: Forbidden.} without a session", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const created = await createAgreement(manager, partnerCp(partner));
    const ref = created.head.agreementRef;

    for (const endpoint of ENDPOINTS) {
      const result = await callEndpoint(endpoint, null, ref);
      expect({ name: endpoint.name, status: result.status, body: result.body }).toEqual({ name: endpoint.name, status: 401, body: FORBIDDEN });
    }
    for (const [name, result] of [
      ["POST agreements", await createAttempt(null, partner)],
      ["POST contracts/extract", await extractAttempt(null, ref)],
      ["POST contracts/upload", await uploadAttempt(null, partner)],
    ] as const) {
      expect({ name, status: result.status, body: result.body }).toEqual({ name, status: 401, body: FORBIDDEN });
    }
  });

  it.each(["viewer", "analyst"] as const)("every route answers 403 {error: Forbidden.} for a %s (no finance grant), even for a real in-scope Agreement", async (role) => {
    const manager = await actor("partnership_manager");
    const denied = await actor(role);
    const partner = await seedPartner();
    const created = await createAgreement(manager, partnerCp(partner));
    const ref = created.head.agreementRef;

    for (const endpoint of ENDPOINTS) {
      const result = await callEndpoint(endpoint, denied, ref);
      expect({ name: endpoint.name, status: result.status, body: result.body }).toEqual({ name: endpoint.name, status: 403, body: FORBIDDEN });
    }
    for (const [name, result] of [
      ["POST agreements", await createAttempt(denied, partner)],
      ["POST contracts/extract", await extractAttempt(denied, ref)],
      ["POST contracts/upload", await uploadAttempt(denied, partner)],
    ] as const) {
      expect({ name, status: result.status, body: result.body }).toEqual({ name, status: 403, body: FORBIDDEN });
    }
    expect(store.size).toBe(0);
  });

  it("a Manager prepares (create, decide, confirm) but every lifecycle route is Head-only: 403 for the Manager, 200 for the Head", async () => {
    const manager = await actor("partnership_manager");
    const head = await actor("partnership_head");
    const partner = await seedPartner();
    const confirmed = await confirmedAgreement(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;

    // activate
    expect((await activate(manager, confirmed)).status).toBe(403);
    expect((await activate(manager, confirmed)).body).toEqual(FORBIDDEN);
    const activated = ok(await activate(head, confirmed), "head activate");
    expect(activated.head).toMatchObject({ status: "ACTIVE", activeVersion: 1, openVersion: null });
    expect(activated.selectedVersion).toMatchObject({ status: "ACTIVE" });

    // suspend / resume
    const suspendBody = (detail: any) => ({ expectedDocVersion: detail.head.docVersion, reason: "Audit hold" }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(await post(suspendRoute.POST, manager, `/agreements/${ref}/suspend`, suspendBody(activated), ref)).toMatchObject({ status: 403, body: FORBIDDEN });
    const suspended = ok(await post(suspendRoute.POST, head, `/agreements/${ref}/suspend`, suspendBody(activated), ref), "head suspend");
    expect(suspended.head.status).toBe("SUSPENDED");

    const resumeBody = (detail: any) => ({ expectedDocVersion: detail.head.docVersion }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(await post(resumeRoute.POST, manager, `/agreements/${ref}/resume`, resumeBody(suspended), ref)).toMatchObject({ status: 403, body: FORBIDDEN });
    const resumed = ok(await post(resumeRoute.POST, head, `/agreements/${ref}/resume`, resumeBody(suspended), ref), "head resume");
    expect(resumed.head.status).toBe("ACTIVE");

    // revise
    expect(await post(reviseRoute.POST, manager, `/agreements/${ref}/revise`, resumeBody(resumed), ref)).toMatchObject({ status: 403, body: FORBIDDEN });
    const revised = ok(await post(reviseRoute.POST, head, `/agreements/${ref}/revise`, resumeBody(resumed), ref), "head revise");
    expect(revised.head).toMatchObject({ latestVersion: 2, openVersion: 2, activeVersion: 1 });
    expect(revised.selectedVersion).toMatchObject({ version: 2, status: "DRAFT", confirmed: false });

    // end
    const endBody = (detail: any) => ({ expectedDocVersion: detail.head.docVersion, reason: "Contract terminated" }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(await post(endRoute.POST, manager, `/agreements/${ref}/end`, endBody(revised), ref)).toMatchObject({ status: 403, body: FORBIDDEN });
    const ended = ok(await post(endRoute.POST, head, `/agreements/${ref}/end`, endBody(revised), ref), "head end");
    expect(ended.head.status).toBe("ENDED");

    // history is preserved and readable by both
    const versions = ok(await get(versionsRoute.GET, manager, `/agreements/${ref}/versions`, ref), "versions");
    expect(versions.versions.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([[2, "DRAFT"], [1, "ENDED"]]); // newest first
    const events = ok(await get(eventsRoute.GET, manager, `/agreements/${ref}/events`, ref), "events");
    expect(events.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(["created", "confirmed", "activated", "suspended", "resumed", "revision_created", "ended"]));
  });
});

// =====================================================================================================================
describe("neutral 404 and input validation", () => {
  it("a forged ref and an out-of-scope Agreement are the SAME neutral 404 on every ref route (no existence oracle)", async () => {
    const head = await actor("partnership_head");
    const outsider = await actor("partnership_head", R_OUT);
    const partner = await seedPartner();
    const created = await createAgreement(head, partnerCp(partner));
    const ref = created.head.agreementRef;

    for (const endpoint of ENDPOINTS.filter((e) => e.needsRef)) {
      const forged = await callEndpoint(endpoint, head, FORGED_REF);
      const outOfScope = await callEndpoint(endpoint, outsider, ref);
      const malformed = await callEndpoint(endpoint, head, "not-an-agreement-ref");
      expect({ name: endpoint.name, forged: [forged.status, forged.body] }, endpoint.name).toEqual({ name: endpoint.name, forged: [404, NOT_FOUND] });
      expect({ name: endpoint.name, outOfScope: [outOfScope.status, outOfScope.body] }, endpoint.name).toEqual({ name: endpoint.name, outOfScope: [404, NOT_FOUND] });
      // A MALFORMED ref (wrong shape, not a forged well-formed one) is refused by shape - 404 on the read routes,
      // 400 where the command's own input schema rejects it first; never a 200, never a 500, never anything about a record.
      expect([400, 404], `${endpoint.name} malformed`).toContain(malformed.status);
      expect(malformed.body).toEqual({ error: expect.any(String) });
    }

    // creating for, listing, uploading for and extracting against an out-of-scope Partner / Agreement: the same neutral answer
    expect(await createAttempt(outsider, partner)).toMatchObject({ status: 404, body: NOT_FOUND });
    expect(await get(agreementsRoute.GET, outsider, `/agreements?counterpartyType=PARTNER&ref=${partner.partnerRef}`)).toMatchObject({ status: 404, body: NOT_FOUND });
    expect(await get(agreementsRoute.GET, head, `/agreements?counterpartyType=PARTNER&ref=ref-does-not-exist`)).toMatchObject({ status: 404, body: NOT_FOUND });
    expect(await uploadAttempt(outsider, partner)).toMatchObject({ status: 404, body: NOT_FOUND });
    expect(await extractAttempt(outsider, ref)).toMatchObject({ status: 404, body: NOT_FOUND });
    expect(store.size).toBe(0);
  });

  it("400 for malformed JSON, unknown keys, a client-forged scope, a bad ?version / ?limit and a missing counterparty; the URL ref wins over a body ref", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const created = await createAgreement(manager, partnerCp(partner));
    const ref = created.head.agreementRef;
    const other = await createAgreement(manager, partnerCp(partner));

    expect(await send(fieldsRoute.POST, manager, { method: "POST", path: `/agreements/${ref}/fields`, rawBody: "{not json", agreementRef: ref })).toMatchObject({ status: 400, body: { error: "Invalid JSON body." } });
    expect(await send(agreementsRoute.POST, manager, { method: "POST", path: "/agreements", rawBody: "nope" })).toMatchObject({ status: 400 });
    expect((await post(fieldsRoute.POST, manager, `/agreements/${ref}/fields`, { version: 1, expectedDocVersion: 1, fieldKey: "counterpartyName", decision: "ACCEPTED", status: "ACTIVE" }, ref)).status).toBe(400);
    expect((await post(fieldsRoute.POST, manager, `/agreements/${ref}/fields`, { version: 1, expectedDocVersion: 1, fieldKey: "notAField", decision: "ACCEPTED" }, ref)).status).toBe(400);
    expect((await post(confirmRoute.POST, manager, `/agreements/${ref}/confirm`, [1, 2], ref)).status).toBe(400);
    expect((await post(agreementsRoute.POST, manager, "/agreements", { clientRequestId: "short", counterparty: partnerCp(partner) })).status).toBe(400);
    expect((await post(agreementsRoute.POST, manager, "/agreements", { clientRequestId: `crid-${runId}-forged-scope`, counterparty: { ...partnerCp(partner), regionIds: [R_OUT] } })).status).toBe(400);
    expect((await post(agreementsRoute.POST, manager, "/agreements", { clientRequestId: `crid-${runId}-nocp` })).status).toBe(400);
    expect((await get(agreementsRoute.GET, manager, "/agreements")).status).toBe(400);
    expect((await get(agreementsRoute.GET, manager, `/agreements?counterpartyType=NOPE&ref=${partner.partnerRef}`)).status).toBe(400);
    for (const bad of ["abc", "-1", "1.5", "", "0", "99999999999"]) {
      expect((await get(detailRoute.GET, manager, `/agreements/${ref}?version=${bad}`, ref)).status, `version=${bad}`).toBe(400);
      expect((await get(reconciliationRoute.GET, manager, `/agreements/${ref}/reconciliation?version=${bad}`, ref)).status, `reconciliation version=${bad}`).toBe(400);
    }
    for (const bad of ["abc", "0", "1000000"]) expect((await get(eventsRoute.GET, manager, `/agreements/${ref}/events?limit=${bad}`, ref)).status, `limit=${bad}`).toBe(400);
    // a valid-shaped version that does not exist is the neutral 404
    expect(await get(detailRoute.GET, manager, `/agreements/${ref}?version=9`, ref)).toMatchObject({ status: 404, body: NOT_FOUND });
    expect(ok(await get(detailRoute.GET, manager, `/agreements/${ref}?version=1`, ref), "version 1").selectedVersion.version).toBe(1);

    // the URL ref wins: a body naming ANOTHER agreement still acts on the URL's one
    const decided = ok(
      await post(fieldsRoute.POST, manager, `/agreements/${ref}/fields`, { agreementRef: other.head.agreementRef, version: 1, expectedDocVersion: 1, fieldKey: "counterpartyName", decision: "CORRECTED", value: "URL Wins Pvt Ltd" }, ref),
      "url wins",
    );
    expect(decided.head.agreementRef).toBe(ref);
    expect(decided.selectedVersion.draft.counterpartyName.value).toBe("URL Wins Pvt Ltd");
    expect((await fresh(manager, other.head.agreementRef)).selectedVersion.draft.counterpartyName.value).not.toBe("URL Wins Pvt Ltd");

    // an unknown route param shape never reaches Firestore as a path
    expect(await get(detailRoute.GET, manager, "/agreements/..%2F..%2Fpartners", "../../partners")).toMatchObject({ status: 404, body: NOT_FOUND });
  });

  it("409 stale_write when the expectedDocVersion is old", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const created = await createAgreement(manager, partnerCp(partner));
    const ref = created.head.agreementRef;
    const body = { version: 1, expectedDocVersion: 1, fieldKey: "counterpartyName", decision: "CORRECTED", value: "First" };
    ok(await post(fieldsRoute.POST, manager, `/agreements/${ref}/fields`, body, ref), "first");
    const stale = await post(fieldsRoute.POST, manager, `/agreements/${ref}/fields`, { ...body, value: "Second" }, ref);
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: expect.any(String) });
  });
});

// =====================================================================================================================
describe("create idempotency and confirm readiness", () => {
  it("POST agreements is 201 (created) then 200 (existing) for the same clientRequestId, with X-Finance-Agreement-Outcome; a different payload under the same id is a 409", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const other = await seedPartner();
    const clientRequestId = `crid-${runId}-idem-${randomUUID().slice(0, 6)}`;
    claimIds.push(agreementClaimId(manager.uid, clientRequestId));

    const first = await post(agreementsRoute.POST, manager, "/agreements", { clientRequestId, counterparty: partnerCp(partner) });
    expect(first.status).toBe(201);
    expect(first.headers.get("X-Finance-Agreement-Outcome")).toBe("created");
    agreementRefs.push(first.body.head.agreementRef);

    const second = await post(agreementsRoute.POST, manager, "/agreements", { clientRequestId, counterparty: partnerCp(partner) });
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Finance-Agreement-Outcome")).toBe("existing");
    expect(second.body.head.agreementRef).toBe(first.body.head.agreementRef);

    const conflicting = await post(agreementsRoute.POST, manager, "/agreements", { clientRequestId, counterparty: partnerCp(other) });
    expect(conflicting.status).toBe(409);

    // a Vendor Agreement is created through the same route
    const vendor = await seedVendor();
    const vendorAgreement = await createAgreement(manager, vendorCp(vendor));
    expect(vendorAgreement.head.counterparty).toMatchObject({ type: "VENDOR", ref: vendor.vendorRef });

    // the counterparty's list shows only its own Agreements
    const listed = ok(await get(agreementsRoute.GET, manager, `/agreements?counterpartyType=PARTNER&ref=${partner.partnerRef}`), "list");
    expect(listed.agreements.map((a: { agreementRef: string }) => a.agreementRef)).toEqual([first.body.head.agreementRef]);
    expect(JSON.stringify(listed)).not.toMatch(/partnerUid|vendorUid|ownerUid|regionIds/);
  });

  it("confirming an incomplete draft is 409 not_ready with per-field blockers, and writes nothing", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const created = await createAgreement(manager, partnerCp(partner));
    const ref = created.head.agreementRef;
    const before = await fresh(manager, ref);

    const result = await confirm(manager, before);
    expect(result.status).toBe(409);
    expect(result.body.error).toEqual(expect.any(String));
    expect(Array.isArray(result.body.blockers)).toBe(true);
    expect(result.body.blockers.length).toBeGreaterThan(0);
    for (const blocker of result.body.blockers) expect(blocker).toMatchObject({ fieldKey: expect.any(String), code: expect.any(String) });

    const after = await fresh(manager, ref);
    expect(after.selectedVersion).toMatchObject({ confirmed: false, docVersion: before.selectedVersion.docVersion });
    expect(after.head.docVersion).toBe(before.head.docVersion);
  });

  it("activating an unconfirmed draft is a 409 conflict (Head), and a forged expectedDocVersion is a 409 stale", async () => {
    const manager = await actor("partnership_manager");
    const head = await actor("partnership_head");
    const partner = await seedPartner();
    const created = await createAgreement(manager, partnerCp(partner));
    expect((await activate(head, created)).status).toBe(409);

    const confirmed = await confirmedAgreement(manager, partnerCp(partner));
    const stale = await post(activateRoute.POST, head, `/agreements/${confirmed.head.agreementRef}/activate`, { version: 1, expectedDocVersion: confirmed.head.docVersion + 5 }, confirmed.head.agreementRef);
    expect(stale.status).toBe(409);
    expect((await fresh(head, confirmed.head.agreementRef)).head.status).toBe("DRAFT");
  });
});

// =====================================================================================================================
describe("POST /api/finance/contracts/upload (multipart)", () => {
  // Track what an upload created so afterAll can remove it (artifact doc + its content claim).
  function track(partnerRef: string, type: "PARTNER" | "VENDOR", bytes: Uint8Array, artifactRef: string) {
    artifactRefs.push(artifactRef);
    claimIds.push(contractArtifactClaimId(type, partnerRef, sha256Hex(bytes)));
  }

  it("stores a PDF: 201 + created header, safe metadata only (no locator / bucket / path / URL); the same bytes again are 200 + existing", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const bytes = SAMPLE_PDF();

    const first = await upload(manager, multipart({ file: { bytes, name: "Signed Contract (final).pdf" }, counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef }));
    expect(first.status).toBe(201);
    expect(first.headers.get("X-Finance-Contract-Outcome")).toBe("created");
    track(partner.partnerRef, "PARTNER", bytes, first.body.artifactRef);
    expect(Object.keys(first.body).sort()).toEqual(["artifactRef", "counterparty", "fileName", "mimeType", "sha256Prefix", "sizeBytes", "status", "uploadedAt", "uploadedByUserRef"]);
    expect(first.body).toMatchObject({ artifactRef: expect.stringMatching(/^ca_/), fileName: "Signed Contract (final).pdf", mimeType: "application/pdf", sizeBytes: bytes.length, status: "UPLOADED", counterparty: { type: "PARTNER", ref: partner.partnerRef } });
    expect(first.body.sha256Prefix).toHaveLength(12);
    expectNoStorageExposure(first.body, "upload response");
    expect(store.size).toBe(1);

    const again = await upload(manager, multipart({ file: { bytes, name: "renamed.pdf" }, counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef }));
    expect(again.status).toBe(200);
    expect(again.headers.get("X-Finance-Contract-Outcome")).toBe("existing");
    expect(again.body.artifactRef).toBe(first.body.artifactRef);
    expect(store.size).toBe(1);

    // a Vendor counterparty uploads through the same route
    const vendor = await seedVendor();
    const vendorUpload = await upload(manager, multipart({ file: { bytes: makeTextPdf([["vendor contract body long enough to be real text"]]), name: "vendor.pdf" }, counterpartyType: "VENDOR", counterpartyRef: vendor.vendorRef }));
    expect(vendorUpload.status).toBe(201);
    track(vendor.vendorRef, "VENDOR", makeTextPdf([["vendor contract body long enough to be real text"]]), vendorUpload.body.artifactRef);
    expect(vendorUpload.body.counterparty).toEqual({ type: "VENDOR", ref: vendor.vendorRef });
    expectNoStorageExposure(vendorUpload.body, "vendor upload response");

    // the read-only summary shape is not exposed as a route, and the persisted doc's locator never leaves the server
    const raw = (await financeContractArtifactsCollection().doc(first.body.artifactRef).get()).data()!;
    expect(raw.storageLocator).toEqual(expect.stringMatching(/^finance-contracts\//));
    expect(JSON.stringify(first.body)).not.toContain(raw.storageLocator as string);
  });

  it("the 10 MB boundary: exactly 10 MB is accepted, 10 MB + 1 byte is refused, and neither stores anything unless accepted", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const form = (bytes: Uint8Array) => multipart({ file: { bytes, name: "big.pdf" }, counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef });

    const exactly = paddedPdf(MAX_CONTRACT_PDF_BYTES);
    const accepted = await upload(manager, form(exactly));
    expect(accepted.status).toBe(201);
    expect(accepted.body.sizeBytes).toBe(MAX_CONTRACT_PDF_BYTES);
    track(partner.partnerRef, "PARTNER", exactly, accepted.body.artifactRef);
    expect(store.size).toBe(1);

    const over = await upload(manager, form(paddedPdf(MAX_CONTRACT_PDF_BYTES + 1)));
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/10 MB/);
    expect(store.size).toBe(1);
    expectNoStorageExposure(over.body, "over-limit response");

    // the request cap (10 MB + 64 KB of framing) is above the file limit, so the two are distinct guards
    expect(CONTRACT_UPLOAD_MAX_REQUEST_BYTES).toBeGreaterThan(MAX_CONTRACT_PDF_BYTES);
    // ... and it sits below the raised Next proxy buffer (11 MB), so the proxy can never truncate an accepted body
    expect(CONTRACT_UPLOAD_MAX_REQUEST_BYTES).toBeLessThan(11 * 1024 * 1024);
  });

  it("a body over the request cap is 413 - by Content-Length BEFORE the body is read, and by actual size when no length is declared", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();

    // declared length far over the cap; the body stream must never be pulled
    let pulls = 0;
    // highWaterMark 0: the source is pulled ONLY when a consumer actually reads the body
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(1024));
          if (pulls > 3) controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    httpActor = manager;
    const declared = await uploadRoute.POST(
      new Request(`${BASE}/contracts/upload`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(200 * 1024 * 1024) }, body: stream, duplex: "half" } as RequestInit),
    );
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: expect.stringMatching(/10 MB/) });
    expect(pulls).toBe(0);

    // no declared length (chunked): refused by the bounded read once it passes the cap, never buffered whole
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          sent += 1;
          controller.enqueue(new Uint8Array(1024 * 1024));
          if (sent > 40) controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const chunked = await uploadRoute.POST(new Request(`${BASE}/contracts/upload`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: endless, duplex: "half" } as RequestInit));
    expect(chunked.status).toBe(413);
    expect(sent).toBeLessThan(20);

    // a real multipart whose FILE is small but whose total is over the cap is 413 too
    const bloated = await upload(manager, multipart({ file: { bytes: paddedPdf(MAX_CONTRACT_PDF_BYTES + 128 * 1024), name: "huge.pdf" }, counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef }));
    expect(bloated.status).toBe(413);
    expect(store.size).toBe(0);

    // an unparseable Content-Length is a 400, not a bypass
    const bogus = await uploadRoute.POST(new Request(`${BASE}/contracts/upload`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "lots" }, body: "x" }));
    expect(bogus.status).toBe(400);
  });

  it("rejects a non-PDF, a non-multipart request, malformed multipart and missing fields - and stores nothing", async () => {
    const manager = await actor("partnership_manager");
    const partner = await seedPartner();
    const text = new TextEncoder().encode("this is a plain text file, not a PDF at all");

    const notPdf = await upload(manager, multipart({ file: { bytes: text, name: "contract.pdf" }, counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef }));
    expect(notPdf.status).toBe(400);
    expect(notPdf.body.error).toMatch(/not a PDF/i);

    const empty = await upload(manager, multipart({ file: { bytes: new Uint8Array(0), name: "empty.pdf" }, counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef }));
    expect(empty.status).toBe(400);

    // wrong content types
    const json = await send(uploadRoute.POST, manager, { method: "POST", path: "/contracts/upload", json: { counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef } });
    expect(json.status).toBe(415);
    const urlencoded = await uploadRoute.POST(new Request(`${BASE}/contracts/upload`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=b" }));
    expect(urlencoded.status).toBe(415);
    const noType = await uploadRoute.POST(new Request(`${BASE}/contracts/upload`, { method: "POST", body: new Uint8Array([1, 2, 3]) }));
    expect(noType.status).toBe(415);

    // malformed multipart / empty body / missing pieces
    const garbage = await uploadRoute.POST(new Request(`${BASE}/contracts/upload`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=zzz" }, body: "this is not multipart" }));
    expect(garbage.status).toBe(400);
    const nothing = await uploadRoute.POST(new Request(`${BASE}/contracts/upload`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=zzz" } }));
    expect(nothing.status).toBe(400);
    const pdf = SAMPLE_PDF();
    expect((await upload(manager, multipart({ counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef }))).status).toBe(400);
    expect((await upload(manager, multipart({ file: { bytes: pdf, name: "a.pdf" }, counterpartyRef: partner.partnerRef }))).status).toBe(400);
    expect((await upload(manager, multipart({ file: { bytes: pdf, name: "a.pdf" }, counterpartyType: "PARTNER" }))).status).toBe(400);
    expect((await upload(manager, multipart({ file: { bytes: pdf, name: "a.pdf" }, counterpartyType: "CAMPAIGN", counterpartyRef: partner.partnerRef }))).status).toBe(400);
    // a text field named "file" is not a file
    const textFile = new FormData();
    textFile.set("file", "%PDF-1.4");
    textFile.set("counterpartyType", "PARTNER");
    textFile.set("counterpartyRef", partner.partnerRef);
    expect((await upload(manager, textFile)).status).toBe(400);

    // a traversal-shaped file name is neutralized, not echoed as a path
    const named = await upload(manager, multipart({ file: { bytes: pdf, name: "../../etc/passwd.pdf" }, counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef }));
    expect(named.status).toBe(201);
    track(partner.partnerRef, "PARTNER", pdf, named.body.artifactRef);
    expect(named.body.fileName).not.toMatch(/[\\/]/);
    expect(store.size).toBe(1);
  });
});

// =====================================================================================================================
describe("the full journey through the routes", () => {
  const IDENTITY_STRINGS = ["ABCPE1234F", "29ABCPE1234F1Z5", "123456789012", "HDFC0001234", "234123412346", "2341 2341 2346"];
  const ALLOWED_COLLECTIONS = new Set<string>(Object.values(FINANCE_AGREEMENT_COLLECTIONS));

  it("create -> upload -> extract -> attach -> reconcile -> decide -> confirm -> activate: every step through a route, no identity value leaks to a Manager, and no Partner / Vendor / KYC record is ever written", async () => {
    const manager = await actor("partnership_manager");
    const head = await actor("partnership_head");
    const partner = await seedPartner();
    await seedRestrictedIdentity(partner);
    const watched = [partnersCollection().doc(partner.uid), restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("PARTNER", partner.uid))];
    const before = await Promise.all(watched.map(async (ref) => JSON.stringify((await ref.get()).data())));

    transcript = [];
    const io = instrumentWrites();
    try {
      // 1. create
      const created = await createAgreement(manager, partnerCp(partner));
      const ref = created.head.agreementRef;
      expect(created.head).toMatchObject({ status: "DRAFT", openVersion: 1 });

      // 2. upload
      const bytes = SAMPLE_PDF();
      const uploaded = await upload(manager, multipart({ file: { bytes, name: "collab-agreement.pdf" }, counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef }));
      expect(uploaded.status).toBe(201);
      track(partner.partnerRef, uploaded.body.artifactRef, bytes);

      // 3. extract
      const extracted = ok(await post(extractRoute.POST, manager, "/contracts/extract", { agreementRef: ref, version: 1, artifactRef: uploaded.body.artifactRef }), "extract");
      restrictedRunRefs.push(extracted.run.runRef);
      expect(extracted.run).toMatchObject({ status: "EXTRACTED", artifactRef: uploaded.body.artifactRef });
      expect(extracted).toMatchObject({ contractDetailVisible: false, identityValuesVisible: false });
      expectNoStorageExposure(extracted, "extract response");

      // 3b. read it back (latest, and by runRef); a forged runRef is the neutral 404
      const latest = ok(await get(extractionRoute.GET, manager, `/agreements/${ref}/extraction`, ref), "extraction latest");
      expect(latest.run.runRef).toBe(extracted.run.runRef);
      expect(ok(await get(extractionRoute.GET, manager, `/agreements/${ref}/extraction?runRef=${extracted.run.runRef}`, ref), "by runRef").run.runRef).toBe(extracted.run.runRef);
      expect(await get(extractionRoute.GET, manager, `/agreements/${ref}/extraction?runRef=run_${"0".repeat(20)}`, ref)).toMatchObject({ status: 404, body: NOT_FOUND });

      // 4. attach (extracted values arrive PENDING, never accepted)
      const detailBefore = await fresh(manager, ref);
      const attached = ok(await post(attachRoute.POST, manager, `/agreements/${ref}/extraction/attach`, { version: 1, expectedDocVersion: detailBefore.selectedVersion.docVersion, extractionRunRef: extracted.run.runRef }, ref), "attach");
      expect(attached.attachedCount).toBeGreaterThan(10);
      for (const entry of Object.values(attached.agreement.selectedVersion.draft as Record<string, { origin: string; decision: string }>)) if (entry.origin === "EXTRACTED") expect(entry.decision).toBe("PENDING");
      expect(attached.agreement.selectedVersion.source).toMatchObject({ contractArtifactRef: uploaded.body.artifactRef, extractionRunRef: extracted.run.runRef });

      // 5. reconcile (read-only; identity is RESTRICTED for a Manager - no value, no match result)
      const reconciliation = ok(await get(reconciliationRoute.GET, manager, `/agreements/${ref}/reconciliation`, ref), "reconciliation");
      expect(reconciliation.agreementRef).toBe(ref);
      expect(reconciliation.fields.length).toBeGreaterThan(10);
      const panField = reconciliation.fields.find((f: { fieldKey: string }) => f.fieldKey === "panNumber");
      expect(panField).toMatchObject({ state: "RESTRICTED" });
      expect(JSON.stringify(panField)).not.toMatch(/ABCPE1234F|QWERT4321Z/);

      // 5b. KYC status is status only
      const kyc = ok(await get(kycStatusRoute.GET, manager, `/agreements/${ref}/kyc-status`, ref), "kyc-status");
      expect(kyc).toMatchObject({ agreementRef: ref, counterpartyType: "PARTNER", valuesVisible: false });
      expect(kyc.components).toEqual({ pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" });

      // 6. decide + accept pending, then confirm
      // The extracted signed date differs from the fixture's, so a value-carrying ACCEPTED becomes a deliberate CORRECTED.
      const seeds = READY_DECISIONS.map((seed) => (seed.decision === "ACCEPTED" && seed.value !== undefined ? { ...seed, decision: "CORRECTED" as const } : seed));
      const decided = await acceptPending(manager, await decide(manager, await fresh(manager, ref), seeds));
      const confirmed = ok(await confirm(manager, decided), "confirm");
      expect(confirmed.selectedVersion).toMatchObject({ confirmed: true, status: "DRAFT", sourceMode: "MIXED" });
      expect(confirmed.selectedVersion.terms.commercial).toMatchObject({ currency: "INR" });

      // 6b. Step 14B.1: an artifact-backed version cannot be activated until its ORIGINAL signed document is stored (Drive; the fake here).
      const blocked = await activate(head, confirmed);
      expect(blocked).toMatchObject({ status: 409, body: { blockers: [{ code: "agreement_document_not_stored" }] } });
      expect(await post(documentRoute.POST, null, `/agreements/${ref}/document`, { version: 1 }, ref)).toMatchObject({ status: 401 });
      const stored = ok(await post(documentRoute.POST, manager, `/agreements/${ref}/document`, { version: 1 }, ref), "store document");
      expect(stored).toMatchObject({ outcome: "stored", retriable: false, document: { status: "STORED", fileName: "collab-agreement.pdf", hasLink: true } });
      // the Manager holds no finance_contracts: it learns THAT a link exists, never the link
      expect(stored.document.link).toBeUndefined();
      expect(JSON.stringify(stored)).not.toMatch(/drive\.invalid|driveLink|driveFileId/);
      expect(drive.storage.files).toHaveLength(1);
      expect(drive.storage.files[0]!.receivedSha256).toBe(sha256Hex(bytes));
      expect(ok(await post(documentRoute.POST, manager, `/agreements/${ref}/document`, { version: 1 }, ref), "store again")).toMatchObject({ outcome: "already_stored" });
      expect(drive.storage.files).toHaveLength(1);

      // 7. the Manager cannot activate; the Head can
      expect((await activate(manager, confirmed)).status).toBe(403);
      const activated = ok(await activate(head, confirmed), "activate");
      expect(activated.head).toMatchObject({ status: "ACTIVE", activeVersion: 1, openVersion: null });
      expect(activated.selectedVersion).toMatchObject({ status: "ACTIVE", confirmed: true });

      // 8. once confirmed, the version is immutable through the routes too
      const late = await post(fieldsRoute.POST, manager, `/agreements/${ref}/fields`, { version: 1, expectedDocVersion: activated.selectedVersion.docVersion, fieldKey: "counterpartyName", decision: "CORRECTED", value: "Late Edit" }, ref);
      expect(late.status).toBe(409);

      // 9. the Head (finance_contracts) is given the SAME Drive reference on the status route, the detail and the Partner projection
      const status = ok(await get(documentRoute.GET, head, `/agreements/${ref}/document?version=1`, ref), "document status");
      expect(status).toMatchObject({ agreementRef: ref, version: 1, storageConfigured: true, document: { status: "STORED", hasLink: true, link: drive.storage.files[0]!.webViewLink } });
      expect((await fresh(head, ref)).selectedVersion.document.link).toBe(drive.storage.files[0]!.webViewLink);
      const projection = ok(await get(counterpartyDocumentsRoute.GET, head, `/counterparties/documents?counterpartyType=PARTNER&ref=${partner.partnerRef}`), "projection");
      expect(projection).toMatchObject({ linksVisible: true, documents: [{ agreementRef: ref, version: 1, lifecycle: "ACTIVE", document: { status: "STORED", link: drive.storage.files[0]!.webViewLink } }] });
      const managerProjection = ok(await get(counterpartyDocumentsRoute.GET, manager, `/counterparties/documents?counterpartyType=PARTNER&ref=${partner.partnerRef}`), "manager projection");
      expect(managerProjection).toMatchObject({ linksVisible: false, documents: [{ document: { status: "STORED", hasLink: true } }] });
      expect(JSON.stringify(managerProjection)).not.toMatch(/drive\.invalid|"link"/);
      expect(await get(documentRoute.GET, manager, `/agreements/${FORGED_REF}/document`, FORGED_REF)).toMatchObject({ status: 404, body: NOT_FOUND });
      expect(await get(counterpartyDocumentsRoute.GET, manager, `/counterparties/documents?counterpartyType=PARTNER&ref=nope`)).toMatchObject({ status: 404, body: NOT_FOUND });
      expect(await get(counterpartyDocumentsRoute.GET, manager, `/counterparties/documents?counterpartyType=NOPE&ref=${partner.partnerRef}`)).toMatchObject({ status: 400 });

      // the Head reads the extraction with the restricted categories; the Manager's whole transcript held no identity value
      const headView = ok(await get(extractionRoute.GET, head, `/agreements/${ref}/extraction`, ref), "head extraction");
      expect(headView).toMatchObject({ contractDetailVisible: true, identityValuesVisible: true });
    } finally {
      io.stop();
    }

    // No identity value or storage detail in anything a Manager received (the Head's own extraction read is the last, deliberate exception)
    const managerTranscript = transcript.slice(0, -1).join("\n");
    for (const secret of [...IDENTITY_STRINGS, SECRETS.pan, SECRETS.account, SECRETS.ifsc, SECRETS.holder]) expect(managerTranscript, `transcript leaked ${secret}`).not.toContain(secret);
    expect(managerTranscript).not.toMatch(/storageLocator|finance-contracts\/|gs:\/\//);

    // Boundary: every write the journey made was to a Finance Agreements collection; nothing to Partners / Vendors / KYC
    expect(io.paths.length).toBeGreaterThan(10);
    for (const path of io.paths) expect(ALLOWED_COLLECTIONS.has(path.split("/")[0]!), `wrote ${path}`).toBe(true);
    expect(io.paths.filter((path) => /^(partners|partnerAccounts|vendors|vendorPartnerLinks|restrictedFinancialIdentities)\b/.test(path))).toEqual([]);
    expect(await Promise.all(watched.map(async (ref) => JSON.stringify((await ref.get()).data())))).toEqual(before);
  });

  // (defined here so the journey's cleanup tracking stays next to it)
  function track(partnerRef: string, artifactRef: string, bytes: Uint8Array) {
    artifactRefs.push(artifactRef);
    claimIds.push(contractArtifactClaimId("PARTNER", partnerRef, sha256Hex(bytes)));
  }
});

// =====================================================================================================================
describe("master-data, KYC and KYC-status routes", () => {
  it("POST master-data goes through the owning module: a decided email fills a MISSING Partner email; a viewer is 403; a second FILL is a 409 (never a silent overwrite)", async () => {
    const manager = await actor("partnership_manager");
    const viewer = await actor("viewer");
    const partner = await seedPartner({ email: null });
    const created = await createAgreement(manager, partnerCp(partner));
    const ref = created.head.agreementRef;

    const decided = await decide(manager, created, [{ fieldKey: "emailAddress", decision: "CORRECTED", value: "found.in.contract@example.test" }]);
    const body = { version: 1, fieldKey: "emailAddress", mode: "FILL_MISSING", expectedCounterpartyVersion: 1, expectedDocVersion: decided.selectedVersion.docVersion };
    expect((await post(masterDataRoute.POST, viewer, `/agreements/${ref}/master-data`, body, ref)).status).toBe(403);
    expect((await post(masterDataRoute.POST, manager, `/agreements/${ref}/master-data`, { ...body, extra: 1 }, ref)).status).toBe(400);
    // OVERWRITE without an acknowledged resolution is refused by input shape
    expect((await post(masterDataRoute.POST, manager, `/agreements/${ref}/master-data`, { ...body, mode: "OVERWRITE_MISMATCH" }, ref)).status).toBe(400);

    const applied = await post(masterDataRoute.POST, manager, `/agreements/${ref}/master-data`, body, ref);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({ agreementRef: ref, fieldKey: "emailAddress", mode: "FILL_MISSING", counterpartyType: "PARTNER" });
    expect((await partnersCollection().doc(partner.uid).get()).data()).toMatchObject({ email: "found.in.contract@example.test", version: 2 });

    const again = await post(masterDataRoute.POST, manager, `/agreements/${ref}/master-data`, { ...body, expectedCounterpartyVersion: 2 }, ref);
    expect(again.status).toBe(409);
    expect((await partnersCollection().doc(partner.uid).get()).data()).toMatchObject({ email: "found.in.contract@example.test", version: 2 });
  });

  it("POST kyc needs finance_contracts + the identity category: 403 for a Manager; a Head with no attached extraction gets a refusal that writes nothing", async () => {
    const manager = await actor("partnership_manager");
    const head = await actor("partnership_head");
    const partner = await seedPartner();
    await seedRestrictedIdentity(partner);
    const created = await createAgreement(manager, partnerCp(partner));
    const ref = created.head.agreementRef;
    const identityRef = restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("PARTNER", partner.uid));
    const before = JSON.stringify((await identityRef.get()).data());

    const body = { version: 1, components: ["pan"], mode: "FILL_MISSING" };
    expect(await post(kycRoute.POST, manager, `/agreements/${ref}/kyc`, body, ref)).toMatchObject({ status: 403, body: FORBIDDEN });
    const refused = await post(kycRoute.POST, head, `/agreements/${ref}/kyc`, body, ref);
    expect([400, 404, 409]).toContain(refused.status);
    expect((await post(kycRoute.POST, head, `/agreements/${ref}/kyc`, { ...body, components: ["pan", "pan"] }, ref)).status).toBe(400);
    expect(JSON.stringify((await identityRef.get()).data())).toBe(before);
    expect(JSON.stringify(refused.body)).not.toContain(SECRETS.pan);
  });

  it("GET kyc-status: a Manager sees the state only; the Head (identity category) sees per-component status; never a value", async () => {
    const manager = await actor("partnership_manager");
    const head = await actor("partnership_head");
    const complete = await seedPartner();
    await seedRestrictedIdentity(complete);
    const bare = await seedPartner();
    const completeRef = (await createAgreement(manager, partnerCp(complete))).head.agreementRef;
    const bareRef = (await createAgreement(manager, partnerCp(bare))).head.agreementRef;

    const managerView = ok(await get(kycStatusRoute.GET, manager, `/agreements/${completeRef}/kyc-status`, completeRef), "manager kyc");
    expect(managerView).toMatchObject({ state: "AVAILABLE", valuesVisible: false, components: { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" } });
    const headView = ok(await get(kycStatusRoute.GET, head, `/agreements/${completeRef}/kyc-status`, completeRef), "head kyc");
    expect(headView).toMatchObject({ state: "AVAILABLE", valuesVisible: true, components: { pan: "PRESENT", bank: "PRESENT" } });
    expect(ok(await get(kycStatusRoute.GET, head, `/agreements/${bareRef}/kyc-status`, bareRef), "bare").state).toBe("MISSING");
    for (const body of [managerView, headView]) for (const secret of Object.values(SECRETS)) expect(JSON.stringify(body)).not.toContain(secret);
  });
});

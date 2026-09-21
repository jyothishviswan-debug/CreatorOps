// Step 14B - the four thin read routes behind the workspace and the intake picker, called as real handlers (Request in,
// Response out) against the running Firestore/Auth emulator. ONLY the session lookup is replaced (as in the 14A routes test);
// every service, gate, grant and Firestore read underneath is real.
//
//   GET /api/finance/agreements/workspace       GET /api/finance/counterparties/search
//   GET /api/finance/counterparties/preview     GET /api/finance/permissions
//
// Hermetic: private-region fixtures with a per-run name tag; everything created is removed afterwards.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { COLLECTIONS } from "@/server/authz/firestore";
import { scopeGrantDocId } from "@/server/authz/scope";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext, ScopeGrant, ScopeGrantInput } from "@/server/authz/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { partnersCollection } from "@/server/partners/firestore";
import { partnerDocSchema, type PartnerDoc } from "@/server/partners/types";
import { vendorsCollection } from "@/server/vendors/firestore";
import { vendorDocSchema, type VendorDoc } from "@/server/vendors/types";

let httpActor: ActorContext | null = null;
vi.mock("@/server/administration/http", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/administration/http")>();
  return { ...original, resolveRequestActor: async () => httpActor };
});

import * as workspaceRoute from "@/app/api/finance/agreements/workspace/route";
import * as searchRoute from "@/app/api/finance/counterparties/search/route";
import * as previewRoute from "@/app/api/finance/counterparties/preview/route";
import * as permissionsRoute from "@/app/api/finance/permissions/route";

import { agreementClaimId, financeAgreementClaimsCollection, financeAgreementsCollection } from "./firestore";
import { createAgreementDraft } from "./index";

vi.setConfig({ testTimeout: 90_000 });

const runId = Date.now();
const R_IN = `fwr-in-${runId}`;
const R_OUT = `fwr-out-${runId}`;
const TAG = `FWR${runId}`;
const BASE = "http://localhost:3000/api/finance";
const FORBIDDEN = { error: "Forbidden." };
const NOT_FOUND = { error: "Not found." };

const uidByRole = new Map<string, string>();
const cleanup: FirebaseFirestore.DocumentReference[] = [];
const agreementRefs: string[] = [];
const claimIds: string[] = [];
const grantDocIds: string[] = [];
let counter = 0;

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  const auth = getAdminAuth();
  for (const identity of TEST_IDENTITIES) uidByRole.set(identity.role, (await auth.getUserByEmail(identity.email)).uid);
}, 60_000);

afterAll(async () => {
  httpActor = null;
  const db = getAdminFirestore();
  for (const ref of agreementRefs.splice(0)) await db.recursiveDelete(financeAgreementsCollection().doc(ref));
  await Promise.all(claimIds.splice(0).map((id) => financeAgreementClaimsCollection().doc(id).delete()));
  await Promise.all(cleanup.splice(0).map((ref) => ref.delete()));
  await Promise.all(grantDocIds.splice(0).map((id) => db.collection(COLLECTIONS.scopeAssignments).doc(id).delete()));
});

async function seededActor(role: string): Promise<ActorContext> {
  const actor = await resolveActor(uidByRole.get(role)!);
  if (!actor) throw new Error(`no seeded actor for ${role}`);
  return actor;
}

async function syntheticActor(role: ActorContext["role"], grants: ScopeGrantInput[]): Promise<ActorContext> {
  const uid = `fwr-${role}-${runId}-${randomUUID().slice(0, 6)}`;
  const grantedAt = new Date().toISOString();
  for (const input of grants) {
    const id = scopeGrantDocId(uid, input);
    await getAdminFirestore()
      .collection(COLLECTIONS.scopeAssignments)
      .doc(id)
      .set({ ...input, uid, grantedAt, grantedBy: "fwr-test" } as ScopeGrant);
    grantDocIds.push(id);
  }
  return { uid, email: `${uid}@example.test`, role, displayName: `FWR ${role}`, userRef: `fwr-ref-${uid}` };
}

async function seedPartner(name: string, regionIds: string[]): Promise<PartnerDoc> {
  counter += 1;
  const uid = `fwr-partner-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const partner = partnerDocSchema.parse({ uid, partnerRef: `ref-${uid}`, version: 1, displayName: name, displayNameLower: name.toLowerCase(), email: "route@example.test", phone: "+91 90000 00000", status: "ACTIVE", regionIds, createdAt: now, createdByUserRef: "fwr-test", updatedAt: now, updatedByUserRef: "fwr-test" });
  const ref = partnersCollection().doc(uid);
  await ref.set(partner);
  cleanup.push(ref);
  return partner;
}

async function seedVendor(name: string, regionIds: string[]): Promise<VendorDoc> {
  counter += 1;
  const uid = `fwr-vendor-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const vendor = vendorDocSchema.parse({ uid, vendorRef: `ref-${uid}`, version: 1, displayName: name, displayNameLower: name.toLowerCase(), vendorType: "AGENCY", email: "vendor-route@example.test", status: "ACTIVE", regionIds, createdAt: now, createdByUserRef: "fwr-test", updatedAt: now, updatedByUserRef: "fwr-test" });
  const ref = vendorsCollection().doc(uid);
  await ref.set(vendor);
  cleanup.push(ref);
  return vendor;
}

async function create(actor: ActorContext, counterparty: { type: "PARTNER"; partnerRef: string } | { type: "VENDOR"; vendorRef: string }): Promise<string> {
  const clientRequestId = `crid-${runId}-${(counter += 1)}-${randomUUID().slice(0, 6)}`;
  const result = await createAgreementDraft(actor, { clientRequestId, counterparty }, `req-${runId}-${counter}`);
  if (!result.ok) throw new Error(result.message);
  agreementRefs.push(result.data.agreement.head.agreementRef);
  claimIds.push(agreementClaimId(actor.uid, clientRequestId));
  return result.data.agreement.head.agreementRef;
}

const get = async (handler: { GET: (request: Request) => Promise<Response> }, path: string, actor: ActorContext | null) => {
  httpActor = actor;
  const response = await handler.GET(new Request(`${BASE}${path}`));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe("workspace / picker / permissions routes", () => {
  let manager: ActorContext;
  let headActor: ActorContext;
  let partner: PartnerDoc;
  let outPartner: PartnerDoc;
  let vendor: VendorDoc;
  const refs: string[] = [];

  beforeAll(async () => {
    manager = await syntheticActor("partnership_manager", [{ type: "REGION", region: R_IN }]);
    headActor = await syntheticActor("partnership_head", [{ type: "REGION", region: R_IN }, { type: "REGION", region: R_OUT }]);
    partner = await seedPartner(`${TAG} Route Partner`, [R_IN]);
    outPartner = await seedPartner(`${TAG} Route Out Partner`, [R_OUT]);
    vendor = await seedVendor(`${TAG} Route Vendor`, [R_IN]);
    refs.push(await create(headActor, { type: "PARTNER", partnerRef: partner.partnerRef }));
    refs.push(await create(headActor, { type: "VENDOR", vendorRef: vendor.vendorRef }));
    await create(headActor, { type: "PARTNER", partnerRef: outPartner.partnerRef });
  });

  it("workspace: 401 unauthenticated, 403 {error:'Forbidden.'} for a Viewer and an Analyst, 200 for the in-scope Manager", async () => {
    expect((await get(workspaceRoute, "/agreements/workspace", null)).status).toBe(401);
    for (const role of ["viewer", "analyst"]) {
      const denied = await get(workspaceRoute, `/agreements/workspace?q=${TAG}`, await seededActor(role));
      expect(denied.status, role).toBe(403);
      expect(denied.body).toEqual(FORBIDDEN);
    }
    const ok = await get(workspaceRoute, `/agreements/workspace?q=${TAG}`, manager);
    expect(ok.status).toBe(200);
    const rows = ok.body.rows as Array<{ agreementRef: string; counterparty: { displayName: string } }>;
    expect(rows.map((row) => row.agreementRef).sort()).toEqual([...refs].sort());
    expect(rows.map((row) => row.counterparty.displayName)).not.toContain(`${TAG} Route Out Partner`);
    expect(ok.body).toMatchObject({ nextCursor: null, offset: 0, pageSize: 20, totalInBoundedSet: 2, disclosure: { headsTruncated: false, scanLimit: 500 }, permissions: { canView: true, canManage: true, canActivate: false } });
  });

  it("workspace: query params map to filters, paging and the limit; an invalid value is ignored with a notice (never a 400 for a filter)", async () => {
    const vendors = await get(workspaceRoute, `/agreements/workspace?q=${TAG}&counterpartyType=VENDOR`, manager);
    expect((vendors.body.rows as unknown[]).length).toBe(1);
    const paged = await get(workspaceRoute, `/agreements/workspace?q=${TAG}&limit=1`, manager);
    expect((paged.body.rows as unknown[]).length).toBe(1);
    expect(typeof paged.body.nextCursor).toBe("string");
    const next = await get(workspaceRoute, `/agreements/workspace?q=${TAG}&limit=1&cursor=${encodeURIComponent(paged.body.nextCursor as string)}`, manager);
    expect((next.body.rows as unknown[]).length).toBe(1);
    expect(next.body.nextCursor).toBeNull();
    expect(((next.body.rows as Array<{ agreementRef: string }>)[0]!.agreementRef)).not.toBe((paged.body.rows as Array<{ agreementRef: string }>)[0]!.agreementRef);
    const junk = await get(workspaceRoute, `/agreements/workspace?q=${TAG}&lifecycle=BOGUS`, manager);
    expect(junk.status).toBe(200);
    expect(junk.body.notices).toEqual(["Some filters were not valid and were ignored."]);
  });

  it("search: 400 without a type, 401 / 403 denials, 200 with in-scope ACTIVE results only (also via the `type` alias)", async () => {
    expect((await get(searchRoute, "/counterparties/search", manager)).status).toBe(400);
    expect((await get(searchRoute, "/counterparties/search?counterpartyType=PARTNER&limit=99", manager)).status).toBe(400);
    expect((await get(searchRoute, "/counterparties/search?counterpartyType=PARTNER", null)).status).toBe(401);
    const denied = await get(searchRoute, "/counterparties/search?counterpartyType=PARTNER", await seededActor("viewer"));
    expect(denied).toEqual({ status: 403, body: FORBIDDEN });
    const partners = await get(searchRoute, `/counterparties/search?counterpartyType=PARTNER&q=${encodeURIComponent(TAG)}`, manager);
    expect(partners.status).toBe(200);
    expect((partners.body.results as Array<{ displayName: string }>).map((r) => r.displayName)).toEqual([`${TAG} Route Partner`]);
    const vendors = await get(searchRoute, `/counterparties/search?type=VENDOR&q=${encodeURIComponent(TAG)}`, manager);
    expect((vendors.body.results as Array<{ displayName: string }>).map((r) => r.displayName)).toEqual([`${TAG} Route Vendor`]);
  });

  it("preview: 200 for an in-scope counterparty; neutral 404 for out-of-scope / forged / wrong-type refs; 400 without a ref; 403 for a Viewer", async () => {
    const ok = await get(previewRoute, `/counterparties/preview?counterpartyType=PARTNER&ref=${partner.partnerRef}`, manager);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ source: "CreatorOps master data", type: "PARTNER", ref: partner.partnerRef, email: "route@example.test", kyc: { state: "MISSING", valuesVisible: false }, gstinStatus: "RESTRICTED" });
    for (const path of [`?counterpartyType=PARTNER&ref=${outPartner.partnerRef}`, `?counterpartyType=PARTNER&ref=ref-nope`, `?counterpartyType=VENDOR&ref=${partner.partnerRef}`]) {
      const missing = await get(previewRoute, `/counterparties/preview${path}`, manager);
      expect(missing).toEqual({ status: 404, body: NOT_FOUND });
    }
    expect((await get(previewRoute, "/counterparties/preview?counterpartyType=PARTNER", manager)).status).toBe(400);
    expect(await get(previewRoute, `/counterparties/preview?counterpartyType=PARTNER&ref=${partner.partnerRef}`, await seededActor("viewer"))).toEqual({ status: 403, body: FORBIDDEN });
    expect((await get(previewRoute, `/counterparties/preview?counterpartyType=PARTNER&ref=${partner.partnerRef}`, null)).status).toBe(401);
  });

  it("permissions: 401 unauthenticated; 200 for every signed-in role with real-grant booleans; 400 for an unknown type", async () => {
    expect((await get(permissionsRoute, "/permissions", null)).status).toBe(401);
    const viewer = await get(permissionsRoute, "/permissions", await seededActor("viewer"));
    expect(viewer).toMatchObject({ status: 200, body: { canView: false, canManage: false, canActivate: false, canViewContractDetail: false, canViewIdentity: false, canManageCounterpartyKyc: false } });
    const managerDto = await get(permissionsRoute, "/permissions?counterpartyType=PARTNER", await seededActor("partnership_manager"));
    expect(managerDto.body).toMatchObject({ canView: true, canManage: true, canActivate: false, canViewIdentity: false, counterpartyType: "PARTNER" });
    const admin = await get(permissionsRoute, "/permissions?counterpartyType=VENDOR", await seededActor("super_admin"));
    expect(admin.body).toMatchObject({ canView: true, canManage: true, canActivate: true, canViewContractDetail: true, canViewIdentity: true, canManageCounterpartyKyc: true, counterpartyType: "VENDOR" });
    expect((await get(permissionsRoute, "/permissions?counterpartyType=CREATOR", manager)).status).toBe(400);
  });
});

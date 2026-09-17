// Step 8A section 13: a small, deterministic Vendors dataset covering
// every canonical status, the M:N relationship shape, payee role,
// historical (ended) relationships, and same-scope/cross-scope Vendors -
// mirrors Partners' own seed-partners-data.ts idiom exactly (fixed doc
// ids, full overwrite, safe synthetic values only, idempotent across
// repeated resets).
//
// Deliberately reuses Partners' already-seeded Partners (creator-house,
// seed-partner-direct, seed-partner-inactive) rather than inventing new
// ones - this file must run AFTER seedPartnersData.
import { getAdminAuth } from "@/server/firebase/admin";
import { getServerEnv, isUsingEmulators } from "@/lib/env/server";
import { getUserDoc } from "@/server/authz/firestore";
import { restrictedVendorFinancialIdentitiesCollection, vendorPartnerLinksCollection, vendorsCollection } from "./firestore";
import type { RestrictedVendorFinancialIdentityDoc, VendorDoc, VendorPartnerLinkDoc } from "./types";

async function uidFor(email: string): Promise<string> {
  const user = await getAdminAuth().getUserByEmail(email);
  return user.uid;
}

function daysAgoIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export async function seedVendorsData(): Promise<void> {
  if (!isUsingEmulators()) {
    throw new Error("seedVendorsData: refusing to run - Firebase emulator env vars are not set.");
  }
  const { projectId } = getServerEnv();
  if (!projectId.startsWith("demo-")) {
    throw new Error(`seedVendorsData: refusing to run - resolved project id "${projectId}" doesn't look like the local demo project.`);
  }

  const viewerUid = await uidFor("viewer@creatorops.com");
  const headDoc = await getUserDoc(await uidFor("head@creatorops.com"));
  if (!headDoc) throw new Error("seedVendorsData: head@creatorops.com has no users/{uid} document yet - run seedAccessControlData first.");
  const headUserRef = headDoc.userRef;

  const now = new Date();
  const nowIso = now.toISOString();

  function base(uid: string, displayName: string): Omit<VendorDoc, "status" | "previousStatus" | "statusReason" | "regionIds" | "ownerUid" | "vendorType"> {
    return {
      uid,
      vendorRef: uid,
      version: 1,
      displayName,
      displayNameLower: displayName.toLowerCase(),
      legalName: null,
      email: `${uid}@example-vendor.test`,
      phone: "+91 90000 00002",
      businessReferences: [],
      teamIds: [],
      createdAt: nowIso,
      createdByUserRef: headUserRef,
      updatedAt: nowIso,
      updatedByUserRef: headUserRef,
    };
  }

  // Deliberately: no region grants Karnataka to Partnership Manager (see
  // seed-access-data.ts's SCOPE_GRANTS - Manager has Kerala/Maharashtra/
  // South/West only), so seed-vendor-agency and seed-vendor-manager are
  // cross-scope for Manager despite creator-house (which they're linked
  // to) being Manager-visible via its own PARTNER-type grant - the exact
  // "a visible Partner relationship must not bridge into unrelated
  // Vendor scope" proof Step 8A section 7 asks for, in the other
  // direction (a Vendor's own scope is never inferred from a linked
  // Partner's scope either).
  const vendors: VendorDoc[] = [
    {
      ...base("seed-vendor-agency", "Northline Talent Agency"),
      status: "ACTIVE",
      previousStatus: null,
      statusReason: null,
      vendorType: "AGENCY",
      regionIds: ["Karnataka"],
      ownerUid: null,
    },
    {
      ...base("seed-vendor-manager", "Priya Menon Management"),
      status: "ACTIVE",
      previousStatus: null,
      statusReason: null,
      vendorType: "MANAGER_REPRESENTATIVE",
      regionIds: ["Karnataka"],
      ownerUid: null,
    },
    {
      // No region - reachable ONLY through SELF (ownerUid) scope, same
      // "isolate one scope dimension cleanly" idiom as Partners'
      // seed-partner-direct.
      ...base("seed-vendor-payee", "Coastal Payouts LLP"),
      status: "ACTIVE",
      previousStatus: null,
      statusReason: null,
      vendorType: "PAYEE_BUSINESS",
      regionIds: [],
      ownerUid: viewerUid,
    },
    {
      ...base("seed-vendor-inactive", "Dormant Creative Co"),
      status: "INACTIVE",
      previousStatus: null,
      statusReason: null,
      vendorType: "OTHER",
      regionIds: ["Kerala"],
      ownerUid: null,
    },
    {
      ...base("seed-vendor-archived", "Wound Down Studios"),
      status: "ARCHIVED",
      previousStatus: "INACTIVE",
      statusReason: "Business relationship concluded - no longer operating in this market.",
      vendorType: "OTHER",
      regionIds: ["Maharashtra"],
      ownerUid: null,
    },
  ];

  for (const vendor of vendors) {
    await vendorsCollection().doc(vendor.uid).set(vendor);
  }

  function linkBase(uid: string, vendorRef: string, partnerRef: string): Omit<VendorPartnerLinkDoc, "relationshipType" | "payeeRole" | "effectiveFrom" | "effectiveTo" | "status"> {
    return {
      uid,
      vendorPartnerLinkRef: uid,
      version: 1,
      vendorRef,
      partnerRef,
      createdAt: nowIso,
      createdByUserRef: headUserRef,
      updatedAt: nowIso,
      updatedByUserRef: headUserRef,
    };
  }

  const links: VendorPartnerLinkDoc[] = [
    // creator-house ends up with TWO active Vendor relationships (this
    // link + the manager one below) - "one Partner with multiple active
    // Vendor relationships."
    {
      ...linkBase("seed-link-agency-creatorhouse", "seed-vendor-agency", "creator-house"),
      relationshipType: "AGENCY",
      payeeRole: true,
      effectiveFrom: daysAgoIso(now, 400),
      effectiveTo: null,
      status: "ACTIVE",
    },
    // seed-vendor-agency ends up linked to two Partners while ACTIVE -
    // "ACTIVE agency linked to multiple Partners" / "one Vendor with
    // multiple Partner relationships."
    {
      ...linkBase("seed-link-agency-direct", "seed-vendor-agency", "seed-partner-direct"),
      relationshipType: "AGENCY",
      payeeRole: false,
      effectiveFrom: daysAgoIso(now, 200),
      effectiveTo: null,
      status: "ACTIVE",
    },
    // A real ended historical relationship, effectiveTo set, preserved
    // (never hard-deleted) - "one ended historical relationship with
    // effectiveTo."
    {
      ...linkBase("seed-link-agency-inactive-partner-ended", "seed-vendor-agency", "seed-partner-inactive"),
      relationshipType: "AGENCY",
      payeeRole: false,
      effectiveFrom: daysAgoIso(now, 365),
      effectiveTo: daysAgoIso(now, 180),
      status: "ENDED",
    },
    // "ACTIVE manager/representative linked to one Partner" - its only link.
    {
      ...linkBase("seed-link-manager-creatorhouse", "seed-vendor-manager", "creator-house"),
      relationshipType: "MANAGEMENT",
      payeeRole: false,
      effectiveFrom: daysAgoIso(now, 300),
      effectiveTo: null,
      status: "ACTIVE",
    },
    // "one PAYEE relationship" - payeeRole explicit, never inferred.
    {
      ...linkBase("seed-link-payee-direct", "seed-vendor-payee", "seed-partner-direct"),
      relationshipType: "PAYEE",
      payeeRole: true,
      effectiveFrom: daysAgoIso(now, 150),
      effectiveTo: null,
      status: "ACTIVE",
    },
    // Scope-escalation-bridge proof, the other direction from the
    // creator-house/Manager one above: seed-vendor-inactive (Kerala) IS
    // in Partnership Manager's Vendor scope, but the Partner it links to
    // here (seed-partner-inactive, Tamil Nadu) is NOT in Manager's
    // Partner scope. Manager can see this link row (an opaque
    // partnerRef) from the Vendor side without that ever granting
    // Partner-side access to seed-partner-inactive itself, or to
    // listVendorLinksForPartner("seed-partner-inactive").
    {
      ...linkBase("seed-link-inactive-vendor-inactive-partner", "seed-vendor-inactive", "seed-partner-inactive"),
      relationshipType: "OTHER",
      payeeRole: false,
      effectiveFrom: daysAgoIso(now, 90),
      effectiveTo: null,
      status: "ACTIVE",
    },
  ];

  for (const link of links) {
    await vendorPartnerLinksCollection().doc(link.uid).set(link);
  }

  // The one restricted-identity subject - safe fake values only, same
  // idiom as Partners' own seeded restricted identity fixture (never
  // real PAN/GST/bank data).
  const restrictedIdentity: RestrictedVendorFinancialIdentityDoc = {
    uid: "seed-vendor-agency",
    vendorRef: "seed-vendor-agency",
    version: 1,
    pan: { number: "ABCDE1111F" },
    gst: { applicable: true, number: "29ABCDE1111F1Z5" },
    bank: { accountHolderName: "Northline Talent Agency", accountNumber: "000000000002", ifsc: "TEST0000002", bankName: "Test Bank", branchName: "Test Branch" },
    evidence: [],
    updatedAt: nowIso,
    updatedByUserRef: headUserRef,
  };
  await restrictedVendorFinancialIdentitiesCollection().doc(restrictedIdentity.uid).set(restrictedIdentity);
}

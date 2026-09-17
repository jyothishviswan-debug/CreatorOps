// Step 7A section 12: a small, deterministic Partners dataset covering
// every canonical status plus direct-create/multi-account/restricted-
// identity fixtures - mirrors Discovery's own seed-discovery-data.ts
// idiom exactly (fixed doc ids, full overwrite, safe synthetic values
// only, idempotent across repeated resets).
//
// "creator-house" is not an arbitrary id - it is the exact uid
// seed-access-data.ts's SCOPE_GRANTS already grants
// partnership_manager a `{ type: "PARTNER", partnerId: "creator-house" }`
// scope for. That grant was seeded ahead of this Partner actually
// existing; this file is what makes it resolve to something real,
// proving PARTNER-type scope works independently of region/team (the
// Partner itself sits in Karnataka, outside every one of the manager's
// REGION/TEAM grants - the PARTNER grant is the ONLY reason the manager
// identity can reach it).
import { getAdminAuth } from "@/server/firebase/admin";
import { getServerEnv, isUsingEmulators } from "@/lib/env/server";
import { getUserDoc } from "@/server/authz/firestore";
import { partnerAccountIdentityClaimsCollection, partnerAccountsCollection, partnersCollection, restrictedFinancialIdentitiesCollection } from "./firestore";
import { claimIdFor, computeNormalizedIdentity } from "./identity";
import type { PartnerAccountDoc, PartnerAccountIdentityClaimDoc, PartnerDoc, RestrictedFinancialIdentityDoc } from "./types";

async function uidFor(email: string): Promise<string> {
  const user = await getAdminAuth().getUserByEmail(email);
  return user.uid;
}

async function seedAccount(account: PartnerAccountDoc): Promise<void> {
  await partnerAccountsCollection().doc(account.uid).set(account);
  const claim: PartnerAccountIdentityClaimDoc = {
    normalizedIdentity: account.normalizedIdentity,
    partnerAccountUid: account.uid,
    partnerAccountRef: account.partnerAccountRef,
    claimedAt: account.createdAt,
  };
  await partnerAccountIdentityClaimsCollection().doc(claimIdFor(account.normalizedIdentity)).set(claim);
}

export async function seedPartnersData(): Promise<void> {
  if (!isUsingEmulators()) {
    throw new Error("seedPartnersData: refusing to run - Firebase emulator env vars are not set.");
  }
  const { projectId } = getServerEnv();
  if (!projectId.startsWith("demo-")) {
    throw new Error(`seedPartnersData: refusing to run - resolved project id "${projectId}" doesn't look like the local demo project.`);
  }

  const [viewerUid, analystUid, headUid] = await Promise.all([uidFor("viewer@creatorops.com"), uidFor("analyst@creatorops.com"), uidFor("head@creatorops.com")]);
  const headDoc = await getUserDoc(headUid);
  if (!headDoc) throw new Error("seedPartnersData: head@creatorops.com has no users/{uid} document yet - run seedAccessControlData first.");
  const headUserRef = headDoc.userRef;

  const now = new Date().toISOString();

  function base(uid: string, displayName: string): Omit<PartnerDoc, "status" | "previousStatus" | "statusReason" | "regionIds" | "teamIds" | "ownerUid"> {
    return {
      uid,
      partnerRef: uid,
      version: 1,
      displayName,
      displayNameLower: displayName.toLowerCase(),
      legalName: null,
      languageIds: [],
      categoryIds: [],
      tier: null,
      priority: null,
      targetAudience: null,
      email: `${uid}@example-partner.test`,
      phone: "+91 90000 00001",
      originLeadRefs: [],
      sourceDiscovery: null,
      pendingPartnerAccountSetup: false,
      createdAt: now,
      createdByUserRef: headUserRef,
      updatedAt: now,
      updatedByUserRef: headUserRef,
    };
  }

  const partners: PartnerDoc[] = [
    {
      ...base("creator-house", "Creator House"),
      status: "ACTIVE",
      previousStatus: null,
      statusReason: null,
      regionIds: ["Karnataka"],
      teamIds: [],
      ownerUid: null,
    },
    {
      ...base("seed-partner-direct", "Meera Krishnan"),
      status: "ACTIVE",
      previousStatus: null,
      statusReason: null,
      regionIds: ["Kerala"],
      teamIds: [],
      ownerUid: viewerUid,
    },
    {
      ...base("seed-partner-inactive", "Arjun Balan"),
      status: "INACTIVE",
      previousStatus: null,
      statusReason: null,
      regionIds: ["Tamil Nadu"],
      teamIds: [],
      ownerUid: analystUid,
    },
    {
      ...base("seed-partner-blacklisted", "Rekha Pillai"),
      status: "BLACKLISTED",
      previousStatus: "ACTIVE",
      statusReason: "Repeated brief violations - paused pending programme review.",
      regionIds: ["Maharashtra"],
      teamIds: ["maharashtra-programmes"],
      ownerUid: null,
    },
    {
      ...base("seed-partner-archived", "Vikram Nair"),
      status: "ARCHIVED",
      previousStatus: "INACTIVE",
      statusReason: "Programme wound down - no longer an active relationship.",
      regionIds: ["Kerala"],
      teamIds: ["kerala-programmes"],
      ownerUid: headUid,
    },
  ];

  for (const partner of partners) {
    await partnersCollection().doc(partner.uid).set(partner);
  }

  // creator-house's own account set - deliberately covers every Partner
  // Account fixture requirement in one place: multiple accounts on one
  // Partner, two on the SAME platform with different normalized
  // identities (instagram handle "creatorhouse" vs "creatorhouse.reels"),
  // and one with a stable platform account id (the YouTube channel id -
  // the strongest identity evidence, preferred over handle/URL).
  function accountBase(uid: string, platform: string): Omit<PartnerAccountDoc, "handle" | "displayName" | "profileUrl" | "platformAccountId" | "normalizedIdentity" | "primary"> {
    return {
      uid,
      partnerAccountRef: uid,
      version: 1,
      partnerRef: "creator-house",
      platform,
      status: "ACTIVE",
      followerSnapshot: { count: 128000, asOf: now },
      originAssetDecision: null,
      originLeadRef: null,
      createdAt: now,
      createdByUserRef: headUserRef,
      updatedAt: now,
      updatedByUserRef: headUserRef,
    };
  }

  const instagramPrimaryIdentity = computeNormalizedIdentity({ platform: "Instagram", handle: "creatorhouse" })!;
  const instagramSecondaryIdentity = computeNormalizedIdentity({ platform: "Instagram", handle: "creatorhouse.reels" })!;
  const youtubeIdentity = computeNormalizedIdentity({ platform: "YouTube", platformAccountId: "UCCreatorHouseSeedChannel" })!;

  await seedAccount({
    ...accountBase("seed-account-creatorhouse-ig-primary", "Instagram"),
    handle: "creatorhouse",
    displayName: "Creator House",
    profileUrl: "https://instagram.com/creatorhouse",
    platformAccountId: null,
    normalizedIdentity: instagramPrimaryIdentity,
    primary: true,
  });
  await seedAccount({
    ...accountBase("seed-account-creatorhouse-ig-reels", "Instagram"),
    handle: "creatorhouse.reels",
    displayName: "Creator House Reels",
    profileUrl: "https://instagram.com/creatorhouse.reels",
    platformAccountId: null,
    normalizedIdentity: instagramSecondaryIdentity,
    primary: false,
  });
  await seedAccount({
    ...accountBase("seed-account-creatorhouse-yt", "YouTube"),
    handle: "CreatorHouse",
    displayName: "Creator House",
    profileUrl: "https://youtube.com/@creatorhouse",
    platformAccountId: "UCCreatorHouseSeedChannel",
    normalizedIdentity: youtubeIdentity,
    primary: false,
  });

  // The one restricted-identity subject - safe fake values only, same
  // idiom as Discovery's own seeded KYC fixture (never real PAN/Aadhaar/
  // bank data).
  const restrictedIdentity: RestrictedFinancialIdentityDoc = {
    uid: "creator-house",
    partnerRef: "creator-house",
    version: 1,
    pan: { number: "ABCDE0000F" },
    aadhaar: { number: "0000-0000-0000" },
    bank: { accountHolderName: "Creator House", accountNumber: "000000000001", ifsc: "TEST0000001", bankName: "Test Bank", branchName: "Test Branch" },
    gst: { applicable: false },
    evidence: [],
    updatedAt: now,
    updatedByUserRef: headUserRef,
  };
  await restrictedFinancialIdentitiesCollection().doc(restrictedIdentity.uid).set(restrictedIdentity);
}

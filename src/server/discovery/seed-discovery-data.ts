// Step 6A section 12: a small, deterministic Discovery dataset covering
// every canonical lifecycle state (plus one already-CONVERTED Lead),
// with scope ownership deliberately chosen so the five canonical test
// identities can prove allow/deny behavior the same way
// seed-access-data.ts's SCOPE_GRANTS already do for the rest of the app.
// Safe fake values only - idempotent (fixed doc ids, full overwrite) so
// re-seeding produces the same baseline every run.
import { getAdminAuth } from "@/server/firebase/admin";
import { getServerEnv, isUsingEmulators } from "@/lib/env/server";
import { getUserDoc } from "@/server/authz/firestore";
import { leadRestrictedKycCollection, leadsCollection, partnersCollection } from "./firestore";
import type { LeadDoc, PartnerDoc } from "./types";

async function uidFor(email: string): Promise<string> {
  const user = await getAdminAuth().getUserByEmail(email);
  return user.uid;
}

export async function seedDiscoveryData(): Promise<void> {
  if (!isUsingEmulators()) {
    throw new Error("seedDiscoveryData: refusing to run - Firebase emulator env vars are not set.");
  }
  const { projectId } = getServerEnv();
  if (!projectId.startsWith("demo-")) {
    throw new Error(`seedDiscoveryData: refusing to run - resolved project id "${projectId}" doesn't look like the local demo project.`);
  }

  const [viewerUid, analystUid, managerUid, headUid] = await Promise.all([
    uidFor("viewer@creatorops.com"),
    uidFor("analyst@creatorops.com"),
    uidFor("manager@creatorops.com"),
    uidFor("head@creatorops.com"),
  ]);
  const headDoc = await getUserDoc(headUid);
  if (!headDoc) throw new Error("seedDiscoveryData: head@creatorops.com has no users/{uid} document yet - run seedAccessControlData first.");
  const headUserRef = headDoc.userRef;

  const now = new Date().toISOString();

  function base(uid: string, leadRef: string, displayName: string): Omit<LeadDoc, "lifecycle" | "previousLifecycle" | "lifecycleReason" | "region" | "teamId" | "ownerUid"> {
    return {
      uid,
      leadRef,
      version: 1,
      displayName,
      displayNameLower: displayName.toLowerCase(),
      email: `${leadRef.replace("seed-lead-", "")}@example-creator.test`,
      phone: "+91 90000 00000",
      profileUrl: `https://instagram.com/${leadRef.replace("seed-lead-", "")}`,
      platform: "Instagram",
      handle: leadRef.replace("seed-lead-", ""),
      source: { type: "research" },
      research: null,
      latestReview: null,
      outreachSummary: null,
      respondedAt: null,
      commercial: null,
      discoveryAgreement: null,
      assetDecision: null,
      managerUid: null,
      kycPackageComplete: false,
      duplicateCheck: null,
      conversion: null,
      proposalNumber: null,
      proposalPlatformCode: null,
      createdAt: now,
      createdByUserRef: headUserRef,
      updatedAt: now,
      updatedByUserRef: headUserRef,
    };
  }

  const leads: LeadDoc[] = [
    {
      ...base("seed-lead-new", "seed-lead-new", "Nila Rasheed"),
      lifecycle: "NEW",
      previousLifecycle: null,
      lifecycleReason: null,
      region: "Kerala",
      teamId: null,
      ownerUid: viewerUid,
    },
    {
      ...base("seed-lead-researching", "seed-lead-researching", "Devika Menon"),
      lifecycle: "RESEARCHING",
      previousLifecycle: null,
      lifecycleReason: null,
      region: "Karnataka",
      teamId: null,
      ownerUid: null,
      research: { targetAudience: "India 1", language: "Kannada", notes: "Strong regional storytelling niche.", updatedAt: now, updatedByUserRef: headUserRef },
    },
    {
      ...base("seed-lead-contacted", "seed-lead-contacted", "Farhan Sheikh"),
      lifecycle: "CONTACTED",
      previousLifecycle: null,
      lifecycleReason: null,
      region: "Maharashtra",
      teamId: "kerala-programmes",
      ownerUid: managerUid,
      research: { targetAudience: "India 2", updatedAt: now, updatedByUserRef: headUserRef },
      outreachSummary: { totalCount: 1, lastDirection: "OUTBOUND", lastChannel: "email", lastOutcome: "Awaiting reply", lastAt: now, nextFollowUpAt: null },
    },
    {
      ...base("seed-lead-responded", "seed-lead-responded", "Priya Varghese"),
      lifecycle: "RESPONDED",
      previousLifecycle: null,
      lifecycleReason: null,
      region: "Tamil Nadu",
      teamId: null,
      ownerUid: analystUid,
      research: { targetAudience: "India 3", updatedAt: now, updatedByUserRef: headUserRef },
      outreachSummary: { totalCount: 2, lastDirection: "INBOUND", lastChannel: "email", lastOutcome: "Interested, requested more detail", lastAt: now, nextFollowUpAt: null },
      respondedAt: now,
    },
    {
      ...base("seed-lead-evaluating", "seed-lead-evaluating", "Rohit Kulkarni"),
      lifecycle: "EVALUATING",
      previousLifecycle: null,
      lifecycleReason: null,
      region: "Maharashtra",
      teamId: "maharashtra-programmes",
      ownerUid: headUid,
      research: { targetAudience: "India 4", updatedAt: now, updatedByUserRef: headUserRef },
      outreachSummary: { totalCount: 2, lastDirection: "INBOUND", lastChannel: "whatsapp", lastOutcome: "Meaningful reply", lastAt: now, nextFollowUpAt: null },
      respondedAt: now,
      latestReview: { outcome: "NEED_MORE_INFO", dimensions: { contentQuality: 3 }, reason: "Need more recent posting history.", actorUserRef: headUserRef, createdAt: now },
    },
    {
      ...base("seed-lead-conversion-ready", "seed-lead-conversion-ready", "Ishaan Bhatt"),
      lifecycle: "CONVERSION_READY",
      previousLifecycle: null,
      lifecycleReason: null,
      region: "Kerala",
      teamId: "kerala-programmes",
      ownerUid: headUid,
      research: { targetAudience: "India Alpha", updatedAt: now, updatedByUserRef: headUserRef },
      outreachSummary: { totalCount: 3, lastDirection: "INBOUND", lastChannel: "call", lastOutcome: "Confirmed interest", lastAt: now, nextFollowUpAt: null },
      respondedAt: now,
      latestReview: { outcome: "SHORTLIST", dimensions: { contentQuality: 5, audienceQuality: 4, overallConfidence: 5 }, actorUserRef: headUserRef, createdAt: now },
      commercial: { negotiationSummary: "Agreed on standard rate card.", alignmentConfirmed: true, updatedAt: now, updatedByUserRef: headUserRef },
      discoveryAgreement: { summary: "Operational terms acknowledged.", confirmedAt: now, updatedAt: now, updatedByUserRef: headUserRef },
      assetDecision: { decision: "NEW_ACCOUNT", decidedAt: now, decidedByUserRef: headUserRef },
      managerUid: headUid,
      kycPackageComplete: true,
      duplicateCheck: { status: "none", matches: [], checkedAt: now },
    },
    {
      ...base("seed-lead-watchlist", "seed-lead-watchlist", "Sana Iqbal"),
      lifecycle: "WATCHLIST",
      previousLifecycle: "EVALUATING",
      lifecycleReason: "Awaiting budget confirmation from the programme team.",
      region: "Karnataka",
      teamId: null,
      ownerUid: null,
    },
    {
      ...base("seed-lead-rejected", "seed-lead-rejected", "Manoj Pillai"),
      lifecycle: "REJECTED",
      previousLifecycle: "RESEARCHING",
      lifecycleReason: "Profile does not match any approved Target Audience.",
      region: "Karnataka",
      teamId: null,
      ownerUid: null,
    },
    {
      ...base("seed-lead-duplicate", "seed-lead-duplicate", "Anjali Suresh"),
      lifecycle: "DUPLICATE",
      previousLifecycle: "NEW",
      lifecycleReason: "Matches an existing Lead by profile URL.",
      region: "Karnataka",
      teamId: null,
      ownerUid: null,
      duplicateCheck: { status: "confirmed", matches: [{ type: "profileUrl", source: "lead", ref: "seed-lead-new", confidence: "high" }], checkedAt: now },
    },
    {
      ...base("seed-lead-converted", "seed-lead-converted", "Kabir Anand"),
      lifecycle: "CONVERTED",
      previousLifecycle: "CONVERSION_READY",
      lifecycleReason: null,
      region: "Kerala",
      teamId: null,
      ownerUid: headUid,
      research: { targetAudience: "India Alpha", updatedAt: now, updatedByUserRef: headUserRef },
      outreachSummary: { totalCount: 3, lastDirection: "INBOUND", lastChannel: "call", lastOutcome: "Confirmed interest", lastAt: now, nextFollowUpAt: null },
      respondedAt: now,
      latestReview: { outcome: "SHORTLIST", dimensions: { overallConfidence: 5 }, actorUserRef: headUserRef, createdAt: now },
      commercial: { alignmentConfirmed: true, updatedAt: now, updatedByUserRef: headUserRef },
      discoveryAgreement: { confirmedAt: now, updatedAt: now, updatedByUserRef: headUserRef },
      assetDecision: { decision: "NEW_ACCOUNT", decidedAt: now, decidedByUserRef: headUserRef },
      managerUid: headUid,
      kycPackageComplete: true,
      duplicateCheck: { status: "none", matches: [], checkedAt: now },
      conversion: { convertedAt: now, convertedByUserRef: headUserRef, partnerRef: "seed-partner-converted", partnerAccountRef: null, idempotencyKey: "seed-conversion" },
    },
  ];

  for (const lead of leads) {
    await leadsCollection().doc(lead.uid).set(lead);
  }

  // A safe fake restricted KYC package for the two Leads whose
  // kycPackageComplete is true - never real PAN/Aadhaar/bank data.
  const fakeKyc = {
    email: "kyc-test@example-creator.test",
    aadhaar: { number: "0000-0000-0000" },
    pan: { number: "ABCDE0000F" },
    bank: { accountHolderName: "Test Creator", accountNumber: "000000000000", ifsc: "TEST0000000", bankName: "Test Bank", branchName: "Test Branch" },
    gst: { applicable: false },
    updatedAt: now,
    updatedByUserRef: headUserRef,
  };
  for (const uid of ["seed-lead-conversion-ready", "seed-lead-converted"]) {
    await leadRestrictedKycCollection()
      .doc(uid)
      .set({ uid, version: 1, ...fakeKyc });
  }

  const convertedLead = leads.find((l) => l.uid === "seed-lead-converted")!;
  const partner: PartnerDoc = {
    uid: "seed-partner-converted",
    partnerRef: "seed-partner-converted",
    version: 1,
    displayName: convertedLead.displayName,
    email: convertedLead.email,
    phone: convertedLead.phone,
    region: convertedLead.region,
    sourceDiscovery: {
      leadRef: convertedLead.leadRef,
      convertedAt: now,
      snapshot: {
        displayName: convertedLead.displayName,
        email: convertedLead.email,
        phone: convertedLead.phone,
        profileUrl: convertedLead.profileUrl,
        platform: convertedLead.platform,
        handle: convertedLead.handle,
        source: convertedLead.source,
      },
    },
    pendingPartnerAccountSetup: true,
    createdAt: now,
    createdByUserRef: headUserRef,
  };
  await partnersCollection().doc(partner.uid).set(partner);
}

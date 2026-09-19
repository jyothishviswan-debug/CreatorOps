// Step 9A section 16: a small, deterministic Campaigns dataset covering
// every canonical status, both review policies, multiple regions/teams,
// same-scope/cross-scope fixtures, one with resources, one without, one
// manager-owned (SELF scope), and one explicit CAMPAIGN-grant-scoped
// fixture ("civic-voices", matching the CAMPAIGN-type scope grant
// seed-access-data.ts already gives partnership_head) - mirrors Vendors'
// own seed-vendors-data.ts idiom exactly (fixed doc ids, full overwrite,
// safe synthetic values only, idempotent across repeated resets).
import { getAdminAuth } from "@/server/firebase/admin";
import { getServerEnv, isUsingEmulators } from "@/lib/env/server";
import { getUserDoc } from "@/server/authz/firestore";
import { campaignsCollection } from "./firestore";
import type { CampaignDoc } from "./types";

async function uidFor(email: string): Promise<string> {
  const user = await getAdminAuth().getUserByEmail(email);
  return user.uid;
}

function daysFromNowIso(now: Date, days: number): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function seedCampaignsData(): Promise<void> {
  if (!isUsingEmulators()) {
    throw new Error("seedCampaignsData: refusing to run - Firebase emulator env vars are not set.");
  }
  const { projectId } = getServerEnv();
  if (!projectId.startsWith("demo-")) {
    throw new Error(`seedCampaignsData: refusing to run - resolved project id "${projectId}" doesn't look like the local demo project.`);
  }

  const managerUid = await uidFor("manager@creatorops.com");
  const headDoc = await getUserDoc(await uidFor("head@creatorops.com"));
  if (!headDoc) throw new Error("seedCampaignsData: head@creatorops.com has no users/{uid} document yet - run seedAccessControlData first.");
  const headUserRef = headDoc.userRef;

  const now = new Date();
  const nowIso = now.toISOString();

  function base(uid: string, name: string): Omit<CampaignDoc, "status" | "statusReason" | "regionIds" | "teamIds" | "ownerUid" | "platforms" | "defaultReviewPolicy" | "resources" | "criteria"> {
    return {
      uid,
      campaignRef: uid,
      version: 1,
      name,
      nameLower: name.toLowerCase(),
      objective: `Programme-wide plan for ${name}.`,
      startDate: daysFromNowIso(now, -10),
      endDate: daysFromNowIso(now, 80),
      createdAt: nowIso,
      createdByUserRef: headUserRef,
      updatedAt: nowIso,
      updatedByUserRef: headUserRef,
    };
  }

  const resourceFixture = (label: string) => ({
    resourceRef: `${label.toLowerCase().replace(/\s+/g, "-")}-resource`,
    label,
    type: "BRIEF" as const,
    url: "https://example.com/campaign-brief.pdf",
    description: "Safe ordinary reference metadata only - no secrets, no restricted identity.",
    addedAt: nowIso,
    addedByUserRef: headUserRef,
  });

  // Deliberately: no region grant covers Uttar Pradesh for Partnership
  // Manager (see seed-access-data.ts's SCOPE_GRANTS), so
  // seed-campaign-paused (Uttar Pradesh) is cross-scope for Manager
  // despite being Head/Admin-visible - the same "genuinely out of scope,
  // not just hidden by UI" proof Vendors'/Partners' own seed data already
  // exercises.
  const campaigns: CampaignDoc[] = [
    {
      ...base("seed-campaign-draft", "Kerala Creator Onboarding"),
      status: "DRAFT",
      statusReason: null,
      platforms: ["instagram"],
      regionIds: ["Kerala"],
      teamIds: [],
      ownerUid: null,
      criteria: { targetAudience: ["India 1"], regionIds: ["Kerala"], languageIds: [], categoryIds: [], platforms: [] },
      resources: [],
      defaultReviewPolicy: "REVIEW_REQUIRED",
    },
    {
      ...base("seed-campaign-planned", "South Programmes Launch"),
      status: "PLANNED",
      statusReason: null,
      platforms: ["instagram", "youtube"],
      regionIds: ["Kerala", "Maharashtra"],
      teamIds: ["kerala-programmes", "maharashtra-programmes"],
      // SELF-scope proof - reachable for Manager ONLY via SELF (owner),
      // isolating that one scope dimension cleanly, same idiom as
      // Vendors'/Partners' own seed-vendor-payee/seed-partner-direct.
      ownerUid: managerUid,
      criteria: { targetAudience: ["India Alpha", "India 2"], regionIds: ["Kerala", "Maharashtra"], languageIds: [], categoryIds: [], platforms: ["instagram"] },
      resources: [resourceFixture("Launch Brief")],
      defaultReviewPolicy: "NO_PREPOST_REVIEW",
    },
    {
      ...base("civic-voices", "Civic Voices"),
      status: "ACTIVE",
      statusReason: null,
      platforms: ["youtube", "x"],
      regionIds: ["Tamil Nadu"],
      teamIds: [],
      ownerUid: null,
      // Reachable for Partnership Head ONLY through the explicit CAMPAIGN
      // scope grant naming this exact uid (see seed-access-data.ts's
      // SCOPE_GRANTS) - Tamil Nadu is not itself a region Head holds.
      criteria: { regionIds: [], languageIds: [], categoryIds: [], targetAudience: [], platforms: ["youtube"] },
      resources: [resourceFixture("Civic Voices Brief")],
      defaultReviewPolicy: "REVIEW_REQUIRED",
    },
    {
      ...base("seed-campaign-paused", "Uttar Pradesh Growth Push"),
      status: "PAUSED",
      statusReason: null,
      platforms: ["instagram", "tiktok"],
      regionIds: ["Uttar Pradesh"],
      teamIds: [],
      ownerUid: null,
      criteria: { regionIds: ["Uttar Pradesh"], languageIds: [], categoryIds: [], targetAudience: [], platforms: [] },
      resources: [],
      defaultReviewPolicy: "REVIEW_REQUIRED",
    },
    {
      ...base("seed-campaign-completed", "West Zone Retrospective"),
      status: "COMPLETED",
      statusReason: null,
      platforms: ["facebook"],
      regionIds: ["Gujarat"],
      teamIds: [],
      ownerUid: null,
      criteria: { regionIds: ["Gujarat"], languageIds: [], categoryIds: [], targetAudience: [], platforms: [] },
      resources: [resourceFixture("Retrospective Deck")],
      defaultReviewPolicy: "NO_PREPOST_REVIEW",
    },
    {
      ...base("seed-campaign-cancelled", "Discontinued Pilot"),
      status: "CANCELLED",
      statusReason: "Budget deprioritized before launch.",
      platforms: ["linkedin"],
      regionIds: ["Kerala"],
      teamIds: ["kerala-programmes"],
      ownerUid: null,
      criteria: { regionIds: [], languageIds: [], categoryIds: [], targetAudience: [], platforms: [] },
      resources: [],
      defaultReviewPolicy: "REVIEW_REQUIRED",
    },
    {
      ...base("seed-campaign-archived", "2025 Legacy Programme"),
      status: "ARCHIVED",
      statusReason: "Retired after full completion cycle.",
      platforms: ["youtube"],
      regionIds: ["Maharashtra"],
      teamIds: ["maharashtra-programmes"],
      ownerUid: null,
      criteria: { regionIds: [], languageIds: [], categoryIds: [], targetAudience: [], platforms: [] },
      resources: [],
      defaultReviewPolicy: "NO_PREPOST_REVIEW",
    },
  ];

  for (const campaign of campaigns) {
    await campaignsCollection().doc(campaign.uid).set(campaign);
  }
}

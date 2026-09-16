// Seeds the four access-control collections (users, accessGrants,
// scopeAssignments, sensitiveAccessGrants) for the five deterministic
// local test identities created in Step 4A. Idempotent - safe to re-run.
// Emulator-only, same guard pattern as seed-users.ts.
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { getServerEnv, isUsingEmulators } from "@/lib/env/server";
import type { ActionId } from "./actions";
import type { FeatureId } from "./features";
import { FEATURES } from "./features";
import { COLLECTIONS } from "./firestore";
import type { Role } from "./roles";
import { ROLES } from "./roles";
import type { AccessGrantDoc, ScopeGrant, ScopeGrantInput, SensitiveAccessGrantDoc, UserDoc } from "./types";

type TestIdentity = {
  email: string;
  role: Role;
  displayName: string;
};

// The same five emails seeded into the Auth emulator by seedEmulatorTestUsers
// (src/server/auth/seed-users.ts) - kept in sync deliberately, checked by
// seedAccessControlData itself (throws if an expected user is missing).
export const TEST_IDENTITIES: TestIdentity[] = [
  { email: "viewer@creatorops.com", role: "viewer", displayName: "Viewer (Test)" },
  { email: "analyst@creatorops.com", role: "analyst", displayName: "Analyst (Test)" },
  { email: "manager@creatorops.com", role: "partnership_manager", displayName: "Manager (Test)" },
  { email: "head@creatorops.com", role: "partnership_head", displayName: "Head (Test)" },
  { email: "admin@creatorops.com", role: "super_admin", displayName: "Admin (Test)" },
];

function featureGrant(view: boolean, actions: Partial<Record<ActionId, boolean>> = {}) {
  return { view, actions };
}

// Explicit, per-role feature/action grants. Every role's document is
// written independently here - none is derived from another, and Super
// Admin's is not "the union of everything else", it's its own explicit
// list. The matrix is deliberately non-monotonic (Analyst has
// imports/exports; Partnership Manager and Partnership Head - otherwise
// broader - do not) so no rank-based shortcut could reproduce it.
const ACCESS_GRANTS: Record<Role, Pick<AccessGrantDoc, "features">> = {
  viewer: {
    features: featuresOf(["dashboard", "discovery", "partners", "vendors", "campaigns", "assignments", "content", "analytics", "partner_reviews", "reports"]),
  },
  analyst: {
    features: featuresOf([
      "dashboard",
      "discovery",
      "partners",
      "vendors",
      "campaigns",
      "assignments",
      "content",
      "analytics",
      "partner_reviews",
      "reports",
      "imports",
      "exports",
    ]),
  },
  partnership_manager: {
    features: {
      ...featuresOf(["dashboard", "discovery", "partners", "vendors", "campaigns", "assignments", "content", "analytics", "partner_reviews", "operations", "reports"]),
      finance: featureGrant(true, { approve: false }),
    },
  },
  partnership_head: {
    features: {
      ...featuresOf(["dashboard", "discovery", "partners", "vendors", "campaigns", "assignments", "content", "analytics", "partner_reviews", "operations", "reports"]),
      finance: featureGrant(true, { approve: true }),
    },
  },
  super_admin: {
    features: Object.fromEntries(
      FEATURES.map((feature) => [feature, featureGrant(true, { create: true, edit: true, approve: true, export: true, manage: true })]),
    ) as AccessGrantDoc["features"],
  },
};

function featuresOf(features: FeatureId[]): AccessGrantDoc["features"] {
  return Object.fromEntries(features.map((feature) => [feature, featureGrant(true)])) as AccessGrantDoc["features"];
}

// Sensitive Access is a distinct gate from Feature Access: Partnership
// Manager can view Finance but is not granted the "finance_amounts"
// sensitive category, unlike Partnership Head.
const SENSITIVE_GRANTS: Record<Role, string[]> = {
  viewer: [],
  analyst: [],
  partnership_manager: [],
  partnership_head: ["finance_amounts"],
  super_admin: ["finance_amounts"],
};

// Explicit, per-role scope grants (Step 4C's canonical multi-dimensional
// model - see types.ts). Deliberately exercises every one of the 9 grant
// types across the five identities, and deliberately does NOT give every
// role the same shape of scope: Super Admin's GLOBAL grant is its own
// explicit document, not something inferred from the role name, and
// nothing here compares roles to each other to decide breadth.
const SCOPE_GRANTS: Record<Role, ScopeGrantInput[]> = {
  viewer: [{ type: "SELF" }, { type: "REGION", region: "Kerala" }],
  analyst: [
    { type: "REGION", region: "Kerala" },
    { type: "REGION", region: "Tamil Nadu" },
    { type: "ANALYTICS_DATASET", datasetId: "cross-platform-reach" },
    { type: "ANALYTICS_ACCOUNT", accountId: "instagram-primary" },
  ],
  partnership_manager: [
    { type: "REGION", region: "Kerala" },
    { type: "REGION", region: "Maharashtra" },
    { type: "TEAM", teamId: "kerala-programmes" },
    { type: "PARTNER", partnerId: "creator-house" },
  ],
  partnership_head: [
    { type: "REGION", region: "Kerala" },
    { type: "REGION", region: "Maharashtra" },
    { type: "REGION", region: "Tamil Nadu" },
    { type: "REGION", region: "Karnataka" },
    { type: "TEAM", teamId: "kerala-programmes" },
    { type: "TEAM", teamId: "maharashtra-programmes" },
    { type: "CAMPAIGN", campaignId: "civic-voices" },
    { type: "EXPLICIT_RECORD", resourceType: "content", resourceId: "community-story-reel-01" },
  ],
  super_admin: [{ type: "GLOBAL" }],
};

// Deterministic, human-decodable, and idempotent: re-seeding overwrites
// the same documents rather than creating duplicates, and each grant can
// be found/edited/deleted on its own by future Administration CRUD
// without touching any other grant. No "/" or ".." ever appears in a
// discriminator value here, so this is always a valid Firestore doc id.
function scopeGrantDocId(uid: string, grant: ScopeGrantInput): string {
  switch (grant.type) {
    case "SELF":
    case "GLOBAL":
      return `${uid}__${grant.type}`;
    case "REGION":
      return `${uid}__REGION__${grant.region}`;
    case "TEAM":
      return `${uid}__TEAM__${grant.teamId}`;
    case "PARTNER":
      return `${uid}__PARTNER__${grant.partnerId}`;
    case "CAMPAIGN":
      return `${uid}__CAMPAIGN__${grant.campaignId}`;
    case "EXPLICIT_RECORD":
      return `${uid}__EXPLICIT_RECORD__${grant.resourceType}__${grant.resourceId}`;
    case "ANALYTICS_DATASET":
      return `${uid}__ANALYTICS_DATASET__${grant.datasetId}`;
    case "ANALYTICS_ACCOUNT":
      return `${uid}__ANALYTICS_ACCOUNT__${grant.accountId}`;
  }
}

export async function seedAccessControlData(): Promise<void> {
  if (!isUsingEmulators()) {
    throw new Error("seedAccessControlData: refusing to run - Firebase emulator env vars are not set.");
  }
  const { projectId } = getServerEnv();
  if (!projectId.startsWith("demo-")) {
    throw new Error(`seedAccessControlData: refusing to run - resolved project id "${projectId}" doesn't look like the local demo project.`);
  }

  const auth = getAdminAuth();
  const db = getAdminFirestore();

  // accessGrants and sensitiveAccessGrants are keyed by role, independent
  // of which users exist yet.
  for (const role of ROLES) {
    const accessGrantDoc: AccessGrantDoc = { role, features: ACCESS_GRANTS[role].features };
    await db.collection(COLLECTIONS.accessGrants).doc(role).set(accessGrantDoc);

    const sensitiveDoc: SensitiveAccessGrantDoc = { role, categories: SENSITIVE_GRANTS[role] };
    await db.collection(COLLECTIONS.sensitiveAccessGrants).doc(role).set(sensitiveDoc);
  }

  for (const identity of TEST_IDENTITIES) {
    const authUser = await auth.getUserByEmail(identity.email);

    const userDoc: UserDoc = {
      uid: authUser.uid,
      email: identity.email,
      role: identity.role,
      active: true,
      displayName: identity.displayName,
    };
    await db.collection(COLLECTIONS.users).doc(authUser.uid).set(userDoc);

    // Migration from Step 4B's region-only model: that model stored one
    // flat scopeAssignments/{uid} document per user. This step replaces
    // it with a flat *collection* of per-grant documents (see types.ts),
    // so the old doc - now unread by any code - is removed rather than
    // left behind as a stale orphan.
    await db.collection(COLLECTIONS.scopeAssignments).doc(authUser.uid).delete();

    const grantedAt = new Date().toISOString();
    for (const grantInput of SCOPE_GRANTS[identity.role]) {
      const grant: ScopeGrant = { ...grantInput, uid: authUser.uid, grantedAt, grantedBy: "system:seed" } as ScopeGrant;
      await db.collection(COLLECTIONS.scopeAssignments).doc(scopeGrantDocId(authUser.uid, grantInput)).set(grant);
    }
  }
}

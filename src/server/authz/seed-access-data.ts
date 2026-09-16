// Seeds the four access-control collections (users, accessGrants,
// scopeAssignments, sensitiveAccessGrants) for the five deterministic
// local test identities created in Step 4A. Idempotent - safe to re-run.
// Emulator-only, same guard pattern as seed-users.ts.
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { getServerEnv, isUsingEmulators } from "@/lib/env/server";
import type { ActionId } from "./actions";
import type { FeatureId } from "./features";
import { FEATURES } from "./features";
import { COLLECTIONS, getUserDoc } from "./firestore";
import type { Role } from "./roles";
import { ROLES } from "./roles";
import { scopeGrantDocId } from "./scope";
import type { AccessGrantDoc, ScopeGrant, ScopeGrantInput, SensitiveAccessGrantDoc, UserDoc } from "./types";
import { generateUserRef } from "./user-ref";

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
      FEATURES.map((feature) => [
        feature,
        featureGrant(true, {
          create: true,
          edit: true,
          approve: true,
          export: true,
          manage: true,
          manage_users: true,
          manage_scope: true,
          manage_sensitive: true,
          view_audit: true,
        }),
      ]),
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

    // userRef is meant to be assigned once and never rotated (see
    // user-ref.ts) - reuse it across re-seeds if this identity already
    // has one, rather than generating a fresh opaque handle every run.
    const existing = await getUserDoc(authUser.uid);
    const userRef = existing?.userRef ?? generateUserRef();

    const userDoc: UserDoc = {
      uid: authUser.uid,
      email: identity.email,
      role: identity.role,
      active: true,
      displayName: identity.displayName,
      userRef,
      // Re-seeding resets to a known baseline version, matching how every
      // other field here is a full overwrite rather than a merge.
      version: 1,
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

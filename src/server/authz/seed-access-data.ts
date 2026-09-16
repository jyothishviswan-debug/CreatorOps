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
import type { AccessGrantDoc, ScopeAssignmentDoc, SensitiveAccessGrantDoc, UserDoc } from "./types";

type TestIdentity = {
  email: string;
  role: Role;
  displayName: string;
  regions: string[];
};

// The same five emails seeded into the Auth emulator by seedEmulatorTestUsers
// (src/server/auth/seed-users.ts) - kept in sync deliberately, checked by
// seedAccessControlData itself (throws if an expected user is missing).
export const TEST_IDENTITIES: TestIdentity[] = [
  { email: "viewer@creatorops.com", role: "viewer", displayName: "Viewer (Test)", regions: ["Kerala"] },
  { email: "analyst@creatorops.com", role: "analyst", displayName: "Analyst (Test)", regions: ["Kerala", "Tamil Nadu"] },
  {
    email: "manager@creatorops.com",
    role: "partnership_manager",
    displayName: "Manager (Test)",
    regions: ["Kerala", "Maharashtra"],
  },
  {
    email: "head@creatorops.com",
    role: "partnership_head",
    displayName: "Head (Test)",
    regions: ["Kerala", "Maharashtra", "Tamil Nadu", "Karnataka"],
  },
  {
    email: "admin@creatorops.com",
    role: "super_admin",
    displayName: "Admin (Test)",
    regions: ["Kerala", "Maharashtra", "Tamil Nadu", "Karnataka"],
  },
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

    const scopeDoc: ScopeAssignmentDoc = { uid: authUser.uid, regions: identity.regions };
    await db.collection(COLLECTIONS.scopeAssignments).doc(authUser.uid).set(scopeDoc);
  }
}

// Seeds the five access-control collections (users, accessGrants,
// scopeAssignments, sensitiveAccessGrants, userAccessOverrides) for the
// five deterministic local test identities created in Step 4A. Idempotent
// - safe to re-run. Emulator-only, same guard pattern as seed-users.ts.
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { getServerEnv, isUsingEmulators } from "@/lib/env/server";
import type { ActionId } from "./actions";
import type { FeatureId } from "./features";
import { FEATURES } from "./features";
import { COLLECTIONS, getUserDoc } from "./firestore";
import { MODULE_ACTIONS } from "./module-actions";
import type { Role } from "./roles";
import { ROLES } from "./roles";
import { scopeGrantDocId } from "./scope";
import type { AccessGrantDoc, ScopeGrant, ScopeGrantInput, SensitiveAccessGrantDoc, UserAccessOverrideDoc, UserDoc } from "./types";
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
      ...featuresOf(["dashboard", "partners", "vendors", "campaigns", "assignments", "content", "analytics", "partner_reviews", "operations", "reports"]),
      // Non-monotonic on purpose - matches the module-specific action
      // catalog (module-actions.ts): can manage day-to-day finance
      // records but cannot approve payables, unlike Partnership Head.
      finance: featureGrant(true, { manage_agreements: true, manage_payables: true, approve_payables: false, manage_invoices: true, record_payments: true }),
      // Step 6A: both relationship-owner roles get the full Discovery
      // evidence-recording surface (manage_kyc included - see
      // SENSITIVE_GRANTS below for why that alone isn't enough to read
      // KYC values for Partnership Manager).
      discovery: featureGrant(true, {
        create: true,
        edit: true,
        manage_research: true,
        manage_review: true,
        manage_outreach: true,
        manage_commercial: true,
        manage_asset_decision: true,
        manage_manager_assignment: true,
        manage_kyc: true,
        transition_lifecycle: true,
        convert_lead: true,
      }),
      // Step 7A: day-to-day Partner/account operation, but NOT governance
      // (blacklist/archive/restore) - Partnership Head only, same
      // non-monotonic shape as Finance's approve_payables. Has the
      // manage_partner_restricted_identity ACTION (can operate the
      // workflow) but not the "payment_details" sensitive CATEGORY (see
      // SENSITIVE_GRANTS) - proves the two gates are independent, same as
      // Discovery's manage_kyc/discovery_kyc pattern above.
      partners: featureGrant(true, {
        create: true,
        edit: true,
        manage_partner_accounts: true,
        manage_partner_ownership: true,
        manage_partner_restricted_identity: true,
        manage_partner_governance: false,
      }),
    },
  },
  partnership_head: {
    features: {
      ...featuresOf(["dashboard", "partners", "vendors", "campaigns", "assignments", "content", "analytics", "partner_reviews", "operations", "reports"]),
      finance: featureGrant(true, { manage_agreements: true, manage_payables: true, approve_payables: true, manage_invoices: true, record_payments: true }),
      discovery: featureGrant(true, {
        create: true,
        edit: true,
        manage_research: true,
        manage_review: true,
        manage_outreach: true,
        manage_commercial: true,
        manage_asset_decision: true,
        manage_manager_assignment: true,
        manage_kyc: true,
        transition_lifecycle: true,
        convert_lead: true,
      }),
      // Step 7A: the only role (besides Super Admin) trusted with
      // governance (blacklist/archive/restore), matching Finance's
      // approve_payables being Head-only.
      partners: featureGrant(true, {
        create: true,
        edit: true,
        manage_partner_accounts: true,
        manage_partner_ownership: true,
        manage_partner_restricted_identity: true,
        manage_partner_governance: true,
      }),
    },
  },
  super_admin: {
    features: Object.fromEntries(
      FEATURES.map((feature) => [
        feature,
        featureGrant(
          true,
          Object.fromEntries(MODULE_ACTIONS[feature].map((action) => [action.id, true])),
        ),
      ]),
    ) as AccessGrantDoc["features"],
  },
};

function featuresOf(features: FeatureId[]): AccessGrantDoc["features"] {
  return Object.fromEntries(features.map((feature) => [feature, featureGrant(true)])) as AccessGrantDoc["features"];
}

// Sensitive Access is a distinct gate from Feature Access: Partnership
// Manager can view Finance but is not granted the "finance_amounts"
// sensitive category, unlike Partnership Head. Step 6A: the same
// non-monotonic shape for Discovery KYC - Partnership Manager has the
// manage_kyc ACTION (can operate the KYC workflow) but not the
// "discovery_kyc" sensitive CATEGORY (cannot see the actual restricted
// values), proving the two gates are independent.
const SENSITIVE_GRANTS: Record<Role, string[]> = {
  viewer: [],
  analyst: [],
  partnership_manager: [],
  // Step 7A: "payment_details" gates Partner restricted financial
  // identity, same non-monotonic shape as finance_amounts/discovery_kyc
  // - Partnership Manager has the manage_partner_restricted_identity
  // ACTION (above) but not this category, so it can operate the workflow
  // without seeing the actual restricted values.
  partnership_head: ["finance_amounts", "discovery_kyc", "payment_details"],
  super_admin: ["finance_amounts", "discovery_kyc", "payment_details"],
};

// Explicit, per-role scope grants (Step 4C's canonical multi-dimensional
// model - see types.ts). Deliberately exercises every one of the 9 grant
// types across the five identities, and deliberately does NOT give every
// role the same shape of scope: Super Admin's GLOBAL grant is its own
// explicit document, not something inferred from the role name, and
// nothing here compares roles to each other to decide breadth.
// REGION grants below are deliberately given at BOTH granularities that
// exist in the app today: the original state-level names (what every
// seeded Discovery Lead still uses) and the newer zone-level names
// DISCOVERY_REGIONS now offers on the Create/Edit Lead form (Kerala/
// Tamil Nadu/Karnataka -> South, Maharashtra -> West). This is additive,
// not a replacement - every existing state-level grant stays exactly as
// it was, so no seeded Lead's visibility changes. Without the zone-level
// addition, a Lead created through the new dropdown (region: "South")
// would be invisible to every seeded identity, including whoever just
// created it - region grants are exact-string matches, not a hierarchy,
// so "South" and "Kerala" are two unrelated values to this system until
// both are explicitly granted.
const SCOPE_GRANTS: Record<Role, ScopeGrantInput[]> = {
  viewer: [
    { type: "SELF" },
    { type: "REGION", region: "Kerala" },
    { type: "REGION", region: "South" },
    // Step 6A: proves EXPLICIT_RECORD scope works for Leads specifically,
    // independent of region/team - this one out-of-region (Karnataka)
    // seeded Lead is reachable for Viewer ONLY through this grant (see
    // discovery/seed-discovery-data.ts's "seed-lead-duplicate").
    { type: "EXPLICIT_RECORD", resourceType: "lead", resourceId: "seed-lead-duplicate" },
  ],
  analyst: [
    { type: "REGION", region: "Kerala" },
    { type: "REGION", region: "Tamil Nadu" },
    { type: "REGION", region: "South" },
    { type: "ANALYTICS_DATASET", datasetId: "cross-platform-reach" },
    { type: "ANALYTICS_ACCOUNT", accountId: "instagram-primary" },
  ],
  partnership_manager: [
    { type: "REGION", region: "Kerala" },
    { type: "REGION", region: "Maharashtra" },
    { type: "REGION", region: "South" },
    { type: "REGION", region: "West" },
    { type: "TEAM", teamId: "kerala-programmes" },
    { type: "PARTNER", partnerId: "creator-house" },
  ],
  partnership_head: [
    { type: "REGION", region: "Kerala" },
    { type: "REGION", region: "Maharashtra" },
    { type: "REGION", region: "Tamil Nadu" },
    { type: "REGION", region: "Karnataka" },
    { type: "REGION", region: "South" },
    { type: "REGION", region: "West" },
    { type: "TEAM", teamId: "kerala-programmes" },
    { type: "TEAM", teamId: "maharashtra-programmes" },
    { type: "CAMPAIGN", campaignId: "civic-voices" },
    { type: "EXPLICIT_RECORD", resourceType: "content", resourceId: "community-story-reel-01" },
  ],
  super_admin: [{ type: "GLOBAL" }],
};

// Step 5B.1: a small, deliberately sparse set of per-user overrides,
// keyed by seeded email - proving the system is non-monotonic without
// overriding every identity (most permissions stay inherited from role
// baseline). Exercises all three representative cases the spec calls
// for: a role-denied module explicitly allowed, a role-allowed module
// explicitly denied, and one action-level override independent of the
// module's own baseline.
// Deliberately chosen to NOT touch Finance, Import Center, Partners, or
// Administration - Step 4B's authorization.spec.ts/emulator tests already
// use those four as the load-bearing proof that each role's grant is
// explicit and never inferred from another role. Reusing them here would
// make an override test collide with (and silently reinterpret) an
// unrelated regression test instead of adding new, independent coverage.
const USER_OVERRIDES: Partial<Record<string, Partial<Record<FeatureId, { view?: boolean; actions?: Partial<Record<ActionId, boolean>> }>>>> = {
  // Viewer's role baseline has no Operations entry at all (denied) -
  // explicitly allow just this one identity to view it.
  "viewer@creatorops.com": { operations: { view: true } },
  // Analyst's role baseline includes Export Center - explicitly deny it
  // for this one identity.
  "analyst@creatorops.com": { exports: { view: false } },
  // Partnership Manager's role baseline denies approve_payables -
  // explicitly allow just that action for this identity, leaving the
  // module's own view/other actions untouched.
  "manager@creatorops.com": { finance: { actions: { approve_payables: true } } },
};

function buildFeatureOverride(entry: { view?: boolean; actions?: Partial<Record<ActionId, boolean>> }): UserAccessOverrideDoc["features"][FeatureId] {
  return {
    // Firestore rejects an explicitly-`undefined` field value outright -
    // the key must be entirely absent when there's no view override,
    // never present with value undefined.
    ...(entry.view !== undefined ? { view: entry.view } : {}),
    actions: entry.actions ?? {},
  };
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

    const overrideEntries = USER_OVERRIDES[identity.email];
    const overrideDocRef = db.collection(COLLECTIONS.userAccessOverrides).doc(authUser.uid);
    if (overrideEntries) {
      const features: UserAccessOverrideDoc["features"] = {};
      for (const [feature, entry] of Object.entries(overrideEntries) as [FeatureId, { view?: boolean; actions?: Partial<Record<ActionId, boolean>> }][]) {
        features[feature] = buildFeatureOverride(entry);
      }
      const overrideDoc: UserAccessOverrideDoc = { uid: authUser.uid, features, version: 1 };
      await overrideDocRef.set(overrideDoc);
    } else {
      // Most identities have none - re-seeding must not leave a stale
      // override behind for an identity this run no longer lists.
      await overrideDocRef.delete();
    }
  }
}

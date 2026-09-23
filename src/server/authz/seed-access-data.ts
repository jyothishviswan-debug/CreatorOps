// Seeds the five access-control collections (users, accessGrants,
// scopeAssignments, sensitiveAccessGrants, userAccessOverrides) for the
// five deterministic local test identities created in Step 4A. Idempotent
// - safe to re-run. Emulator-only, same guard pattern as seed-users.ts.
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { getServerEnv, isUsingEmulators } from "@/lib/env/server";
import { REGION_ZONES } from "@/server/discovery/types";
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
  // Step 10A.1: Assignments is an operational module for Manager/Head/
  // Super Admin only - Viewer and Analyst never held real access to it
  // (the earlier "assignments" entry in their featuresOf(...) lists was
  // stale UI-skeleton-era scaffold, predating Step 10A's real service and
  // never re-examined against the actual accepted access model until
  // now). Removed here, not merely left as view:true with no actions -
  // the proxy-level Feature Access gate (src/proxy.ts) and every
  // Assignment service call both key off this exact grant, so removing
  // it is what actually denies the workspace/detail/read API and hides
  // the nav item, all from this one place.
  // Step 11A: "content" removed from Viewer's and Analyst's own
  // featuresOf(...) lists below - the earlier entry was stale UI-
  // skeleton-era scaffold (same as the pre-10A.1 "assignments" entry's
  // own history - see that grant's comment), predating Content's real
  // trusted service and never re-examined against the actual accepted
  // access model until now. Content is Manager/Head/Super Admin only,
  // same operational-module shape as Assignments.
  viewer: {
    features: featuresOf(["dashboard", "discovery", "partners", "vendors", "campaigns", "analytics", "partner_reviews", "reports"]),
  },
  analyst: {
    features: {
      ...featuresOf(["dashboard", "discovery", "partners", "vendors", "campaigns", "analytics", "partner_reviews", "reports", "imports", "exports"]),
      // Step 12A: Analyst holds BOTH Analytics action permissions
      // (day-to-day read via Explore, AND import/correction operations)
      // - the ground truth's own "Analyst - Analytics read + approved
      // Analytics import/correction operations" role description. Also
      // the only non-Head/non-Super-Admin role trusted to actually
      // execute an import through the Import Center for the Analytics
      // target (manage_imports), matching the module's own already-
      // established Analyst-yes shape (Analyst already held Import/
      // Export Center view access before this step; this adds the real
      // action behind it now that a real target exists).
      analytics: featureGrant(true, { explore: true, manage_analytics_data: true }),
      imports: featureGrant(true, { manage_imports: true }),
    },
  },
  partnership_manager: {
    features: {
      ...featuresOf(["dashboard", "partners", "vendors", "assignments", "analytics", "partner_reviews", "operations", "reports"]),
      // Non-monotonic on purpose - matches the module-specific action
      // catalog (module-actions.ts): can manage day-to-day finance
      // records but cannot approve payables, unlike Partnership Head.
      // Step 15A: the same day-to-day-but-not-governance split extends to
      // the two new Payable actions - Manager may prepare and revise a
      // DRAFT Payable but may neither change its money by hand
      // (adjust_payables) nor void it (void_payables). Manager also does
      // not hold the "finance_amounts" sensitive CATEGORY (see
      // SENSITIVE_GRANTS), so it operates the workflow without seeing the
      // exact amounts - the same action-vs-category independence Discovery's
      // manage_kyc/discovery_kyc pair established.
      finance: featureGrant(true, { manage_agreements: true, manage_payables: true, approve_payables: false, adjust_payables: false, void_payables: false, manage_invoices: true, record_payments: true }),
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
      // Step 8A: same day-to-day-but-not-governance split as Partners
      // above - Partnership Manager can create/edit Vendors, manage
      // their Partner relationships and operate the restricted-identity
      // workflow, but archive/restore (governance) is Head-only. Has the
      // manage_vendor_restricted_identity ACTION but not the
      // "vendor_payment_details" sensitive CATEGORY (see
      // SENSITIVE_GRANTS) - same independence proof as Partners'.
      vendors: featureGrant(true, {
        create: true,
        edit: true,
        manage_vendor_ownership: true,
        manage_vendor_partner_relationships: true,
        transition_vendor_lifecycle: true,
        manage_vendor_restricted_identity: true,
        archive_vendor: false,
        restore_vendor: false,
      }),
      // Step 9A: same day-to-day-but-not-governance split as Partners'/
      // Vendors' own - Partnership Manager can plan and run day-to-day
      // Campaign work (create/edit/own/transition/resources) but cancel
      // and archive (governance-weight, reasoned, one-way) are Head-only.
      campaigns: featureGrant(true, {
        create: true,
        edit: true,
        manage_campaign_ownership: true,
        transition_campaign_lifecycle: true,
        manage_campaign_resources: true,
        cancel_campaign: false,
        archive_campaign: false,
      }),
      // Step 10A: full operational Assignment access - this compact
      // execution lifecycle has no separate "approval" step the way
      // Finance's approve_payables does, so unlike the day-to-day-but-
      // not-governance splits above, Manager and Head get the identical
      // action set here (see partnership_head's own assignments grant
      // below). `assignments` itself was already view:true for every
      // role before Step 10A (see featuresOf(...) above) - this only adds
      // the operational actions.
      assignments: featureGrant(true, {
        create: true,
        edit: true,
        transition_assignment_lifecycle: true,
        cancel_assignment: true,
        manage_assignment_external_submission: true,
      }),
      // Step 11B (explicit user correction to Step 11A's own initial
      // default): Manager now holds identical Content grants to Head,
      // including review_content. review_content remains a genuinely
      // separate, independently-gated action permission - it is never
      // collapsed into the generic Content actions above, and nothing
      // here implies a role could act on Content without this explicit
      // grant. What changed is WHO holds it, not whether it is its own
      // gate. The load-bearing proof that it stays a distinct permission
      // is now scope-based (a Manager is still denied review_content on a
      // Content record outside their own scope grants) rather than a
      // same-scope role denial - see content.emulator.test.ts.
      content: featureGrant(true, {
        create: true,
        review_content: true,
        cancel_content: true,
      }),
      // Step 12A: non-monotonic on purpose, same day-to-day-but-not-
      // governance shape as Finance's approve_payables/Partners'/
      // Vendors'/Campaigns' own Manager-vs-Head splits above - Manager
      // can EXPLORE Analytics data day-to-day but cannot import or
      // correct it by default (manage_analytics_data: false); a real
      // grant would have to be added explicitly (matching the
      // established non-monotonic pattern this whole file already
      // uses). Deliberately NOT extended to the "imports" feature itself
      // - Import Center access is, and stays, Analyst/Super-Admin-only
      // (see seed-access-data.emulator.test.ts's own pre-existing "no
      // role-rank fallback" proof: Partnership Head - otherwise broader
      // than Analyst - does NOT have Import Center access, and nothing
      // here reintroduces a rank-based exception for Manager either).
      analytics: featureGrant(true, { explore: true, manage_analytics_data: false }),
      // Step 13A: Manager may generate/refresh evidence and submit a
      // review for review (create + submit_partner_review), but NOT
      // finalize - finalize_approve is Head/Super Admin only, the same
      // day-to-day-but-not-governance split as Finance's approve_payables
      // and Partners'/Vendors'/Campaigns' own governance actions.
      partner_reviews: featureGrant(true, { create: true, submit_partner_review: true }),
    },
  },
  partnership_head: {
    features: {
      ...featuresOf(["dashboard", "partners", "vendors", "assignments", "analytics", "partner_reviews", "operations", "reports"]),
      // Step 14A: the only role (besides Super Admin) trusted with the
      // Agreement lifecycle (activate/revise/suspend/resume/end) - Manager
      // holds manage_agreements only (prepare/decide/confirm).
      // Step 15A: also the only role (besides Super Admin) trusted with the two governance-weight
      // Payable actions - the manual financial adjustment and the void - matching approve_payables'
      // own head-only shape.
      finance: featureGrant(true, { manage_agreements: true, activate_agreements: true, manage_payables: true, approve_payables: true, adjust_payables: true, void_payables: true, manage_invoices: true, record_payments: true }),
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
      // Step 8A: the only role (besides Super Admin) trusted with Vendor
      // governance (archive/restore), matching Partners' own head-only
      // governance split above.
      vendors: featureGrant(true, {
        create: true,
        edit: true,
        manage_vendor_ownership: true,
        manage_vendor_partner_relationships: true,
        transition_vendor_lifecycle: true,
        manage_vendor_restricted_identity: true,
        archive_vendor: true,
        restore_vendor: true,
      }),
      // Step 9A: the only role (besides Super Admin) trusted with
      // Campaign governance (cancel/archive), matching Partners'/
      // Vendors' own head-only governance split above.
      campaigns: featureGrant(true, {
        create: true,
        edit: true,
        manage_campaign_ownership: true,
        transition_campaign_lifecycle: true,
        manage_campaign_resources: true,
        cancel_campaign: true,
        archive_campaign: true,
      }),
      // Step 10A: identical action set to partnership_manager's own
      // assignments grant above - see that grant's comment for why.
      assignments: featureGrant(true, {
        create: true,
        edit: true,
        transition_assignment_lifecycle: true,
        cancel_assignment: true,
        manage_assignment_external_submission: true,
      }),
      // Step 11A: the only role (besides Super Admin) trusted with
      // review_content - matching Finance's approve_payables/Partners'/
      // Vendors'/Campaigns' own head-only governance split above.
      content: featureGrant(true, {
        create: true,
        review_content: true,
        cancel_content: true,
      }),
      // Step 12A: the Head-vs-Manager governance split's "yes" side -
      // Partnership Head holds BOTH explore and manage_analytics_data,
      // matching the Manager-vs-Head "day-to-day-but-not-governance"
      // split precedent used everywhere else in this file (Finance's
      // approve_payables, Partners'/Vendors'/Campaigns' own governance
      // actions). Deliberately NOT extended to the "imports" feature -
      // see partnership_manager's own analytics comment above for why
      // Import Center access stays Analyst/Super-Admin-only rather than
      // being widened here (a genuine conflict was found with this
      // file's own pre-existing "no role-rank fallback" regression proof
      // in seed-access-data.emulator.test.ts - resolved by keeping that
      // established invariant rather than the task's own softer, "your
      // call on the exact mechanism" suggestion to mirror the split onto
      // Import Center itself; see the Step 12A completion report for the
      // full reasoning).
      analytics: featureGrant(true, { explore: true, manage_analytics_data: true }),
      // Step 13A: the only role (besides Super Admin) trusted to
      // finalize a review, on top of everything Manager holds.
      partner_reviews: featureGrant(true, { create: true, submit_partner_review: true, finalize_approve: true }),
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
  // Step 8A: "vendor_payment_details" is its own category, deliberately
  // separate from "payment_details" (Partners') - same non-monotonic
  // independence proof, applied to Vendor restricted identity.
  // Step 14A: "finance_contracts" (raw contract snippets/locators, restricted
  // extraction) is Head + Super Admin only; Manager holds manage_agreements
  // (the ACTION) without it, same action-vs-category independence.
  partnership_head: ["finance_amounts", "discovery_kyc", "payment_details", "vendor_payment_details", "finance_contracts"],
  super_admin: ["finance_amounts", "discovery_kyc", "payment_details", "vendor_payment_details", "finance_contracts"],
};

// Every South/West Zone state (per REGION_ZONES, the canonical
// Annexure-1 taxonomy) EXCEPT the ones already granted individually
// below - used to expand what used to be a single literal "South"/"West"
// zone-label grant into the real per-state grants it was always meant to
// represent (a genuine access-widening change for Manager/Head,
// explicitly confirmed - see the region-taxonomy overhaul's own note).
// `Set`-deduped so a state already listed by name for that role is never
// repeated as a second, redundant grant document.
function zoneRegionsExcluding(zone: keyof typeof REGION_ZONES, already: string[]): ScopeGrantInput[] {
  const alreadySet = new Set(already);
  return REGION_ZONES[zone].filter((state) => !alreadySet.has(state)).map((state) => ({ type: "REGION", region: state }) as const);
}

// Explicit, per-role scope grants (Step 4C's canonical multi-dimensional
// model - see types.ts). Deliberately exercises every one of the 9 grant
// types across the five identities, and deliberately does NOT give every
// role the same shape of scope: Super Admin's GLOBAL grant is its own
// explicit document, not something inferred from the role name, and
// nothing here compares roles to each other to decide breadth.
const SCOPE_GRANTS: Record<Role, ScopeGrantInput[]> = {
  viewer: [
    { type: "SELF" },
    { type: "REGION", region: "Kerala" },
    // Karnataka deliberately excluded from this expansion (unlike every
    // other South Zone state) - Viewer must stay without real Karnataka
    // access, since several regression tests (Vendors'/Partners' own
    // "cross-scope user is denied" fixtures - seed-vendor-agency,
    // creator-house) specifically prove Viewer is denied a Karnataka-only
    // record while Head, who holds Karnataka explicitly, is allowed.
    ...zoneRegionsExcluding("South Zone", ["Kerala", "Karnataka"]),
    // Step 6A: proves EXPLICIT_RECORD scope works for Leads specifically,
    // independent of region/team - this one out-of-region (Uttar Pradesh)
    // seeded Lead is reachable for Viewer ONLY through this grant (see
    // discovery/seed-discovery-data.ts's "seed-lead-duplicate").
    { type: "EXPLICIT_RECORD", resourceType: "lead", resourceId: "seed-lead-duplicate" },
  ],
  analyst: [
    { type: "REGION", region: "Kerala" },
    { type: "REGION", region: "Tamil Nadu" },
    ...zoneRegionsExcluding("South Zone", ["Kerala", "Tamil Nadu"]),
    { type: "ANALYTICS_DATASET", datasetId: "cross-platform-reach" },
    { type: "ANALYTICS_ACCOUNT", accountId: "instagram-primary" },
  ],
  partnership_manager: [
    { type: "REGION", region: "Kerala" },
    { type: "REGION", region: "Maharashtra" },
    // Karnataka AND Tamil Nadu deliberately excluded from this expansion
    // (unlike every other South Zone state) - Partnership Head holds
    // both explicitly (below) and several regression tests depend on
    // that exact asymmetry: Manager denied / Head allowed on a
    // Karnataka-only record (seed-vendor-agency, creator-house's linked
    // Vendor) and on a Tamil-Nadu-only record via a non-region grant
    // (civic-voices' CAMPAIGN grant; seed-partner-inactive's owner-only
    // access). Widening Manager's own South Zone coverage to include
    // these two specific states would silently erase that asymmetry
    // without any test failing loudly - so it's carved out explicitly
    // here instead, once, with this comment as the reason.
    ...zoneRegionsExcluding("South Zone", ["Kerala", "Karnataka", "Tamil Nadu"]),
    ...zoneRegionsExcluding("West Zone", ["Maharashtra"]),
    { type: "TEAM", teamId: "kerala-programmes" },
    { type: "PARTNER", partnerId: "creator-house" },
  ],
  partnership_head: [
    { type: "REGION", region: "Kerala" },
    { type: "REGION", region: "Maharashtra" },
    { type: "REGION", region: "Tamil Nadu" },
    { type: "REGION", region: "Karnataka" },
    ...zoneRegionsExcluding("South Zone", ["Kerala", "Tamil Nadu", "Karnataka"]),
    ...zoneRegionsExcluding("West Zone", ["Maharashtra"]),
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

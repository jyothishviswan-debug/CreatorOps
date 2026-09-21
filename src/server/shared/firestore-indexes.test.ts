import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { planAssignmentListQuery } from "@/server/assignments/firestore";
import type { ScopeGrant } from "@/server/authz/types";
import { planCampaignListQuery } from "@/server/campaigns/firestore";
import { planAgreementHeadListQuery } from "@/server/finance-agreements/firestore";
import { planPartnerListQuery } from "@/server/partners/firestore";
import { planPartnerReviewListQuery } from "@/server/partner-reviews/firestore";
import { planVendorListQuery } from "@/server/vendors/firestore";
import type { FirestoreFieldFilter, FirestoreListBranchPlan } from "./scoped-list";

// Step 8A.1: certifies that firestore.indexes.json actually declares the
// exact composite index every active Partner/Vendor/VendorPartnerLink/
// PartnerAccount query shape needs (derived from the real query
// construction in partners/firestore.ts and vendors/firestore.ts, never
// from a comment) - not merely that some string mentioning the
// collection name is present somewhere in the file. A local Firestore
// emulator never enforces these, so nothing else in the test suite would
// catch a missing or wrong composite index before a real deployment did.
type IndexField = { fieldPath: string; order?: "ASCENDING" | "DESCENDING"; arrayConfig?: "CONTAINS" };
type FirestoreIndex = { collectionGroup: string; queryScope: string; fields: IndexField[] };

const indexesFile: { indexes: FirestoreIndex[] } = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../firestore.indexes.json"), "utf8"));

function hasIndex(collectionGroup: string, fields: IndexField[]): boolean {
  return indexesFile.indexes.some(
    (index) =>
      index.collectionGroup === collectionGroup &&
      index.queryScope === "COLLECTION" &&
      index.fields.length === fields.length &&
      index.fields.every((field, i) => field.fieldPath === fields[i]!.fieldPath && field.order === fields[i]!.order && field.arrayConfig === fields[i]!.arrayConfig),
  );
}

const createdAtDesc: IndexField = { fieldPath: "createdAt", order: "DESCENDING" };
const displayNameLowerAsc: IndexField = { fieldPath: "displayNameLower", order: "ASCENDING" };

describe("firestore.indexes.json - Partners", () => {
  // listPartnerDocs's {SELF, REGION, TEAM} scope branches x {createdAt-desc order} -
  // see src/server/partners/firestore.ts's listPartnerDocs.
  it("has the SELF/REGION/TEAM scope-branch x createdAt-desc grid", () => {
    expect(hasIndex("partners", [{ fieldPath: "ownerUid", order: "ASCENDING" }, createdAtDesc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "regionIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "teamIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
  });

  // Same grid, but with a `status` filter also applied.
  it("has the status + scope-branch x createdAt-desc grid", () => {
    expect(hasIndex("partners", [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "ownerUid", order: "ASCENDING" }, createdAtDesc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "regionIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "teamIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
  });

  // Standalone secondary filters (tier / targetAudience / pendingPartnerAccountSetup), each + createdAt-desc.
  // targetAudience is now an array field (multi-select) - array-contains, not equality.
  it("has a standalone createdAt-desc index for tier, targetAudience, and pendingPartnerAccountSetup", () => {
    expect(hasIndex("partners", [{ fieldPath: "tier", order: "ASCENDING" }, createdAtDesc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "targetAudience", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "pendingPartnerAccountSetup", order: "ASCENDING" }, createdAtDesc])).toBe(true);
  });

  // The displayNamePrefix search order mode, same scope-branch grid.
  it("has the SELF/REGION/TEAM scope-branch x displayNameLower-asc grid (search order)", () => {
    expect(hasIndex("partners", [{ fieldPath: "ownerUid", order: "ASCENDING" }, displayNameLowerAsc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "regionIds", arrayConfig: "CONTAINS" }, displayNameLowerAsc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "teamIds", arrayConfig: "CONTAINS" }, displayNameLowerAsc])).toBe(true);
  });
});

describe("firestore.indexes.json - Vendors", () => {
  // listVendorDocs's {SELF, REGION, TEAM} scope branches x {createdAt-desc order} -
  // see src/server/vendors/firestore.ts's listVendorDocs.
  it("has the SELF/REGION/TEAM scope-branch x createdAt-desc grid", () => {
    expect(hasIndex("vendors", [{ fieldPath: "ownerUid", order: "ASCENDING" }, createdAtDesc])).toBe(true);
    expect(hasIndex("vendors", [{ fieldPath: "regionIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
    expect(hasIndex("vendors", [{ fieldPath: "teamIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
  });

  it("has the status + scope-branch x createdAt-desc grid", () => {
    expect(hasIndex("vendors", [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "ownerUid", order: "ASCENDING" }, createdAtDesc])).toBe(true);
    expect(hasIndex("vendors", [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "regionIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
    expect(hasIndex("vendors", [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "teamIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
  });

  it("has a standalone createdAt-desc index for vendorType", () => {
    expect(hasIndex("vendors", [{ fieldPath: "vendorType", order: "ASCENDING" }, createdAtDesc])).toBe(true);
  });

  it("has the SELF/REGION/TEAM scope-branch x displayNameLower-asc grid (search order)", () => {
    expect(hasIndex("vendors", [{ fieldPath: "ownerUid", order: "ASCENDING" }, displayNameLowerAsc])).toBe(true);
    expect(hasIndex("vendors", [{ fieldPath: "regionIds", arrayConfig: "CONTAINS" }, displayNameLowerAsc])).toBe(true);
    expect(hasIndex("vendors", [{ fieldPath: "teamIds", arrayConfig: "CONTAINS" }, displayNameLowerAsc])).toBe(true);
  });
});

describe("firestore.indexes.json - Campaigns", () => {
  // listCampaignDocs's {SELF, REGION, TEAM} scope branches x
  // {createdAt-desc order} - see src/server/campaigns/firestore.ts's
  // listCampaignDocs. Step 9A.1: `platforms` is a normalized string
  // array (never a closed enum) but the INDEX SHAPE is unaffected - it
  // was already `arrayConfig: CONTAINS` on a plain string field before
  // and after that correction.
  it("has the SELF/REGION/TEAM scope-branch x createdAt-desc grid", () => {
    expect(hasIndex("campaigns", [{ fieldPath: "ownerUid", order: "ASCENDING" }, createdAtDesc])).toBe(true);
    expect(hasIndex("campaigns", [{ fieldPath: "regionIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
    expect(hasIndex("campaigns", [{ fieldPath: "teamIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
  });

  it("has the status + scope-branch x createdAt-desc grid", () => {
    expect(hasIndex("campaigns", [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "ownerUid", order: "ASCENDING" }, createdAtDesc])).toBe(true);
    expect(hasIndex("campaigns", [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "regionIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
    expect(hasIndex("campaigns", [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "teamIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
    expect(hasIndex("campaigns", [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "platforms", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
  });

  it("has a standalone createdAt-desc index for platforms (the business filter dimension, distinct from the scope branches)", () => {
    expect(hasIndex("campaigns", [{ fieldPath: "platforms", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
  });

  it("has the SELF/REGION/TEAM/platforms x nameLower-asc grid (search order)", () => {
    expect(hasIndex("campaigns", [{ fieldPath: "ownerUid", order: "ASCENDING" }, { fieldPath: "nameLower", order: "ASCENDING" }])).toBe(true);
    expect(hasIndex("campaigns", [{ fieldPath: "regionIds", arrayConfig: "CONTAINS" }, { fieldPath: "nameLower", order: "ASCENDING" }])).toBe(true);
    expect(hasIndex("campaigns", [{ fieldPath: "teamIds", arrayConfig: "CONTAINS" }, { fieldPath: "nameLower", order: "ASCENDING" }])).toBe(true);
    expect(hasIndex("campaigns", [{ fieldPath: "platforms", arrayConfig: "CONTAINS" }, { fieldPath: "nameLower", order: "ASCENDING" }])).toBe(true);
  });
});

describe("firestore.indexes.json - VendorPartnerLinks and PartnerAccounts", () => {
  // listVendorPartnerLinkDocsForVendor / ForPartner - see
  // src/server/vendors/firestore.ts. Each is a single equality filter
  // combined with an orderBy on a DIFFERENT field, which always needs a
  // dedicated composite index.
  it("has vendorRef+createdAt and partnerRef+createdAt for vendorPartnerLinks", () => {
    expect(hasIndex("vendorPartnerLinks", [{ fieldPath: "vendorRef", order: "ASCENDING" }, { fieldPath: "createdAt", order: "ASCENDING" }])).toBe(true);
    expect(hasIndex("vendorPartnerLinks", [{ fieldPath: "partnerRef", order: "ASCENDING" }, { fieldPath: "createdAt", order: "ASCENDING" }])).toBe(true);
  });

  // checkVendorDependencies's vendorRef==+status=="ACTIVE" check has no
  // orderBy - Firestore's automatic per-field indexes merge-join
  // equality-only queries, so this deliberately does NOT get a composite
  // index (removed as speculative Step 8A.1 - it was never a real query
  // requirement).
  it("does not carry a speculative vendorRef+status composite index", () => {
    expect(hasIndex("vendorPartnerLinks", [{ fieldPath: "vendorRef", order: "ASCENDING" }, { fieldPath: "status", order: "ASCENDING" }])).toBe(false);
  });

  // listPartnerAccountDocs - see src/server/partners/firestore.ts. Same
  // "equality + orderBy on a different field" shape as the
  // vendorPartnerLinks pair above.
  it("has partnerRef+createdAt for partnerAccounts", () => {
    expect(hasIndex("partnerAccounts", [{ fieldPath: "partnerRef", order: "ASCENDING" }, { fieldPath: "createdAt", order: "ASCENDING" }])).toBe(true);
  });
});

// Step 8A.2: ties the REAL query planner's output directly to
// firestore.indexes.json, rather than only asserting the index file
// contains certain shapes in isolation (as the describe blocks above
// do) - this is what section 4 of the 8A.2 correction asks for: "assert
// the query planner's declared/certified active shapes map to
// source-controlled indexes where a composite index is required." Field
// order among the leading equality/array-type filters is irrelevant to
// Firestore's own index matching (only their relative position before
// the orderBy field matters), so this compares them as a set and only
// requires the trailing orderBy field to match exactly - see
// hasIndexForBranch below.
const AUDIT = { uid: "grant-1", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "seed" };
function self(): ScopeGrant {
  return { type: "SELF", ...AUDIT };
}
function region(r: string): ScopeGrant {
  return { type: "REGION", region: r, ...AUDIT };
}
function team(t: string): ScopeGrant {
  return { type: "TEAM", teamId: t, ...AUDIT };
}

function planFieldsToIndexFields(filters: FirestoreFieldFilter[]): IndexField[] {
  return filters
    .filter((f) => f.op === "==" || f.op === "array-contains" || f.op === "array-contains-any")
    .map((f) => (f.op === "array-contains" || f.op === "array-contains-any" ? { fieldPath: f.field, arrayConfig: "CONTAINS" as const } : { fieldPath: f.field, order: "ASCENDING" as const }));
}

function indexFieldKey(f: IndexField): string {
  return `${f.fieldPath}:${f.arrayConfig ?? f.order}`;
}

// A certified composite index "serves" a branch when: its trailing
// field is exactly the branch's orderBy field/direction, and its
// leading fields are exactly the SET of the branch's own equality/
// array-type pushedFilters (order-independent, per Firestore's actual
// index-matching rules).
function hasIndexForBranch(collectionGroup: string, branch: FirestoreListBranchPlan): boolean {
  const expectedLeading = new Set(planFieldsToIndexFields(branch.pushedFilters).map(indexFieldKey));
  const expectedOrder: IndexField = { fieldPath: branch.orderField, order: branch.orderDirection === "asc" ? "ASCENDING" : "DESCENDING" };

  return indexesFile.indexes.some((index) => {
    if (index.collectionGroup !== collectionGroup || index.queryScope !== "COLLECTION") return false;
    if (index.fields.length !== expectedLeading.size + 1) return false;
    const last = index.fields[index.fields.length - 1]!;
    if (indexFieldKey(last) !== indexFieldKey(expectedOrder)) return false;
    const leading = new Set(index.fields.slice(0, -1).map(indexFieldKey));
    if (leading.size !== expectedLeading.size) return false;
    for (const key of expectedLeading) if (!leading.has(key)) return false;
    return true;
  });
}

function firestoreBranch(plan: { branches: Array<{ kind: string; name: string }> }, name: string): FirestoreListBranchPlan {
  const branch = plan.branches.find((b) => b.name === name);
  if (!branch || branch.kind !== "firestore-query") throw new Error(`Expected a firestore-query branch named "${name}"`);
  return branch as FirestoreListBranchPlan;
}

describe("firestore.indexes.json - planner-to-index mapping", () => {
  it("Partners: self/region/team branches (createdAt order) each map to a certified index", () => {
    const grants: ScopeGrant[] = [self(), region("Kerala"), team("t1")];
    const { plan } = planPartnerListQuery({ actorUid: "actor-uid", grants, hasGlobal: false });
    expect(hasIndexForBranch("partners", firestoreBranch(plan, "self"))).toBe(true);
    expect(hasIndexForBranch("partners", firestoreBranch(plan, "region"))).toBe(true);
    expect(hasIndexForBranch("partners", firestoreBranch(plan, "team"))).toBe(true);
  });

  it("Partners: the same branches with a status filter and search order also map to certified indexes", () => {
    const grants: ScopeGrant[] = [self(), region("Kerala"), team("t1")];
    const { plan: withStatus } = planPartnerListQuery({ actorUid: "actor-uid", grants, hasGlobal: false, status: "ACTIVE" });
    expect(hasIndexForBranch("partners", firestoreBranch(withStatus, "self"))).toBe(true);
    expect(hasIndexForBranch("partners", firestoreBranch(withStatus, "region"))).toBe(true);
    expect(hasIndexForBranch("partners", firestoreBranch(withStatus, "team"))).toBe(true);

    const { plan: withSearch } = planPartnerListQuery({ actorUid: "actor-uid", grants, hasGlobal: false, displayNamePrefix: "cre" });
    expect(hasIndexForBranch("partners", firestoreBranch(withSearch, "self"))).toBe(true);
    expect(hasIndexForBranch("partners", firestoreBranch(withSearch, "region"))).toBe(true);
    expect(hasIndexForBranch("partners", firestoreBranch(withSearch, "team"))).toBe(true);
  });

  it("Vendors: self/region/team branches (createdAt order, and with status) each map to a certified index", () => {
    const grants: ScopeGrant[] = [self(), region("Kerala"), team("t1")];
    const { plan } = planVendorListQuery({ actorUid: "actor-uid", grants, hasGlobal: false });
    expect(hasIndexForBranch("vendors", firestoreBranch(plan, "self"))).toBe(true);
    expect(hasIndexForBranch("vendors", firestoreBranch(plan, "region"))).toBe(true);
    expect(hasIndexForBranch("vendors", firestoreBranch(plan, "team"))).toBe(true);

    const { plan: withStatus } = planVendorListQuery({ actorUid: "actor-uid", grants, hasGlobal: false, status: "ACTIVE" });
    expect(hasIndexForBranch("vendors", firestoreBranch(withStatus, "self"))).toBe(true);
    expect(hasIndexForBranch("vendors", firestoreBranch(withStatus, "region"))).toBe(true);
    expect(hasIndexForBranch("vendors", firestoreBranch(withStatus, "team"))).toBe(true);
  });

  it("Partners/Vendors: a team branch with an active (ungranted) region filter needs only its own teamIds+createdAt index - the region condition never becomes a leading index field, since it's a postFilter, not pushed", () => {
    const grants: ScopeGrant[] = [team("t1")];
    const { plan: partnersPlan } = planPartnerListQuery({ actorUid: "actor-uid", grants, hasGlobal: false, region: "Tamil Nadu" });
    expect(hasIndexForBranch("partners", firestoreBranch(partnersPlan, "team"))).toBe(true);

    const { plan: vendorsPlan } = planVendorListQuery({ actorUid: "actor-uid", grants, hasGlobal: false, region: "Tamil Nadu" });
    expect(hasIndexForBranch("vendors", firestoreBranch(vendorsPlan, "team"))).toBe(true);
  });

  // Step 9A.1 section 5: re-certifies that the real Campaign planner's
  // output (self/region/team branches, with and without status, and with
  // the platform business filter pushed where its array-filter budget
  // allows) still maps to a source-controlled index - platform values
  // themselves are now normalized strings rather than enum members, but
  // the QUERY SHAPE (and therefore every certified index) is unchanged.
  it("Campaigns: self/region/team branches (createdAt order, and with status) each map to a certified index", () => {
    const grants: ScopeGrant[] = [self(), region("Kerala"), team("t1")];
    const { plan } = planCampaignListQuery({ actorUid: "actor-uid", grants, hasGlobal: false });
    expect(hasIndexForBranch("campaigns", firestoreBranch(plan, "self"))).toBe(true);
    expect(hasIndexForBranch("campaigns", firestoreBranch(plan, "region"))).toBe(true);
    expect(hasIndexForBranch("campaigns", firestoreBranch(plan, "team"))).toBe(true);

    const { plan: withStatus } = planCampaignListQuery({ actorUid: "actor-uid", grants, hasGlobal: false, status: "ACTIVE" });
    expect(hasIndexForBranch("campaigns", firestoreBranch(withStatus, "self"))).toBe(true);
    expect(hasIndexForBranch("campaigns", firestoreBranch(withStatus, "region"))).toBe(true);
    expect(hasIndexForBranch("campaigns", firestoreBranch(withStatus, "team"))).toBe(true);
  });

  it("Campaigns: a self branch with the platform filter pushed (no region selected) maps to the standalone platforms+createdAt index", () => {
    const { plan } = planCampaignListQuery({ actorUid: "actor-uid", grants: [self()], hasGlobal: false, platform: "youtube" });
    expect(hasIndexForBranch("campaigns", firestoreBranch(plan, "self"))).toBe(true);
  });

  it("Campaigns: a team branch with both region and platform selected needs only its own teamIds+createdAt index - both business filters are postFilters, never leading index fields", () => {
    const { plan } = planCampaignListQuery({ actorUid: "actor-uid", grants: [team("t1")], hasGlobal: false, region: "Tamil Nadu", platform: "x" });
    expect(hasIndexForBranch("campaigns", firestoreBranch(plan, "team"))).toBe(true);
  });
});

// Step 13A: the Partner Reviews head list's scope branches (SELF via
// ownerUid, REGION/TEAM via array-contains-any, PARTNER/EXPLICIT partner
// grants via `partnerUid in [...]`) and its single-Partner path, each
// ordered by periodKey desc. Derived from the REAL planner output.
describe("firestore.indexes.json - Partner Reviews", () => {
  const periodKeyDesc: IndexField = { fieldPath: "periodKey", order: "DESCENDING" };

  it("Partner Reviews: self/region/team scope branches (also with a periodKey filter) each map to a certified index", () => {
    const grants: ScopeGrant[] = [self(), region("Kerala"), team("t1")];
    for (const periodKey of [undefined, "2026-03"]) {
      const { plan } = planPartnerReviewListQuery({ actorUid: "actor-uid", grants, hasGlobal: false, periodKey });
      expect(hasIndexForBranch("partnerReviews", firestoreBranch(plan, "self"))).toBe(true);
      expect(hasIndexForBranch("partnerReviews", firestoreBranch(plan, "region"))).toBe(true);
      expect(hasIndexForBranch("partnerReviews", firestoreBranch(plan, "team"))).toBe(true);
    }
  });

  it("Partner Reviews: the PARTNER/EXPLICIT partner-grant branch (partnerUid in [...]) maps to the partnerUid + periodKey-desc index", () => {
    const partnerGrant: ScopeGrant = { type: "PARTNER", partnerId: "p-1", ...AUDIT };
    const { plan } = planPartnerReviewListQuery({ actorUid: "actor-uid", grants: [partnerGrant], hasGlobal: false });
    const branch = firestoreBranch(plan, "partnerGrant");
    expect(branch.pushedFilters.some((f) => f.field === "partnerUid" && f.op === "in")).toBe(true);
    expect(hasIndex("partnerReviews", [{ fieldPath: "partnerUid", order: "ASCENDING" }, periodKeyDesc])).toBe(true);
  });

  it("Partner Reviews: the single authorized-Partner path maps to the partnerRef + periodKey-desc index", () => {
    const { plan } = planPartnerReviewListQuery({ actorUid: "actor-uid", grants: [], hasGlobal: false, partnerRef: "partner-1", partnerAuthorized: true, periodKey: "2026-03" });
    expect(hasIndexForBranch("partnerReviews", firestoreBranch(plan, "partner"))).toBe(true);
  });

  // Step 13B: the Partner-wise history reads "a Partner's reviews up to a month" - an upper bound on the order field itself.
  it("Partner Reviews: a periodKeyMax upper bound is a range on the order field only - the existing indexes still certify every branch shape (no new index)", () => {
    const grants: ScopeGrant[] = [self(), region("Kerala"), team("t1")];
    const scoped = planPartnerReviewListQuery({ actorUid: "actor-uid", grants, hasGlobal: false, periodKeyMax: "2026-03" }).plan;
    for (const name of ["self", "region", "team"]) {
      const branch = firestoreBranch(scoped, name);
      expect(branch.pushedFilters.filter((f) => f.field === "periodKey")).toEqual([{ field: "periodKey", op: "<=", value: "2026-03" }]);
      expect(hasIndexForBranch("partnerReviews", branch)).toBe(true);
    }
    const partner = planPartnerReviewListQuery({ actorUid: "actor-uid", grants: [], hasGlobal: false, partnerRef: "partner-1", partnerAuthorized: true, periodKeyMax: "2026-03" }).plan;
    expect(hasIndexForBranch("partnerReviews", firestoreBranch(partner, "partner"))).toBe(true);
    // An exact periodKey wins over an upper bound.
    const exact = planPartnerReviewListQuery({ actorUid: "actor-uid", grants: [], hasGlobal: true, periodKey: "2026-02", periodKeyMax: "2026-03" }).plan;
    expect(firestoreBranch(exact, "main").pushedFilters).toEqual([
      { field: "periodKey", op: ">=", value: "2026-02" },
      { field: "periodKey", op: "<=", value: "2026-02" },
    ]);
  });

  it("Partner Reviews: the GLOBAL branch pushes nothing but the periodKey range on its own order field (no composite index needed)", () => {
    const { plan } = planPartnerReviewListQuery({ actorUid: "actor-uid", grants: [], hasGlobal: true, periodKey: "2026-03" });
    const branch = firestoreBranch(plan, "main");
    expect(branch.pushedFilters.every((f) => f.field === "periodKey")).toBe(true);
    expect(branch.orderField).toBe("periodKey");
  });

  it("Partner Reviews: every partnerReviews index in the file is one the planner can actually produce (no speculative extras)", () => {
    const mine = indexesFile.indexes.filter((index) => index.collectionGroup === "partnerReviews");
    expect(mine).toHaveLength(5);
    for (const index of mine) expect(index.fields[index.fields.length - 1]).toEqual(periodKeyDesc);
  });
});

// Step 13C (production query/index audit): the Partner Reviews Needs Review candidate scan (review-scan.ts's
// scanScopedAssignmentCandidates) reads Assignments through the accepted listAssignmentDocs planner - optionally
// narrowed to ONE Partner (`partnerRef`) - newest first. Those shapes are equality/array filters + an orderBy on a
// DIFFERENT field (createdAt), which Firestore production always serves from a composite index; the emulator never
// enforces that. Derived from the REAL planner output, never from a comment.
describe("firestore.indexes.json - Assignments (Partner Reviews Needs Review candidate scan)", () => {
  const grants: ScopeGrant[] = [self(), region("Kerala"), team("t1")];

  it("Assignments: the scope branches (SELF/REGION/TEAM) and the single-Partner GLOBAL read each map to a certified index", () => {
    const scoped = planAssignmentListQuery({ actorUid: "actor-uid", grants, hasGlobal: false }).plan;
    for (const name of ["self", "region", "team"]) expect(hasIndexForBranch("assignments", firestoreBranch(scoped, name))).toBe(true);

    const globalPartner = planAssignmentListQuery({ actorUid: "actor-uid", grants: [], hasGlobal: true, partnerRef: "partner-1" }).plan;
    expect(hasIndexForBranch("assignments", firestoreBranch(globalPartner, "main"))).toBe(true);
  });

  it("Assignments: the un-narrowed GLOBAL read pushes no filter and needs no composite index (a single-field createdAt order)", () => {
    const branch = firestoreBranch(planAssignmentListQuery({ actorUid: "actor-uid", grants: [], hasGlobal: true }).plan, "main");
    expect(branch.pushedFilters).toEqual([]);
    expect(branch.orderField).toBe("createdAt");
  });

  // Firestore serves `a == x AND b == y ORDER BY c` by merging the single-equality composites (a, c) and (b, c) - so
  // the SELF/REGION/TEAM branches narrowed to one Partner need no dedicated 3-field composite. This asserts the building
  // blocks; that the production backend actually merges them is "production verification pending" (see the audit).
  it("Assignments: a Partner-narrowed SELF/REGION/TEAM branch has every leading filter as a certified single-equality createdAt-desc composite (index-merge building blocks)", () => {
    const plan = planAssignmentListQuery({ actorUid: "actor-uid", grants, hasGlobal: false, partnerRef: "partner-1" }).plan;
    for (const name of ["self", "region", "team"]) {
      const branch = firestoreBranch(plan, name);
      expect(branch.pushedFilters.some((f) => f.field === "partnerRef" && f.op === "==")).toBe(true);
      for (const leading of planFieldsToIndexFields(branch.pushedFilters)) expect(hasIndex("assignments", [leading, createdAtDesc])).toBe(true);
    }
  });

  it("Assignments: every assignments index in the file is one the candidate scan can produce (no speculative extras)", () => {
    const mine = indexesFile.indexes.filter((index) => index.collectionGroup === "assignments");
    expect(mine).toHaveLength(4);
    for (const index of mine) {
      expect(index.fields).toHaveLength(2);
      expect(index.fields[1]).toEqual(createdAtDesc);
    }
  });
});

// Step 14A (production query/index audit): EVERY Firestore query introduced in src/server/finance-agreements. The emulator never
// enforces composite indexes, so this certifies by SOURCE SCAN that no Finance query needs one, and pins the inventory
// (exact-count style - a new query must be audited and added here deliberately):
//
//   #  collection                                   filters                            orderBy          limit  index need                          covered by
//   1  financeAgreements                            counterparty.partnerRef ==         (none)           51     single-field equality               automatic single-field index
//   2  financeAgreements                            counterparty.vendorRef ==          (none)           51     single-field equality               automatic single-field index
//   3  financeAgreements                            counterparty.partnerRef ==         (none)           51     single-field equality               automatic (policy adapter; bounded)
//   4  financeAgreements/{ref}/versions             (none)                             version desc     N+1    single-field order, no filter       automatic single-field index
//   5  financeAgreements/{ref}/events               (none)                             createdAt desc   N+1    single-field order, no filter       automatic single-field index
//   6  financeAgreements/{ref}/extractionRuns       (none)                             createdAt desc   1      single-field order, no filter       automatic single-field index (x2 call sites)
//
// #1/#2 share one call site (the field name is a variable); #6 has two call sites (extraction result read, reconciliation loader).
// Every other read is a direct document get / transaction get (no query). The owner-module reads Finance calls (Partner by ref,
// Partner Accounts by refs, Vendor by ref) are those modules' own, already-audited queries.
// "Production verification pending": that Firestore production serves each of these from its automatic single-field index (the
// documented behavior for equality-only and single-field-order queries) is not something an emulator can prove.
describe("firestore.indexes.json - Finance Agreements (Step 14A query audit)", () => {
  const financeDir = path.resolve(import.meta.dirname, "../finance-agreements");

  function sourceFiles(dir: string, into: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, into);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) into.push(full);
    }
    return into;
  }

  const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(\s)\/\/.*$/gm, "$1");

  type QueryShape = { file: string; wheres: Array<{ field: string; op: string }>; orderBys: Array<{ field: string; direction: string }>; limited: boolean };

  function queriesIn(dir: string): { queries: QueryShape[]; collectionGroupUses: number; otherOperators: string[] } {
    const queries: QueryShape[] = [];
    let collectionGroupUses = 0;
    const otherOperators: string[] = [];
    for (const file of sourceFiles(dir)) {
      const source = strip(readFileSync(file, "utf8"));
      collectionGroupUses += (source.match(/collectionGroup\s*\(/g) ?? []).length;
      for (const operator of source.matchAll(/\.(startAfter|startAt|endAt|endBefore|offset|select|count)\s*\(/g)) otherOperators.push(`${path.basename(file)}:${operator[1]}`);
      // A query statement: `await <collection chain> ... .get()` containing a where / orderBy.
      for (const statement of source.matchAll(/await\s[^;]*?\.get\(\)/g)) {
        const text = statement[0];
        const wheres = [...text.matchAll(/\.where\(\s*([^,]+?)\s*,\s*"([^"]+)"/g)].map((m) => ({ field: m[1]!, op: m[2]! }));
        const orderBys = [...text.matchAll(/\.orderBy\(\s*"([^"]+)"\s*(?:,\s*"([^"]+)")?/g)].map((m) => ({ field: m[1]!, direction: m[2] ?? "asc" }));
        if (wheres.length === 0 && orderBys.length === 0) continue;
        queries.push({ file: path.relative(financeDir, file), wheres, orderBys, limited: /\.limit\(/.test(text) });
      }
    }
    return { queries, collectionGroupUses, otherOperators };
  }

  const audit = queriesIn(financeDir);

  it("the scan sees the real query call sites (it is not vacuous)", () => {
    expect(audit.queries.length).toBeGreaterThan(0);
    expect(audit.queries.map((query) => query.file)).toContain("firestore.ts");
  });

  it("the inventory is exactly the audited set: 2 equality-only queries (one on counterparty.<ref>, one adapter query) and 4 single-field-order queries", () => {
    const summary = audit.queries
      .map((query) => `${query.file} where[${query.wheres.map((w) => `${w.field} ${w.op}`).join(",")}] orderBy[${query.orderBys.map((o) => `${o.field} ${o.direction}`).join(",")}] limit:${query.limited}`)
      .sort();
    expect(summary).toEqual(
      [
        'agreement-service.ts where[field ==] orderBy[] limit:true',
        'policy-adapter.ts where["counterparty.partnerRef" ==] orderBy[] limit:true',
        'firestore.ts where[] orderBy[version desc] limit:true',
        'firestore.ts where[] orderBy[createdAt desc] limit:true',
        'reconciliation-loaders.ts where[] orderBy[createdAt desc] limit:true',
        'extraction-service.ts where[] orderBy[createdAt desc] limit:true',
      ].sort(),
    );
  });

  it("no Finance query needs a composite index: only equality filters, never a filter AND an order, never two fields, always bounded, no collection group / cursor / offset", () => {
    for (const query of audit.queries) {
      for (const where of query.wheres) expect(where.op, `${query.file} filter op`).toBe("==");
      expect(query.wheres.length + query.orderBys.length, `${query.file} uses more than one field`).toBe(1);
      expect(query.limited, `${query.file} is unbounded`).toBe(true);
    }
    expect(audit.collectionGroupUses).toBe(0);
    expect(audit.otherOperators).toEqual([]);
  });

  it("consequently NONE of the 14A queries needs a composite (the only Finance composites are the five Step 14B workspace scope shapes below) and no field override disables an automatic single-field index", () => {
    const financeCollections = ["financeAgreements", "versions", "events", "extractionRuns", "financeAgreementClaims", "financeContractArtifacts", "financeAgreementRestrictedExtractions"];
    // Step 14B (deliberate update): the workspace head scan added exactly five `financeAgreements` scope x updatedAt composites; every other Finance collection still has none.
    expect(indexesFile.indexes.filter((index) => financeCollections.includes(index.collectionGroup) && index.collectionGroup !== "financeAgreements")).toEqual([]);
    const overrides = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../firestore.indexes.json"), "utf8")).fieldOverrides ?? [];
    expect((overrides as Array<{ collectionGroup: string }>).filter((override) => financeCollections.includes(override.collectionGroup))).toEqual([]);
  });
});

// Step 14B (production query/index audit): the Finance Agreements WORKSPACE head scan (agreement-workspace-service.ts ->
// listAgreementHeadDocs) reads `financeAgreements` heads through the accepted scoped-list machinery, newest first by
// `updatedAt`. Scope is decomposed into SELF (ownerUid), REGION / TEAM (array-contains-any on the head's scope snapshot),
// PARTNER-grant (`partnerUid in`) and explicit-vendor (`vendorUid in`) branches; the GLOBAL branch pushes no filter (single-field
// updatedAt order, automatic index). No business filter (lifecycle / type / search / period / discrepancy) is pushed to Firestore -
// they are in-memory over the bounded set - so the composite set is exactly these five. Derived from the REAL planner output.
// "Production verification pending": the emulator never enforces composite indexes; deploying firestore.indexes.json is a
// separate, explicit step (NOT done here).
describe("firestore.indexes.json - Finance Agreements workspace (Step 14B)", () => {
  const updatedAtDesc: IndexField = { fieldPath: "updatedAt", order: "DESCENDING" };
  const partnerGrant: ScopeGrant = { type: "PARTNER", partnerId: "p-1", ...AUDIT };
  const vendorGrant: ScopeGrant = { type: "EXPLICIT_RECORD", resourceType: "vendor", resourceId: "v-1", ...AUDIT };
  const partnerRecordGrant: ScopeGrant = { type: "EXPLICIT_RECORD", resourceType: "partner", resourceId: "p-2", ...AUDIT };

  it("every scope branch (self / region / team / partner-grant / explicit-vendor) maps to a certified financeAgreements index", () => {
    const { plan } = planAgreementHeadListQuery({ actorUid: "actor-uid", grants: [self(), region("Kerala"), team("t1"), partnerGrant, partnerRecordGrant, vendorGrant], hasGlobal: false });
    expect(plan.branches.map((branch) => branch.name)).toEqual(["self", "region", "team", "partnerGrant", "vendorGrant"]);
    // self / region / team are equality / array shapes (hasIndexForBranch); the two `in` branches are asserted explicitly, like Partner Reviews'.
    for (const name of ["self", "region", "team"]) expect(hasIndexForBranch("financeAgreements", firestoreBranch(plan, name)), name).toBe(true);
    expect(hasIndex("financeAgreements", [{ fieldPath: "partnerUid", order: "ASCENDING" }, updatedAtDesc])).toBe(true);
    expect(hasIndex("financeAgreements", [{ fieldPath: "vendorUid", order: "ASCENDING" }, updatedAtDesc])).toBe(true);
    expect(firestoreBranch(plan, "partnerGrant").pushedFilters).toEqual([{ field: "partnerUid", op: "in", value: ["p-1", "p-2"] }]);
    expect(firestoreBranch(plan, "vendorGrant").pushedFilters).toEqual([{ field: "vendorUid", op: "in", value: ["v-1"] }]);
  });

  it("the GLOBAL branch pushes no filter and needs no composite index (a single-field updatedAt order)", () => {
    const branch = firestoreBranch(planAgreementHeadListQuery({ actorUid: "actor-uid", grants: [], hasGlobal: true }).plan, "main");
    expect(branch.pushedFilters).toEqual([]);
    expect(branch.orderField).toBe("updatedAt");
    expect(branch.orderDirection).toBe("desc");
  });

  it("an actor with no relevant grant plans no branch at all (no Firestore read)", () => {
    expect(planAgreementHeadListQuery({ actorUid: "actor-uid", grants: [], hasGlobal: false }).plan.branches).toEqual([]);
  });

  it("no branch pushes two array-type filters or a documentId() in (assertProductionValidPlan territory)", () => {
    const { plan } = planAgreementHeadListQuery({ actorUid: "actor-uid", grants: [self(), region("Kerala"), team("t1"), partnerGrant, vendorGrant], hasGlobal: false });
    for (const branch of plan.branches) {
      if (branch.kind !== "firestore-query") continue;
      expect(branch.pushedFilters.filter((f) => f.op === "array-contains" || f.op === "array-contains-any").length).toBeLessThanOrEqual(1);
      expect(branch.pushedFilters.some((f) => f.field === "__name__")).toBe(false);
    }
  });

  it("every financeAgreements index in the file is one the planner can actually produce (exact count: 5, no speculative extras)", () => {
    const mine = indexesFile.indexes.filter((index) => index.collectionGroup === "financeAgreements");
    expect(mine).toHaveLength(5);
    for (const index of mine) {
      expect(index.fields).toHaveLength(2);
      expect(index.fields[1]).toEqual(updatedAtDesc);
    }
    expect(mine.map((index) => indexFieldKey(index.fields[0]!)).sort()).toEqual(["ownerUid:ASCENDING", "partnerUid:ASCENDING", "regionIds:CONTAINS", "teamIds:CONTAINS", "vendorUid:ASCENDING"]);
  });

  // The intake counterparty search (searchCounterparties) reuses the OWNING modules' scoped list plans with an optional display-name
  // prefix and applies ACTIVE in memory (a status x scope x displayNameLower composite is not a certified shape - see
  // counterparty-picker-service.ts); those shapes are the owning modules' own certified indexes.
  it("the counterparty search's Partner / Vendor list shapes (optional name prefix, no pushed status, every scope branch) each map to a certified index", () => {
    const grants: ScopeGrant[] = [self(), region("Kerala"), team("t1")];
    for (const displayNamePrefix of [undefined, "acme"]) {
      const partners = planPartnerListQuery({ actorUid: "actor-uid", grants, hasGlobal: false, displayNamePrefix }).plan;
      for (const name of ["self", "region", "team"]) expect(hasIndexForBranch("partners", firestoreBranch(partners, name)), `partners ${name} ${displayNamePrefix ?? "-"}`).toBe(true);
      const vendors = planVendorListQuery({ actorUid: "actor-uid", grants, hasGlobal: false, displayNamePrefix }).plan;
      for (const name of ["self", "region", "team"]) expect(hasIndexForBranch("vendors", firestoreBranch(vendors, name)), `vendors ${name} ${displayNamePrefix ?? "-"}`).toBe(true);
    }
  });
});

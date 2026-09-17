import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ScopeGrant } from "@/server/authz/types";
import { planPartnerListQuery } from "@/server/partners/firestore";
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
  it("has a standalone createdAt-desc index for tier, targetAudience, and pendingPartnerAccountSetup", () => {
    expect(hasIndex("partners", [{ fieldPath: "tier", order: "ASCENDING" }, createdAtDesc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "targetAudience", order: "ASCENDING" }, createdAtDesc])).toBe(true);
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
});

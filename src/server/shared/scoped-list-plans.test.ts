import { describe, expect, it } from "vitest";

import type { ScopeGrant } from "@/server/authz/types";
import { planCampaignListQuery } from "@/server/campaigns/firestore";
import { planLeadListQuery } from "@/server/discovery/firestore";
import { planPartnerListQuery } from "@/server/partners/firestore";
import { planVendorListQuery } from "@/server/vendors/firestore";
import { assertProductionValidPlan, matchesFilter, mergeListBranches, passesBranchPostFilters, type FirestoreListBranchPlan, type ListQueryPlan, type MergeCandidate } from "./scoped-list";

// Step 8A.2: unit-level query-plan tests. These never touch Firestore or
// the emulator (the emulator doesn't enforce composite-index parity
// anyway - see scoped-list.ts's own header) - they assert directly on
// the PLAN a planner builds, making the two production-invalid shapes
// this correction removes (documentId() "in" combined with orderBy; two
// array-type filters in one query) impossible by construction, and
// separately verify the branch-disjointness/merge-pagination machinery
// every domain's planner relies on.

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
function explicit(resourceType: string, resourceId: string): ScopeGrant {
  return { type: "EXPLICIT_RECORD", resourceType, resourceId, ...AUDIT };
}
function partnerGrant(partnerId: string): ScopeGrant {
  return { type: "PARTNER", partnerId, ...AUDIT };
}
function campaignGrant(campaignId: string): ScopeGrant {
  return { type: "CAMPAIGN", campaignId, ...AUDIT };
}

const ACTOR_UID = "actor-uid";

function firestoreBranches(plan: ListQueryPlan): FirestoreListBranchPlan[] {
  return plan.branches.filter((b): b is FirestoreListBranchPlan => b.kind === "firestore-query");
}
function branchNames(plan: ListQueryPlan): string[] {
  return plan.branches.map((b) => b.name);
}
function arrayFilterCount(branch: FirestoreListBranchPlan): number {
  return branch.pushedFilters.filter((f) => f.op === "array-contains" || f.op === "array-contains-any").length;
}

describe("planLeadListQuery / planPartnerListQuery / planVendorListQuery / planCampaignListQuery - production-valid by construction", () => {
  const planners: Array<{ name: string; plan: (opts: Parameters<typeof planLeadListQuery>[0] | Parameters<typeof planPartnerListQuery>[0]) => ListQueryPlan }> = [
    { name: "leads", plan: (o) => planLeadListQuery(o as Parameters<typeof planLeadListQuery>[0]).plan },
    { name: "partners", plan: (o) => planPartnerListQuery(o as Parameters<typeof planPartnerListQuery>[0]).plan },
    { name: "vendors", plan: (o) => planVendorListQuery(o as Parameters<typeof planVendorListQuery>[0]).plan },
    { name: "campaigns", plan: (o) => planCampaignListQuery(o as Parameters<typeof planCampaignListQuery>[0]).plan },
  ];

  const scenarios: Array<{ label: string; grants: ScopeGrant[]; hasGlobal: boolean; region?: string }> = [
    { label: "no grants", grants: [], hasGlobal: false },
    { label: "GLOBAL", grants: [], hasGlobal: true },
    { label: "SELF only", grants: [self()], hasGlobal: false },
    { label: "REGION only", grants: [region("Kerala")], hasGlobal: false },
    { label: "TEAM only", grants: [team("t1")], hasGlobal: false },
    { label: "EXPLICIT_RECORD only", grants: [explicit("lead", "x1"), explicit("partner", "x1"), explicit("vendor", "x1")], hasGlobal: false },
    { label: "SELF+REGION+TEAM+EXPLICIT, no region filter", grants: [self(), region("Kerala"), team("t1"), explicit("lead", "x1"), explicit("partner", "x1"), explicit("vendor", "x1")], hasGlobal: false },
    {
      label: "SELF+REGION+TEAM+EXPLICIT, region filter granted",
      grants: [self(), region("Kerala"), team("t1"), explicit("lead", "x1"), explicit("partner", "x1"), explicit("vendor", "x1")],
      hasGlobal: false,
      region: "Kerala",
    },
    {
      label: "SELF+REGION+TEAM+EXPLICIT, region filter NOT granted",
      grants: [self(), region("Kerala"), team("t1"), explicit("lead", "x1"), explicit("partner", "x1"), explicit("vendor", "x1")],
      hasGlobal: false,
      region: "Tamil Nadu",
    },
    { label: "TEAM only, region filter not granted", grants: [team("t1")], hasGlobal: false, region: "Tamil Nadu" },
    { label: "GLOBAL, region filter selected", grants: [], hasGlobal: true, region: "Kerala" },
    { label: "PARTNER-type grant (Partners only)", grants: [partnerGrant("p1")], hasGlobal: false },
  ];

  for (const { name, plan } of planners) {
    for (const scenario of scenarios) {
      it(`${name}: "${scenario.label}" never produces a production-invalid branch`, () => {
        const built = plan({ actorUid: ACTOR_UID, grants: scenario.grants, hasGlobal: scenario.hasGlobal, region: scenario.region });
        expect(() => assertProductionValidPlan(built)).not.toThrow();
        for (const branch of firestoreBranches(built)) {
          expect(arrayFilterCount(branch)).toBeLessThanOrEqual(1);
        }
      });
    }
  }
});

describe("planPartnerListQuery - specific shapes", () => {
  it("explicit-record-only scope produces exactly one bounded-ids branch, no firestore-query branch", () => {
    const { plan } = planPartnerListQuery({ actorUid: ACTOR_UID, grants: [explicit("partner", "p1")], hasGlobal: false });
    expect(plan.branches).toHaveLength(1);
    expect(plan.branches[0]!.kind).toBe("bounded-ids");
  });

  it("PARTNER-type grants merge into the same bounded-ids explicit branch as EXPLICIT_RECORD grants", () => {
    const { plan } = planPartnerListQuery({ actorUid: ACTOR_UID, grants: [partnerGrant("p1"), explicit("partner", "p2")], hasGlobal: false });
    expect(plan.branches).toHaveLength(1);
    const branch = plan.branches[0]!;
    expect(branch.kind).toBe("bounded-ids");
    if (branch.kind === "bounded-ids") expect(new Set(branch.ids)).toEqual(new Set(["p1", "p2"]));
  });

  it("explicit + region scope overlap: the explicit branch excludes anything the region branch would already cover", () => {
    const { plan } = planPartnerListQuery({ actorUid: ACTOR_UID, grants: [region("Kerala"), explicit("partner", "p1")], hasGlobal: false });
    const explicitBranch = plan.branches.find((b) => b.name === "explicit")!;
    expect(explicitBranch.excludePostFilters.some((f) => f.field === "regionIds" && f.op === "array-contains-any")).toBe(true);
    // A doc that IS in a granted region is excluded from the explicit branch (the "region" branch already surfaces it).
    const inRegionDoc = { regionIds: ["Kerala"] };
    expect(passesBranchPostFilters(inRegionDoc, explicitBranch)).toBe(false);
    // A doc genuinely outside every granted region still passes (only reachable via EXPLICIT_RECORD).
    const outsideRegionDoc = { regionIds: ["Tamil Nadu"] };
    expect(passesBranchPostFilters(outsideRegionDoc, explicitBranch)).toBe(true);
  });

  it("explicit + owner overlap: the explicit branch excludes anything the self branch would already cover", () => {
    const { plan } = planPartnerListQuery({ actorUid: ACTOR_UID, grants: [self(), explicit("partner", "p1")], hasGlobal: false });
    const explicitBranch = plan.branches.find((b) => b.name === "explicit")!;
    const ownDoc = { ownerUid: ACTOR_UID };
    expect(passesBranchPostFilters(ownDoc, explicitBranch)).toBe(false);
    const otherDoc = { ownerUid: "someone-else" };
    expect(passesBranchPostFilters(otherDoc, explicitBranch)).toBe(true);
  });

  it("region-scoped actor filtering to an allowed region collapses to a single unscoped-shaped branch", () => {
    const { plan } = planPartnerListQuery({ actorUid: ACTOR_UID, grants: [region("Kerala"), self()], hasGlobal: false, region: "Kerala" });
    expect(plan.branches).toHaveLength(1);
    expect(branchNames(plan)).toEqual(["main"]);
  });

  it("region-scoped actor filtering to a disallowed region never includes a redundant region branch, but self/team/explicit still apply the region filter", () => {
    const { plan } = planPartnerListQuery({ actorUid: ACTOR_UID, grants: [region("Kerala"), self(), team("t1")], hasGlobal: false, region: "Tamil Nadu" });
    expect(branchNames(plan)).not.toContain("region");
    const selfBranch = plan.branches.find((b) => b.name === "self") as FirestoreListBranchPlan;
    expect(selfBranch.pushedFilters.some((f) => f.field === "regionIds" && f.op === "array-contains" && f.value === "Tamil Nadu")).toBe(true);
    const teamBranch = plan.branches.find((b) => b.name === "team") as FirestoreListBranchPlan;
    // TEAM's own array-contains-any can never combine with the region's array-contains in one query - it must be a postFilter, never pushed.
    expect(teamBranch.pushedFilters.some((f) => f.field === "regionIds")).toBe(false);
    expect(teamBranch.postFilters.some((f) => f.field === "regionIds" && f.op === "array-contains" && f.value === "Tamil Nadu")).toBe(true);
    expect(arrayFilterCount(teamBranch)).toBe(1);
  });

  it("global actor + selected region produces one branch with the region pushed as a plain array-contains filter", () => {
    const { plan } = planPartnerListQuery({ actorUid: ACTOR_UID, grants: [], hasGlobal: true, region: "Kerala" });
    expect(plan.branches).toHaveLength(1);
    const branch = plan.branches[0] as FirestoreListBranchPlan;
    expect(branch.pushedFilters).toContainEqual({ field: "regionIds", op: "array-contains", value: "Kerala" });
  });

  it("team actor + selected region: team branch's own array filter is teamIds, region is a postFilter, and it excludes anything self already covers", () => {
    const { plan } = planPartnerListQuery({ actorUid: ACTOR_UID, grants: [team("t1"), self()], hasGlobal: false, region: "Kerala" });
    const teamBranch = plan.branches.find((b) => b.name === "team") as FirestoreListBranchPlan;
    expect(teamBranch.pushedFilters).toContainEqual({ field: "teamIds", op: "array-contains-any", value: ["t1"] });
    expect(teamBranch.excludePostFilters.some((f) => f.field === "ownerUid")).toBe(true);
    const ownedDoc = { ownerUid: ACTOR_UID, teamIds: ["t1"], regionIds: ["Kerala"] };
    expect(passesBranchPostFilters(ownedDoc, teamBranch)).toBe(false); // covered by "self" instead
    const teamOnlyDoc = { ownerUid: "someone-else", teamIds: ["t1"], regionIds: ["Kerala"] };
    expect(passesBranchPostFilters(teamOnlyDoc, teamBranch)).toBe(true);
    const wrongRegionDoc = { ownerUid: "someone-else", teamIds: ["t1"], regionIds: ["Tamil Nadu"] };
    expect(passesBranchPostFilters(wrongRegionDoc, teamBranch)).toBe(false); // region postFilter rejects it
  });

  it("search + scope: displayNamePrefix range filters are applied to every branch, orderField switches to displayNameLower", () => {
    const { plan, orderField } = planPartnerListQuery({ actorUid: ACTOR_UID, grants: [self(), team("t1")], hasGlobal: false, displayNamePrefix: "cre" });
    expect(orderField).toBe("displayNameLower");
    for (const branch of firestoreBranches(plan)) {
      expect(branch.pushedFilters.some((f) => f.field === "displayNameLower" && f.op === ">=")).toBe(true);
      expect(branch.orderField).toBe("displayNameLower");
      expect(branch.orderDirection).toBe("asc");
    }
  });

  it("status + scope: the status equality filter is applied to every branch", () => {
    const { plan } = planPartnerListQuery({ actorUid: ACTOR_UID, grants: [self(), region("Kerala"), team("t1")], hasGlobal: false, status: "ACTIVE" });
    for (const branch of firestoreBranches(plan)) {
      expect(branch.pushedFilters).toContainEqual({ field: "status", op: "==", value: "ACTIVE" });
    }
  });
});

describe("planVendorListQuery - array-field conflicts (mirrors Partners)", () => {
  it("team actor + selected region never pushes two array-type filters", () => {
    const { plan } = planVendorListQuery({ actorUid: ACTOR_UID, grants: [team("t1")], hasGlobal: false, region: "Kerala" });
    const teamBranch = plan.branches.find((b) => b.name === "team") as FirestoreListBranchPlan;
    expect(arrayFilterCount(teamBranch)).toBe(1);
    expect(teamBranch.postFilters.some((f) => f.field === "regionIds")).toBe(true);
  });
});

describe("planCampaignListQuery - CAMPAIGN grant merge and dual business-array-filter budget", () => {
  it("CAMPAIGN-type grants merge into the same bounded-ids explicit branch as EXPLICIT_RECORD grants", () => {
    const { plan } = planCampaignListQuery({ actorUid: ACTOR_UID, grants: [campaignGrant("c1"), explicit("campaign", "c2")], hasGlobal: false });
    expect(plan.branches).toHaveLength(1);
    const branch = plan.branches[0]!;
    expect(branch.kind).toBe("bounded-ids");
    if (branch.kind === "bounded-ids") expect(new Set(branch.ids)).toEqual(new Set(["c1", "c2"]));
  });

  it("region AND platform both selected: region wins the pushed array slot, platform becomes a postFilter, on a branch with no other array filter", () => {
    const { plan } = planCampaignListQuery({ actorUid: ACTOR_UID, grants: [self()], hasGlobal: false, region: "Kerala", platform: "INSTAGRAM" });
    const selfBranch = plan.branches.find((b) => b.name === "self") as FirestoreListBranchPlan;
    expect(arrayFilterCount(selfBranch)).toBe(1);
    expect(selfBranch.pushedFilters).toContainEqual({ field: "regionIds", op: "array-contains", value: "Kerala" });
    expect(selfBranch.postFilters).toContainEqual({ field: "platforms", op: "array-contains", value: "INSTAGRAM" });
  });

  it("platform selected alone (no region): pushed as a real array-contains filter on a branch with no other array filter", () => {
    const { plan } = planCampaignListQuery({ actorUid: ACTOR_UID, grants: [self()], hasGlobal: false, platform: "YOUTUBE" });
    const selfBranch = plan.branches.find((b) => b.name === "self") as FirestoreListBranchPlan;
    expect(selfBranch.pushedFilters).toContainEqual({ field: "platforms", op: "array-contains", value: "YOUTUBE" });
  });

  it("team actor + region AND platform selected: team branch's own array filter is teamIds, BOTH business filters land in postFilters (never a second pushed array filter)", () => {
    const { plan } = planCampaignListQuery({ actorUid: ACTOR_UID, grants: [team("t1")], hasGlobal: false, region: "Kerala", platform: "X" });
    const teamBranch = plan.branches.find((b) => b.name === "team") as FirestoreListBranchPlan;
    expect(arrayFilterCount(teamBranch)).toBe(1);
    expect(teamBranch.pushedFilters).toContainEqual({ field: "teamIds", op: "array-contains-any", value: ["t1"] });
    expect(teamBranch.postFilters).toContainEqual({ field: "regionIds", op: "array-contains", value: "Kerala" });
    expect(teamBranch.postFilters).toContainEqual({ field: "platforms", op: "array-contains", value: "X" });
  });
});

describe("planLeadListQuery - scalar region/team fields never need the array-conflict treatment", () => {
  it("team actor + selected region pushes both teamId `in` and region `==` in the SAME query (no array conflict for scalar fields)", () => {
    const { plan } = planLeadListQuery({ actorUid: ACTOR_UID, grants: [team("t1")], hasGlobal: false, region: "Kerala" });
    const teamBranch = plan.branches.find((b) => b.name === "team") as FirestoreListBranchPlan;
    expect(teamBranch.pushedFilters).toContainEqual({ field: "teamId", op: "in", value: ["t1"] });
    expect(teamBranch.pushedFilters).toContainEqual({ field: "region", op: "==", value: "Kerala" });
    expect(teamBranch.postFilters).toHaveLength(0);
  });
});

describe("matchesFilter - the in-memory counterpart used for postFilters/excludePostFilters", () => {
  it("evaluates every operator the planners emit", () => {
    expect(matchesFilter({ status: "ACTIVE" }, { field: "status", op: "==", value: "ACTIVE" })).toBe(true);
    expect(matchesFilter({ regionIds: ["Kerala", "Goa"] }, { field: "regionIds", op: "array-contains", value: "Goa" })).toBe(true);
    expect(matchesFilter({ teamIds: ["t1"] }, { field: "teamIds", op: "array-contains-any", value: ["t2", "t1"] })).toBe(true);
    expect(matchesFilter({ region: "Kerala" }, { field: "region", op: "in", value: ["Kerala", "Goa"] })).toBe(true);
    expect(matchesFilter({ displayNameLower: "bravo" }, { field: "displayNameLower", op: ">=", value: "alpha" })).toBe(true);
    expect(matchesFilter({ displayNameLower: "alpha" }, { field: "displayNameLower", op: "<", value: "bravo" })).toBe(true);
  });
});

describe("mergeListBranches - deterministic pagination across merged branches", () => {
  function candidate(id: string, value: string): MergeCandidate<string> {
    return { doc: id, sortValue: value, uid: id };
  }

  it("merges multiple branches into one globally-ordered page (desc) and reports correct per-branch consumption", () => {
    const branchA = { name: "a", items: [candidate("a1", "2026-01-03"), candidate("a2", "2026-01-01")] };
    const branchB = { name: "b", items: [candidate("b1", "2026-01-02")] };
    const { page, consumed } = mergeListBranches([branchA, branchB], 2, "desc");
    expect(page).toEqual(["a1", "b1"]);
    expect(consumed).toEqual({ a: 1, b: 1 });
  });

  it("is stable and deterministic when sortValues tie (uid tie-break, always ascending)", () => {
    const branchA = { name: "a", items: [candidate("z", "2026-01-01")] };
    const branchB = { name: "b", items: [candidate("m", "2026-01-01")] };
    const { page } = mergeListBranches([branchA, branchB], 2, "asc");
    expect(page).toEqual(["m", "z"]); // "m" < "z" as the tie-break, regardless of branch order
  });

  it("never duplicates a record: branches are assumed disjoint, and paging through exhausts each branch exactly once", () => {
    const branchA = { name: "a", items: [candidate("a1", "2026-01-03"), candidate("a2", "2026-01-01")] };
    const branchB = { name: "b", items: [candidate("b1", "2026-01-02")] };
    const page1 = mergeListBranches([branchA, branchB], 2, "desc");
    expect(page1.page).toEqual(["a1", "b1"]);
    const remainingA = branchA.items.slice(page1.consumed.a ?? 0);
    const remainingB = branchB.items.slice(page1.consumed.b ?? 0);
    const page2 = mergeListBranches([{ name: "a", items: remainingA }, { name: "b", items: remainingB }], 2, "desc");
    expect(page2.page).toEqual(["a2"]);
    const seen = [...page1.page, ...page2.page];
    expect(new Set(seen).size).toBe(seen.length);
  });
});

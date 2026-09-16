import { afterEach, describe, expect, it, vi } from "vitest";

const { getAdminFirestoreMock } = vi.hoisted(() => ({ getAdminFirestoreMock: vi.fn() }));
vi.mock("@/server/firebase/admin", () => ({ getAdminFirestore: getAdminFirestoreMock }));

import { makeFakeFirestore } from "./test-helpers/fake-firestore";
import {
  getActorScopeGrants,
  hasGlobalScope,
  isAnalyticsAccountInScope,
  isAnalyticsDatasetInScope,
  isCampaignInScope,
  isExplicitRecordInScope,
  isPartnerInScope,
  isRegionInScope,
  isResourceInScope,
  isSelfInScope,
  isTeamInScope,
} from "./scope";
import type { ActorContext, ScopeGrant } from "./types";

const actor: ActorContext = { uid: "uid-1", email: "a@b.com", role: "partnership_manager", displayName: "A", userRef: "ref-1" };

afterEach(() => {
  vi.clearAllMocks();
});

function grant(partial: Partial<ScopeGrant> & Pick<ScopeGrant, "type">): ScopeGrant {
  return { uid: "uid-1", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "system:seed", ...partial } as ScopeGrant;
}

describe("hasGlobalScope", () => {
  it("is true only with an explicit GLOBAL grant (explicit GLOBAL allow)", () => {
    expect(hasGlobalScope([grant({ type: "GLOBAL" })])).toBe(true);
  });

  it("is false when no GLOBAL grant is present - never implied by anything else (GLOBAL absent => no implicit global access)", () => {
    const manyOtherGrants: ScopeGrant[] = [
      grant({ type: "REGION", region: "Kerala" }),
      grant({ type: "TEAM", teamId: "kerala-programmes" }),
      grant({ type: "PARTNER", partnerId: "creator-house" }),
      grant({ type: "CAMPAIGN", campaignId: "civic-voices" }),
    ];
    expect(hasGlobalScope(manyOtherGrants)).toBe(false);
    expect(hasGlobalScope([])).toBe(false);
  });
});

describe("isSelfInScope", () => {
  it("allows a resource owned by the actor when a SELF grant exists (SELF allow)", () => {
    expect(isSelfInScope([grant({ type: "SELF" })], "uid-1", "uid-1")).toBe(true);
  });

  it("denies a resource owned by someone else, even with a SELF grant (SELF deny)", () => {
    expect(isSelfInScope([grant({ type: "SELF" })], "uid-1", "uid-2")).toBe(false);
  });

  it("denies when there's no SELF grant at all, even for the actor's own resource", () => {
    expect(isSelfInScope([], "uid-1", "uid-1")).toBe(false);
  });
});

describe("isRegionInScope", () => {
  it("allows a region the actor is explicitly granted (same-region allow)", () => {
    expect(isRegionInScope([grant({ type: "REGION", region: "Kerala" })], "Kerala")).toBe(true);
  });

  it("denies a region outside the actor's grants (cross-region deny)", () => {
    expect(isRegionInScope([grant({ type: "REGION", region: "Kerala" })], "Karnataka")).toBe(false);
  });
});

describe("isTeamInScope", () => {
  it("allows a team the actor is explicitly granted (same-team allow)", () => {
    expect(isTeamInScope([grant({ type: "TEAM", teamId: "kerala-programmes" })], "kerala-programmes")).toBe(true);
  });

  it("denies a team outside the actor's grants (cross-team deny)", () => {
    expect(isTeamInScope([grant({ type: "TEAM", teamId: "kerala-programmes" })], "maharashtra-programmes")).toBe(false);
  });
});

describe("isPartnerInScope", () => {
  it("allows a granted partner", () => {
    expect(isPartnerInScope([grant({ type: "PARTNER", partnerId: "creator-house" })], "creator-house")).toBe(true);
  });

  it("denies a partner not granted", () => {
    expect(isPartnerInScope([grant({ type: "PARTNER", partnerId: "creator-house" })], "south-creators")).toBe(false);
  });
});

describe("isCampaignInScope", () => {
  it("allows a granted campaign", () => {
    expect(isCampaignInScope([grant({ type: "CAMPAIGN", campaignId: "civic-voices" })], "civic-voices")).toBe(true);
  });

  it("denies a campaign not granted", () => {
    expect(isCampaignInScope([grant({ type: "CAMPAIGN", campaignId: "civic-voices" })], "regional-first")).toBe(false);
  });
});

describe("isExplicitRecordInScope", () => {
  it("allows the exact resourceType+resourceId granted", () => {
    const grants = [grant({ type: "EXPLICIT_RECORD", resourceType: "content", resourceId: "community-story-reel-01" })];
    expect(isExplicitRecordInScope(grants, "content", "community-story-reel-01")).toBe(true);
  });

  it("denies a different resourceId in the same resourceType", () => {
    const grants = [grant({ type: "EXPLICIT_RECORD", resourceType: "content", resourceId: "community-story-reel-01" })];
    expect(isExplicitRecordInScope(grants, "content", "some-other-item")).toBe(false);
  });

  it("denies the same resourceId under a different resourceType", () => {
    const grants = [grant({ type: "EXPLICIT_RECORD", resourceType: "content", resourceId: "abc" })];
    expect(isExplicitRecordInScope(grants, "assignment", "abc")).toBe(false);
  });
});

describe("isAnalyticsDatasetInScope / isAnalyticsAccountInScope", () => {
  it("allows a granted dataset and denies an ungranted one", () => {
    const grants = [grant({ type: "ANALYTICS_DATASET", datasetId: "cross-platform-reach" })];
    expect(isAnalyticsDatasetInScope(grants, "cross-platform-reach")).toBe(true);
    expect(isAnalyticsDatasetInScope(grants, "engagement-actions")).toBe(false);
  });

  it("allows a granted account and denies an ungranted one", () => {
    const grants = [grant({ type: "ANALYTICS_ACCOUNT", accountId: "instagram-primary" })];
    expect(isAnalyticsAccountInScope(grants, "instagram-primary")).toBe(true);
    expect(isAnalyticsAccountInScope(grants, "youtube-primary")).toBe(false);
  });
});

describe("isResourceInScope (composite, multiple simultaneous grants)", () => {
  const grants: ScopeGrant[] = [
    grant({ type: "REGION", region: "Kerala" }),
    grant({ type: "TEAM", teamId: "kerala-programmes" }),
    grant({ type: "PARTNER", partnerId: "creator-house" }),
  ];

  it("allows a resource that matches any one of several simultaneous grants", () => {
    expect(isResourceInScope(grants, "uid-1", { region: "Kerala" })).toBe(true);
    expect(isResourceInScope(grants, "uid-1", { teamId: "kerala-programmes" })).toBe(true);
    expect(isResourceInScope(grants, "uid-1", { partnerId: "creator-house" })).toBe(true);
  });

  it("denies a resource that matches none of the actor's grants", () => {
    expect(isResourceInScope(grants, "uid-1", { region: "Karnataka", teamId: "other-team", partnerId: "other-partner" })).toBe(false);
  });

  it("GLOBAL short-circuits every other dimension", () => {
    const withGlobal = [...grants, grant({ type: "GLOBAL" })];
    expect(isResourceInScope(withGlobal, "uid-1", { region: "anywhere-not-granted" })).toBe(true);
  });

  it("denies an empty resource descriptor (nothing to match)", () => {
    expect(isResourceInScope(grants, "uid-1", {})).toBe(false);
  });
});

describe("getActorScopeGrants (malformed/unknown fails closed)", () => {
  it("excludes a document with an unrecognized scope type", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "scopeAssignments/uid-1__WEIRD": { uid: "uid-1", type: "SOMETHING_MADE_UP", grantedAt: "x", grantedBy: "y" },
      }),
    );
    const grants = await getActorScopeGrants(actor);
    expect(grants).toEqual([]);
  });

  it("excludes a REGION grant missing its region field", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "scopeAssignments/uid-1__REGION": { uid: "uid-1", type: "REGION", grantedAt: "x", grantedBy: "y" },
      }),
    );
    const grants = await getActorScopeGrants(actor);
    expect(grants).toEqual([]);
  });

  it("loads multiple valid, simultaneous grants for the same actor", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "scopeAssignments/uid-1__REGION__Kerala": {
          uid: "uid-1",
          type: "REGION",
          region: "Kerala",
          grantedAt: "x",
          grantedBy: "y",
        },
        "scopeAssignments/uid-1__PARTNER__creator-house": {
          uid: "uid-1",
          type: "PARTNER",
          partnerId: "creator-house",
          grantedAt: "x",
          grantedBy: "y",
        },
      }),
    );
    const grants = await getActorScopeGrants(actor);
    expect(grants).toHaveLength(2);
  });
});

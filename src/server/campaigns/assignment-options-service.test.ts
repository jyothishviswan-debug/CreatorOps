import { describe, expect, it } from "vitest";

import {
  buildCampaignContext,
  MAX_ASSIGNMENT_PARTNER_SEARCH_RESULTS,
  platformDisplayLabel,
  sortAssignmentOptionAccounts,
  toAssignmentOptionAccount,
  toSafePartnerOption,
} from "./assignment-options-service";

// Step 12C.1: the pure DTO-shaping half of the create-options service -
// what actually leaves the server for the Partner/Account pickers.

describe("toSafePartnerOption", () => {
  it("exposes ONLY partnerRef, displayName and region labels - never email/phone/legalName/owner", () => {
    const leaky = {
      partnerRef: "p-1",
      displayName: "Creator House",
      regionIds: ["Kerala"],
      email: "secret@example.com",
      phone: "+91 99999 99999",
      legalName: "Creator House Pvt Ltd",
      ownerRef: "owner-ref",
      ownerUid: "raw-firebase-uid",
      tier: "gold",
    };
    const option = toSafePartnerOption(leaky);
    expect(option).toEqual({ partnerRef: "p-1", displayName: "Creator House", regionLabels: ["Kerala"] });
    const serialized = JSON.stringify(option);
    for (const forbidden of ["secret@example.com", "99999", "Pvt Ltd", "owner", "raw-firebase-uid", "gold", "email", "phone", "legalName"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("toAssignmentOptionAccount", () => {
  const base = { partnerAccountRef: "pa-1", displayName: "Creator House", handle: "creatorhouse", platform: "Instagram", primary: true, status: "ACTIVE" };

  it("normalizes the platform with the shared normalizer and marks compatible ACTIVE accounts selectable", () => {
    expect(toAssignmentOptionAccount(base, ["instagram"])).toEqual({
      partnerAccountRef: "pa-1",
      label: "Creator House",
      platform: "instagram",
      platformLabel: "Instagram",
      handle: "creatorhouse",
      primary: true,
      selectable: true,
      unavailableReason: null,
    });
  });

  it("returns a narrow DTO - no normalizedIdentity/platformAccountId/followerSnapshot/profileUrl ever leak through", () => {
    const leaky = { ...base, normalizedIdentity: "instagram:handle:creatorhouse", platformAccountId: "UC123456", followerSnapshot: { count: 5, asOf: "x" }, profileUrl: "https://instagram.com/creatorhouse", uid: "raw-doc-id", partnerRef: "p-1" };
    const dto = toAssignmentOptionAccount(leaky, ["instagram"]);
    expect(Object.keys(dto).sort()).toEqual(["handle", "label", "partnerAccountRef", "platform", "platformLabel", "primary", "selectable", "unavailableReason"]);
    const serialized = JSON.stringify(dto);
    for (const forbidden of ["normalizedIdentity", "platformAccountId", "UC123456", "followerSnapshot", "profileUrl", "raw-doc-id", "partnerRef"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("falls back to handle, then the platform label, when there is no display name", () => {
    expect(toAssignmentOptionAccount({ ...base, displayName: null }, ["instagram"]).label).toBe("creatorhouse");
    expect(toAssignmentOptionAccount({ ...base, displayName: null, handle: null }, ["instagram"]).label).toBe("Instagram");
  });

  it("marks incompatible-platform and INACTIVE accounts unselectable with their reason", () => {
    expect(toAssignmentOptionAccount({ ...base, platform: "TikTok" }, ["instagram"])).toMatchObject({ selectable: false, unavailableReason: "Platform not part of this Campaign" });
    expect(toAssignmentOptionAccount({ ...base, status: "INACTIVE" }, ["instagram"])).toMatchObject({ selectable: false, unavailableReason: "Inactive account" });
  });

  it("keeps several accounts on the same compatible platform all selectable", () => {
    const one = toAssignmentOptionAccount({ ...base, partnerAccountRef: "pa-1" }, ["instagram"]);
    const two = toAssignmentOptionAccount({ ...base, partnerAccountRef: "pa-2", displayName: "Creator House Reels", primary: false }, ["instagram"]);
    expect([one.selectable, two.selectable]).toEqual([true, true]);
  });
});

describe("sortAssignmentOptionAccounts", () => {
  it("orders primary first, then platform, label, ref - deterministically", () => {
    const make = (ref: string, platform: string, label: string, primary: boolean) => ({ partnerAccountRef: ref, label, platform, platformLabel: platform, handle: null, primary, selectable: true, unavailableReason: null });
    const sorted = sortAssignmentOptionAccounts([make("c", "youtube", "A", false), make("b", "instagram", "B", false), make("a", "instagram", "A", false), make("z", "youtube", "Z", true)]);
    expect(sorted.map((a) => a.partnerAccountRef)).toEqual(["z", "a", "b", "c"]);
  });
});

describe("buildCampaignContext", () => {
  it("returns safe display fields only, with normalized + labelled platforms", () => {
    const context = buildCampaignContext({
      name: "Civic Voices",
      objective: "Raise awareness.",
      platforms: ["instagram", "youtube"],
      regionIds: ["Kerala"],
      startDate: "2026-01-01",
      endDate: "2026-06-01",
      // fields a full CampaignDto carries that must NOT be copied through:
      ...({ campaignRef: "ref-1", defaultReviewPolicy: "REVIEW_REQUIRED", ownerRef: "o", criteria: { targetAudience: ["India 1"] } } as object),
    } as Parameters<typeof buildCampaignContext>[0]);
    expect(context).toEqual({
      name: "Civic Voices",
      objective: "Raise awareness.",
      platforms: [
        { platform: "instagram", platformLabel: "Instagram" },
        { platform: "youtube", platformLabel: "Youtube" },
      ],
      regionIds: ["Kerala"],
      startDate: "2026-01-01",
      endDate: "2026-06-01",
    });
    const serialized = JSON.stringify(context);
    for (const forbidden of ["ref-1", "REVIEW_REQUIRED", "defaultReviewPolicy", "targetAudience", "ownerRef"]) expect(serialized).not.toContain(forbidden);
  });
});

describe("platformDisplayLabel / bounds", () => {
  it("title-cases display only and tolerates empty", () => {
    expect(platformDisplayLabel("instagram")).toBe("Instagram");
    expect(platformDisplayLabel("")).toBe("");
  });

  it("caps the Partner picker at 10 results", () => {
    expect(MAX_ASSIGNMENT_PARTNER_SEARCH_RESULTS).toBe(10);
  });
});

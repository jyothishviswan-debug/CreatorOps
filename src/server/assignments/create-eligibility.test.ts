import { describe, expect, it } from "vitest";

import { CAMPAIGN_STATUSES } from "@/server/campaigns/types";

import {
  CAMPAIGN_STATES_ALLOWING_ASSIGNMENT_CREATION,
  evaluatePartnerAccountEligibility,
  isCampaignStatusAllowingAssignmentCreation,
  PARTNER_ACCOUNT_UNAVAILABLE_INACTIVE,
  PARTNER_ACCOUNT_UNAVAILABLE_PLATFORM,
} from "./create-eligibility";

// Step 12C.1: pure lifecycle + Partner Account eligibility rules shared by
// createAssignment (server enforcement), the create-options picker and the
// Campaign Detail create-action visibility - defined once, tested once.

describe("isCampaignStatusAllowingAssignmentCreation", () => {
  it("is true for PLANNED and ACTIVE only", () => {
    expect(isCampaignStatusAllowingAssignmentCreation("PLANNED")).toBe(true);
    expect(isCampaignStatusAllowingAssignmentCreation("ACTIVE")).toBe(true);
  });

  it("is false for DRAFT, PAUSED, COMPLETED, CANCELLED and ARCHIVED", () => {
    for (const status of ["DRAFT", "PAUSED", "COMPLETED", "CANCELLED", "ARCHIVED"] as const) {
      expect(isCampaignStatusAllowingAssignmentCreation(status)).toBe(false);
    }
  });

  it("covers every canonical Campaign status - exactly two allow creation", () => {
    const allowed = CAMPAIGN_STATUSES.filter((status) => isCampaignStatusAllowingAssignmentCreation(status));
    expect(allowed).toEqual(["PLANNED", "ACTIVE"]);
    expect(CAMPAIGN_STATES_ALLOWING_ASSIGNMENT_CREATION.size).toBe(2);
  });
});

describe("evaluatePartnerAccountEligibility", () => {
  it("is selectable when ACTIVE and on a Campaign platform", () => {
    expect(evaluatePartnerAccountEligibility({ status: "ACTIVE", platform: "instagram" }, ["instagram", "youtube"])).toEqual({ platform: "instagram", selectable: true, unavailableReason: null });
  });

  it("uses the shared normalizer - casing and whitespace variants match on both sides", () => {
    expect(evaluatePartnerAccountEligibility({ status: "ACTIVE", platform: "  Instagram " }, ["instagram"]).selectable).toBe(true);
    expect(evaluatePartnerAccountEligibility({ status: "ACTIVE", platform: "YOUTUBE" }, ["  YouTube"]).selectable).toBe(true);
    expect(evaluatePartnerAccountEligibility({ status: "ACTIVE", platform: " Instagram " }, ["instagram"]).platform).toBe("instagram");
  });

  it("is unavailable, with a clear reason, when the account is INACTIVE", () => {
    expect(evaluatePartnerAccountEligibility({ status: "INACTIVE", platform: "instagram" }, ["instagram"])).toEqual({
      platform: "instagram",
      selectable: false,
      unavailableReason: PARTNER_ACCOUNT_UNAVAILABLE_INACTIVE,
    });
  });

  it("is unavailable when the platform is not part of the Campaign", () => {
    expect(evaluatePartnerAccountEligibility({ status: "ACTIVE", platform: "tiktok" }, ["instagram"])).toEqual({
      platform: "tiktok",
      selectable: false,
      unavailableReason: PARTNER_ACCOUNT_UNAVAILABLE_PLATFORM,
    });
  });

  it("reports INACTIVE before a platform mismatch (one reason, deterministic)", () => {
    expect(evaluatePartnerAccountEligibility({ status: "INACTIVE", platform: "tiktok" }, ["instagram"]).unavailableReason).toBe(PARTNER_ACCOUNT_UNAVAILABLE_INACTIVE);
  });

  it("treats several accounts on the same compatible platform as independently selectable", () => {
    const accounts = [
      { status: "ACTIVE", platform: "Instagram" },
      { status: "ACTIVE", platform: "instagram" },
      { status: "INACTIVE", platform: "instagram" },
    ];
    expect(accounts.map((account) => evaluatePartnerAccountEligibility(account, ["instagram"]).selectable)).toEqual([true, true, false]);
  });

  it("with no Campaign platforms nothing is selectable", () => {
    expect(evaluatePartnerAccountEligibility({ status: "ACTIVE", platform: "instagram" }, []).selectable).toBe(false);
  });
});

import { getUserDoc } from "@/server/authz/firestore";
import { CAMPAIGN_PLATFORMS, campaignCriteriaSchema, campaignResourceSchema, reviewPolicySchema, type CampaignDoc, type CampaignReadinessIssue, type CampaignReadinessResult } from "./types";

function blocker(code: string, message: string): CampaignReadinessIssue {
  return { code, message };
}

// Step 9A section 7: readiness is derived, never a manually writable
// checkbox - recomputed from the Campaign's own recorded state every
// time, same discipline as Discovery's evaluateLeadReadiness. The one
// live lookup is the owner's current active status, same reason Lead
// readiness re-checks its assigned manager rather than trusting a value
// frozen on the document. Deliberately does NOT invent blockers the
// frozen authority explicitly rules out (no required Vendor/Agreement/
// Partner/Assignment/upload, no fixed minimum regions, no budget/finance
// approval).
export async function evaluateCampaignReadiness(campaign: CampaignDoc): Promise<CampaignReadinessResult> {
  const blockers: CampaignReadinessIssue[] = [];
  const warnings: CampaignReadinessIssue[] = [];

  if (!campaign.name.trim()) {
    blockers.push(blocker("NAME_MISSING", "A Campaign name is required."));
  }
  if (!campaign.objective.trim()) {
    blockers.push(blocker("OBJECTIVE_MISSING", "A Campaign objective/description is required."));
  }

  const validPlatforms = campaign.platforms.filter((p) => (CAMPAIGN_PLATFORMS as readonly string[]).includes(p));
  if (validPlatforms.length === 0) {
    blockers.push(blocker("PLATFORM_MISSING", "At least one supported platform is required."));
  }

  if (!campaign.startDate || !campaign.endDate) {
    blockers.push(blocker("DATES_MISSING", "A start date and end date are required."));
  } else if (campaign.endDate < campaign.startDate) {
    blockers.push(blocker("DATE_RANGE_INVALID", "The end date cannot be before the start date."));
  }

  if (!reviewPolicySchema.safeParse(campaign.defaultReviewPolicy).success) {
    blockers.push(blocker("REVIEW_POLICY_INVALID", "A valid default review policy is required."));
  }

  // Also covers Step 9A REVISED section 7's own explicit readiness rule
  // ("any Target Audience criteria use only the accepted India Alpha/
  // India 1/India 2/India 3/India 4 taxonomy") - campaignCriteriaSchema's
  // targetAudience field is that exact closed enum, so a criteria object
  // carrying anything else already fails this one structural check.
  if (!campaignCriteriaSchema.safeParse(campaign.criteria).success) {
    blockers.push(blocker("CRITERIA_INVALID", "Targeting criteria is not structurally valid."));
  }
  if (!campaign.resources.every((r) => campaignResourceSchema.safeParse(r).success)) {
    blockers.push(blocker("RESOURCES_INVALID", "One or more resources are not structurally valid."));
  }

  if (campaign.ownerUid) {
    const owner = await getUserDoc(campaign.ownerUid);
    if (!owner || !owner.active) {
      blockers.push(blocker("OWNER_INACTIVE", "The assigned owner is no longer a real, active, admitted user."));
    }
  } else {
    warnings.push({ code: "OWNER_UNASSIGNED", message: "No owner is assigned yet." });
  }

  return { ready: blockers.length === 0, blockers, warnings };
}

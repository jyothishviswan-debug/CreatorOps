// Step 12C.1: the pure, I/O-free eligibility rules behind contextual
// Assignment creation - kept in one dependency-free module so the trusted
// createAssignment service, the Campaign Detail downstream summary, the
// create-options service and the unit tests all share ONE definition and
// can never drift apart (same "define once, reuse everywhere" discipline as
// execution-integration-service.ts's EXECUTION_OBLIGATION_ASSIGNMENT_STATUSES).
import { normalizePlatformIdentifier } from "@/server/shared/platform";
import type { CampaignStatus } from "@/server/campaigns/types";

// Campaign lifecycle states that permit creating/issuing an Assignment
// under it - Step 10A's judgment call #1. PLANNED = the Campaign has passed
// its own readiness gate; ACTIVE = currently running. DRAFT is pre-readiness
// (fields not guaranteed valid yet); PAUSED is a deliberate temporary halt
// during which new obligations shouldn't start; COMPLETED/CANCELLED/
// ARCHIVED are terminal. Moved here verbatim from assignment-service.ts -
// unchanged rule, now importable by pure callers.
export const CAMPAIGN_STATES_ALLOWING_ASSIGNMENT_CREATION: ReadonlySet<CampaignStatus> = new Set<CampaignStatus>(["PLANNED", "ACTIVE"]);

export function isCampaignStatusAllowingAssignmentCreation(status: CampaignStatus): boolean {
  return CAMPAIGN_STATES_ALLOWING_ASSIGNMENT_CREATION.has(status);
}

export const PARTNER_ACCOUNT_UNAVAILABLE_INACTIVE = "Inactive account";
export const PARTNER_ACCOUNT_UNAVAILABLE_PLATFORM = "Platform not part of this Campaign";
export type PartnerAccountUnavailableReason = typeof PARTNER_ACCOUNT_UNAVAILABLE_INACTIVE | typeof PARTNER_ACCOUNT_UNAVAILABLE_PLATFORM;

export type PartnerAccountEligibility = {
  // The account's platform, normalized with the ONE shared normalizer -
  // never re-implemented here.
  platform: string;
  selectable: boolean;
  unavailableReason: PartnerAccountUnavailableReason | null;
};

// A Partner Account may be attached to a Campaign Assignment only when it
// is ACTIVE and its (normalized) platform is one of the Campaign's own
// platforms. Multiple accounts on the same compatible platform are all
// individually eligible. `campaignPlatforms` are compared after
// normalization on both sides so casing/whitespace variants never matter.
export function evaluatePartnerAccountEligibility(account: { status: string; platform: string }, campaignPlatforms: readonly string[]): PartnerAccountEligibility {
  const platform = normalizePlatformIdentifier(account.platform);
  if (account.status !== "ACTIVE") return { platform, selectable: false, unavailableReason: PARTNER_ACCOUNT_UNAVAILABLE_INACTIVE };
  const allowed = new Set(campaignPlatforms.map(normalizePlatformIdentifier));
  if (!allowed.has(platform)) return { platform, selectable: false, unavailableReason: PARTNER_ACCOUNT_UNAVAILABLE_PLATFORM };
  return { platform, selectable: true, unavailableReason: null };
}

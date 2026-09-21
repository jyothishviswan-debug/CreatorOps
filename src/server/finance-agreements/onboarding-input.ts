import { z } from "zod";

import { claimIdFor, computeNormalizedIdentity } from "@/server/partners/identity";
import { normalizePlatformIdentifier } from "@/server/shared/platform";
import { vendorTypeSchema } from "@/server/vendors/types";

import { MAX_ONBOARDING_ACCOUNTS, normalizeOnboardingEmail, normalizeOnboardingName, normalizeOnboardingPhone } from "./onboarding-duplicates";
import { onboardingFingerprint } from "./onboarding-ledger";
import { clientRequestIdSchema, counterpartyTypeSchema, type CounterpartyType } from "./types";

// Step 14B.1: the strict INPUT of the onboarding command and its canonical form.
//
// The client names the reviewed profile, the Partner Accounts to create and the deliberate duplicate decision - never a uid, a scope, a
// status, an owner or a provenance marker (all strict: an unknown key is rejected). Everything the server needs to decide (the actor's
// scope, the create rights, whether a duplicate exists) it reads for itself.

const refString = z.string().trim().min(1).max(200);
const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

export const onboardingAccountInputSchema = z
  .object({
    platform: z.string().trim().min(1).max(60),
    // At least one locator; the OWNING module derives ONE canonical identity by its own priority (platform id > page link > handle).
    // With a NEW Partner these are the Accounts that get created. With USE_EXISTING they are evidence for the duplicate check ONLY (that is
    // how an Account-identity match is recognized as a candidate): nothing is created for them.
    handle: optionalText(120),
    profileUrl: optionalText(500),
    platformAccountId: optionalText(200),
    // The page / account name (display only: a name alone never identifies an Account).
    displayName: optionalText(200),
  })
  .strict();
export type OnboardingAccountInput = z.infer<typeof onboardingAccountInputSchema>;

const reviewedProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    legalName: optionalText(200),
    email: optionalText(300),
    phone: optionalText(40),
    // The regions the NEW record will carry. At least one, and the record must be visible to the person creating it.
    regionIds: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    // Vendors only.
    vendorType: vendorTypeSchema.optional(),
  })
  .strict();

const duplicateDecisionSchema = z.discriminatedUnion("kind", [
  // Continue with a record the duplicate check itself returned (re-verified live). Optionally name the Partner Accounts of that Partner
  // the Agreement covers.
  z.object({ kind: z.literal("USE_EXISTING"), ref: refString, partnerAccountRefs: z.array(refString).max(MAX_ONBOARDING_ACCOUNTS).optional() }).strict(),
  // Deliberately create a new record. A STRONG (or unknown) duplicate result needs acknowledgedDuplicates:true AND a reason.
  z.object({ kind: z.literal("CREATE_NEW"), acknowledgedDuplicates: z.boolean(), reason: z.string().trim().min(3).max(1000).optional() }).strict(),
]);

export const onboardingInputSchema = z
  .object({
    clientRequestId: clientRequestIdSchema,
    type: counterpartyTypeSchema,
    reviewedProfile: reviewedProfileSchema,
    accounts: z.array(onboardingAccountInputSchema).max(MAX_ONBOARDING_ACCOUNTS).optional(),
    duplicateDecision: duplicateDecisionSchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const accounts = input.accounts ?? [];
    const creating = input.duplicateDecision.kind === "CREATE_NEW";

    if (creating && input.reviewedProfile.regionIds.length === 0) issue(["reviewedProfile", "regionIds"], "Choose at least one region for the new record.");
    if (input.type === "VENDOR") {
      if (creating && !input.reviewedProfile.vendorType) issue(["reviewedProfile", "vendorType"], "Choose the Vendor type.");
      if (accounts.length > 0) issue(["accounts"], "A Vendor has no Partner Accounts.");
    } else if (input.reviewedProfile.vendorType) {
      issue(["reviewedProfile", "vendorType"], "A vendor type applies to Vendors only.");
    }
    if (input.duplicateDecision.kind === "USE_EXISTING" && input.duplicateDecision.partnerAccountRefs && input.type !== "PARTNER") issue(["duplicateDecision", "partnerAccountRefs"], "Partner Accounts apply to a Partner only.");

    const seen = new Set<string>();
    accounts.forEach((account, index) => {
      const key = accountKey(account);
      if (key === null) {
        issue(["accounts", index], "Each account needs a page link, a handle or a platform account id.");
        return;
      }
      if (seen.has(key)) issue(["accounts", index], "The same account is listed twice.");
      seen.add(key);
    });
  });
export type OnboardingInput = z.infer<typeof onboardingInputSchema>;
// The shape a caller SENDS (regionIds may be omitted for USE_EXISTING).
export type OnboardingRequest = z.input<typeof onboardingInputSchema>;

// --- Canonical account identity ---------------------------------------------------------------------------------------------------
// The known platforms keep the spelling the Partner module already uses ("Instagram", "YouTube"); anything else stays as typed (trimmed).
const PLATFORM_DISPLAY: Readonly<Record<string, string>> = { instagram: "Instagram", youtube: "YouTube" };

export function canonicalPlatform(platform: string): string {
  const normalized = normalizePlatformIdentifier(platform);
  return PLATFORM_DISPLAY[normalized] ?? platform.trim();
}

// The owning identity claim id of an account: sha256 of the owning normalized identity (null when no locator was given).
export function accountKey(account: Pick<OnboardingAccountInput, "platform" | "handle" | "profileUrl" | "platformAccountId">): string | null {
  const normalized = computeNormalizedIdentity({ platform: account.platform, platformAccountId: account.platformAccountId, profileUrl: account.profileUrl, handle: account.handle });
  return normalized === null ? null : claimIdFor(normalized);
}

// What the owning createPartnerAccount receives: the canonical platform and every locator the reviewer gave (the owning module picks the
// one canonical identity by its own priority, exactly as it does for any other Account).
export function accountCreateInput(account: OnboardingAccountInput, primary: boolean): Record<string, unknown> {
  return {
    platform: canonicalPlatform(account.platform),
    ...(account.handle ? { handle: account.handle } : {}),
    ...(account.profileUrl ? { profileUrl: account.profileUrl } : {}),
    ...(account.platformAccountId ? { platformAccountId: account.platformAccountId } : {}),
    ...(account.displayName ? { displayName: account.displayName } : {}),
    primary,
  };
}

// --- Normalized values the new record is created (and later matched) with ---------------------------------------------------------------
export type NormalizedProfile = {
  displayName: string;
  displayNameLower: string;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  regionIds: string[];
  vendorType: string | null;
};

// The owning modules store email / phone exactly as given, and their duplicate checks query the NORMALIZED form: so the new record is
// created with the normalized values, which makes the next duplicate check able to find it.
export function normalizeProfile(type: CounterpartyType, profile: OnboardingInput["reviewedProfile"]): NormalizedProfile {
  return {
    displayName: profile.displayName,
    displayNameLower: normalizeOnboardingName(type, profile.displayName),
    legalName: profile.legalName ?? null,
    email: normalizeOnboardingEmail(type, profile.email) ?? null,
    phone: normalizeOnboardingPhone(type, profile.phone) ?? null,
    regionIds: [...new Set(profile.regionIds)].sort(),
    vendorType: profile.vendorType ?? null,
  };
}

// The canonical form of the whole request: a retry with the same clientRequestId must send exactly this.
export function onboardingInputFingerprint(input: OnboardingInput): string {
  const profile = normalizeProfile(input.type, input.reviewedProfile);
  const accounts = (input.accounts ?? []).map((account) => ({
    key: accountKey(account),
    platform: canonicalPlatform(account.platform),
    handle: account.handle ?? null,
    profileUrl: account.profileUrl ?? null,
    platformAccountId: account.platformAccountId ?? null,
    displayName: account.displayName ?? null,
  }));
  const decision =
    input.duplicateDecision.kind === "USE_EXISTING"
      ? { kind: "USE_EXISTING", ref: input.duplicateDecision.ref, partnerAccountRefs: [...new Set(input.duplicateDecision.partnerAccountRefs ?? [])].sort() }
      : { kind: "CREATE_NEW", acknowledgedDuplicates: input.duplicateDecision.acknowledgedDuplicates, reason: input.duplicateDecision.reason ?? null };
  return onboardingFingerprint({ type: input.type, profile, accounts, decision });
}

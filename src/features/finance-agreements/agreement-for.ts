import { normalizePlatformIdentifier } from "@/server/shared/platform";
import type { AgreementCounterpartyInput, CounterpartyType } from "@/server/finance-agreements/types";
import type { CounterpartyPartnerAccountDto } from "@/server/finance-agreements/workspace-dto";

import { formatPlatformName } from "./format";

// Step 14B: the `Agreement for` selector rules (pure).
//
// The four top-level choices are UI shorthand only. Under the hood they map onto the canonical model:
//   Instagram Partner              -> ONE Partner, platform scope [instagram]
//   YouTube Partner                -> ONE Partner, platform scope [youtube]
//   Instagram + YouTube Partner    -> ONE Partner, platform scope [instagram, youtube]
//   Vendor                         -> a Vendor
// There are never separate Instagram / YouTube Partner entities. A Partner Agreement is either
//   Account-specific  one canonical Partner Account per selected platform is chosen deliberately (the accounts go to the
//                     server as partnerAccountRefs and the server derives the platform scope from them), or
//   Partner-level     no accounts are named; the intended platforms are recorded through the `platforms` field.
// A Vendor Agreement names the Vendor only - a represented Partner is never inferred.

export type AgreementForChoice = "INSTAGRAM_PARTNER" | "YOUTUBE_PARTNER" | "IG_YT_PARTNER" | "VENDOR";

export type AgreementForOption = {
  value: AgreementForChoice;
  label: string;
  description: string;
  counterpartyType: CounterpartyType;
  // Normalized platform ids the choice covers (empty for a Vendor).
  platforms: readonly string[];
};

export const AGREEMENT_FOR_OPTIONS: readonly AgreementForOption[] = [
  { value: "INSTAGRAM_PARTNER", label: "Instagram Partner", description: "A Partner on Instagram", counterpartyType: "PARTNER", platforms: ["instagram"] },
  { value: "YOUTUBE_PARTNER", label: "YouTube Partner", description: "A Partner on YouTube", counterpartyType: "PARTNER", platforms: ["youtube"] },
  { value: "IG_YT_PARTNER", label: "Instagram + YouTube Partner", description: "One Partner on both platforms", counterpartyType: "PARTNER", platforms: ["instagram", "youtube"] },
  { value: "VENDOR", label: "Vendor", description: "An agency, manager or business payee", counterpartyType: "VENDOR", platforms: [] },
];

export function agreementForOption(choice: AgreementForChoice): AgreementForOption {
  return AGREEMENT_FOR_OPTIONS.find((option) => option.value === choice)!;
}

// The canonical model a choice maps to.
export function resolveAgreementFor(choice: AgreementForChoice): { counterpartyType: CounterpartyType; platforms: string[] } {
  const option = agreementForOption(choice);
  return { counterpartyType: option.counterpartyType, platforms: [...option.platforms] };
}

// --- Account scope --------------------------------------------------------------------------------------------------------------------
export type AccountScope = "ACCOUNT_SPECIFIC" | "PARTNER_LEVEL";
export const ACCOUNT_SCOPE_LABELS: Record<AccountScope, string> = { ACCOUNT_SPECIFIC: "Account-specific", PARTNER_LEVEL: "Partner-level" };
export const ACCOUNT_SCOPE_DESCRIPTIONS: Record<AccountScope, string> = {
  ACCOUNT_SPECIFIC: "The Agreement covers specific Partner Accounts - choose one per platform.",
  PARTNER_LEVEL: "The Agreement covers the Partner as a whole - no accounts are named; the platforms are recorded on the Agreement.",
};

export type PlatformAccountGroup = {
  platform: string;
  platformLabel: string;
  // ACTIVE canonical accounts on this platform, primary first, then by handle / name (deterministic).
  eligible: CounterpartyPartnerAccountDto[];
  // Accounts on this platform that exist but cannot be chosen (INACTIVE) - shown so their absence is explained.
  inactiveCount: number;
  // The user must choose deliberately: more than one eligible account.
  requiresChoice: boolean;
  // No eligible account exists: an Account-specific Agreement cannot cover this platform.
  missing: boolean;
};

const accountSortKey = (account: CounterpartyPartnerAccountDto) => (account.handle ?? account.displayName ?? account.partnerAccountRef).toLowerCase();

// Groups a Partner's canonical accounts by the platforms the choice covers. Only ACTIVE accounts on a covered platform are eligible.
export function groupAccountsByPlatform(platforms: readonly string[], accounts: readonly CounterpartyPartnerAccountDto[]): PlatformAccountGroup[] {
  return platforms.map((raw) => {
    const platform = normalizePlatformIdentifier(raw);
    const onPlatform = accounts.filter((account) => normalizePlatformIdentifier(account.platform) === platform);
    const eligible = onPlatform
      .filter((account) => account.status === "ACTIVE")
      .sort((a, b) => Number(b.primary) - Number(a.primary) || accountSortKey(a).localeCompare(accountSortKey(b)) || a.partnerAccountRef.localeCompare(b.partnerAccountRef));
    return { platform, platformLabel: formatPlatformName(platform), eligible, inactiveCount: onPlatform.length - eligible.length, requiresChoice: eligible.length > 1, missing: eligible.length === 0 };
  });
}

// platform -> partnerAccountRef of the person's deliberate choices.
export type AccountSelection = Record<string, string | undefined>;

// A platform with EXACTLY ONE eligible account may be pre-selected (the person still sees and can change it);
// a platform with several is never pre-selected - the person must pick.
export function suggestedAccountSelection(groups: readonly PlatformAccountGroup[]): AccountSelection {
  const selection: AccountSelection = {};
  for (const group of groups) if (group.eligible.length === 1) selection[group.platform] = group.eligible[0]!.partnerAccountRef;
  return selection;
}

// --- Validation -> the createAgreementDraft input ---------------------------------------------------------------------------------------------
export type AgreementForIssueCode = "counterparty_required" | "scope_required" | "no_account_for_platform" | "account_required" | "account_not_eligible";
export type AgreementForIssue = { code: AgreementForIssueCode; message: string; platform?: string };

export type AgreementForInput = {
  choice: AgreementForChoice | null;
  // The chosen Partner / Vendor's opaque ref (null until one is picked).
  counterpartyRef: string | null;
  // Partner choices only; null until decided. Ignored for a Vendor.
  scope: AccountScope | null;
  selection: AccountSelection;
  // The chosen Partner's canonical accounts (from the counterparty preview); empty for a Vendor.
  accounts: readonly CounterpartyPartnerAccountDto[];
};

export type AgreementForResult =
  | {
      ok: true;
      counterpartyType: CounterpartyType;
      // The body's `counterparty` for POST /api/finance/agreements.
      counterparty: AgreementCounterpartyInput;
      // The platforms the Agreement is intended for. For Partner-level these are RECORDED through the `platforms` field
      // (the caller decides that field with this value); for Account-specific the server derives the scope from the accounts.
      platforms: string[];
      // Set only for a Partner-level Agreement: the value to record in the `platforms` field.
      recordPlatformsField: string[] | null;
    }
  | { ok: false; issues: AgreementForIssue[] };

export function buildAgreementFor(input: AgreementForInput): AgreementForResult {
  const issues: AgreementForIssue[] = [];
  if (!input.choice) return { ok: false, issues: [{ code: "counterparty_required", message: "Choose what the Agreement is for." }] };
  const { counterpartyType, platforms } = resolveAgreementFor(input.choice);
  const noun = counterpartyType === "PARTNER" ? "Partner" : "Vendor";
  if (!input.counterpartyRef) return { ok: false, issues: [{ code: "counterparty_required", message: `Search for and choose a ${noun}.` }] };

  if (counterpartyType === "VENDOR") return { ok: true, counterpartyType, counterparty: { type: "VENDOR", vendorRef: input.counterpartyRef }, platforms: [], recordPlatformsField: null };

  if (!input.scope) return { ok: false, issues: [{ code: "scope_required", message: "Choose whether the Agreement is Account-specific or Partner-level." }] };
  if (input.scope === "PARTNER_LEVEL") {
    return { ok: true, counterpartyType, counterparty: { type: "PARTNER", partnerRef: input.counterpartyRef }, platforms, recordPlatformsField: [...platforms] };
  }

  const groups = groupAccountsByPlatform(platforms, input.accounts);
  const refs: string[] = [];
  for (const group of groups) {
    if (group.missing) {
      issues.push({ code: "no_account_for_platform", platform: group.platform, message: `This Partner has no active ${group.platformLabel} account. Choose Partner-level, or add the account to the Partner first.` });
      continue;
    }
    const chosen = input.selection[group.platform];
    if (!chosen) {
      issues.push({ code: "account_required", platform: group.platform, message: `Choose the ${group.platformLabel} account this Agreement covers.` });
      continue;
    }
    if (!group.eligible.some((account) => account.partnerAccountRef === chosen)) {
      issues.push({ code: "account_not_eligible", platform: group.platform, message: `The selected ${group.platformLabel} account is not available for this Partner.` });
      continue;
    }
    refs.push(chosen);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, counterpartyType, counterparty: { type: "PARTNER", partnerRef: input.counterpartyRef, partnerAccountRefs: refs }, platforms, recordPlatformsField: null };
}

// The draft's counterparty cannot change after creation: a different Partner / Vendor / choice / scope / account set is a NEW draft.
export function counterpartyInputKey(counterparty: AgreementCounterpartyInput): string {
  if (counterparty.type === "VENDOR") return `VENDOR:${counterparty.vendorRef}`;
  return `PARTNER:${counterparty.partnerRef}:${[...(counterparty.partnerAccountRefs ?? [])].sort().join(",")}`;
}

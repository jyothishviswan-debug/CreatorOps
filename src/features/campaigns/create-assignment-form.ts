// Step 12C.1: the pure, I/O-free parsing/validation/payload-building logic
// behind the Campaign Detail "Create Assignment" dialog - kept out of the
// component so it is exactly unit-testable. It mirrors (never loosens) the
// trusted server's own createAssignment schema; the server independently
// re-validates everything, so this is a convenience/UX pre-check, never an
// authority.
import type { CreateAssignmentInput } from "@/server/assignments/assignment-service";
import { isHttpUrl } from "@/server/shared/http-url";
import { normalizePlatformIdentifier } from "@/server/shared/platform";

export type CreateAssignmentResourceLinkRow = { label: string; url: string; shareExternally: boolean };

export type CreateAssignmentFormValues = {
  instructions: string;
  contentRequirementSummary: string;
  requiredCount: string;
  formats: string;
  dueAt: string;
  language: string;
  hashtags: string;
  resourceLinks: CreateAssignmentResourceLinkRow[];
};

export const EMPTY_CREATE_ASSIGNMENT_FORM: CreateAssignmentFormValues = {
  instructions: "",
  contentRequirementSummary: "",
  requiredCount: "",
  formats: "",
  dueAt: "",
  language: "",
  hashtags: "",
  resourceLinks: [],
};

// Server bounds, restated (kept in step with assignment-service.ts's
// createAssignmentBriefInputSchema).
export const LIMITS = {
  instructions: 2000,
  contentRequirementSummary: 1000,
  requiredCountMax: 1000,
  formatsMax: 20,
  formatLength: 60,
  language: 60,
  hashtagsMax: 30,
  hashtagLength: 60,
  resourceLinksMax: 20,
  resourceLabel: 200,
  resourceUrl: 1000,
} as const;

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// "Reel, Story , reel" -> ["Reel", "Story"] - trimmed, blanks dropped,
// case-insensitive de-duplication keeping the first spelling.
export function parseCommaList(raw: string): string[] {
  return dedupeCaseInsensitive(
    raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
}

// Accepts commas and/or whitespace as separators and strips any number of
// leading "#" ("#Launch, launch  #Sale" -> ["Launch", "Sale"]).
export function parseHashtags(raw: string): string[] {
  return dedupeCaseInsensitive(
    raw
      .split(/[\s,]+/)
      .map((part) => part.replace(/^#+/, "").trim())
      .filter((part) => part.length > 0),
  );
}

// brief.platforms = the distinct, normalized platforms of the selected
// accounts (shared normalizer - never a local re-implementation).
export function distinctNormalizedPlatforms(accounts: ReadonlyArray<{ platform: string }>): string[] {
  return [...new Set(accounts.map((account) => normalizePlatformIdentifier(account.platform)))];
}

export type BuildCreateAssignmentResult = { ok: true; input: CreateAssignmentInput } | { ok: false; errors: string[] };

export function buildCreateAssignmentInput(args: {
  campaignRef: string;
  partnerRef: string;
  selectedAccounts: ReadonlyArray<{ partnerAccountRef: string; platform: string }>;
  values: CreateAssignmentFormValues;
}): BuildCreateAssignmentResult {
  const { values } = args;
  const errors: string[] = [];

  if (args.selectedAccounts.length === 0) errors.push("Select at least one Partner Account.");

  const instructions = values.instructions.trim();
  if (instructions.length > LIMITS.instructions) errors.push(`Partner-specific instructions must be at most ${LIMITS.instructions} characters.`);

  const contentRequirementSummary = values.contentRequirementSummary.trim();
  if (contentRequirementSummary.length > LIMITS.contentRequirementSummary) errors.push(`Content requirement summary must be at most ${LIMITS.contentRequirementSummary} characters.`);

  let requiredCount: number | undefined;
  const rawCount = values.requiredCount.trim();
  if (rawCount.length > 0) {
    const parsed = Number(rawCount);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > LIMITS.requiredCountMax) errors.push(`Required count must be a whole number between 1 and ${LIMITS.requiredCountMax}.`);
    else requiredCount = parsed;
  }

  const formats = parseCommaList(values.formats);
  if (formats.length > LIMITS.formatsMax) errors.push(`At most ${LIMITS.formatsMax} formats.`);
  if (formats.some((format) => format.length > LIMITS.formatLength)) errors.push(`Each format must be at most ${LIMITS.formatLength} characters.`);

  const language = values.language.trim();
  if (language.length > LIMITS.language) errors.push(`Language must be at most ${LIMITS.language} characters.`);

  const hashtags = parseHashtags(values.hashtags);
  if (hashtags.length > LIMITS.hashtagsMax) errors.push(`At most ${LIMITS.hashtagsMax} hashtags.`);
  if (hashtags.some((tag) => tag.length > LIMITS.hashtagLength)) errors.push(`Each hashtag must be at most ${LIMITS.hashtagLength} characters.`);

  const dueAt = values.dueAt.trim();
  // Same representation the Assignment brief already uses everywhere else
  // (seed data, dateLabel): a plain calendar date, YYYY-MM-DD.
  if (dueAt.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) errors.push("Due date must be a valid date.");

  const resourceLinks: Array<{ label: string; url: string; shareExternally: boolean }> = [];
  values.resourceLinks.forEach((row, index) => {
    const label = row.label.trim();
    const url = row.url.trim();
    if (label.length === 0 && url.length === 0) return; // an untouched blank row is simply skipped
    const position = `Resource link ${index + 1}`;
    if (label.length === 0) errors.push(`${position} needs a label.`);
    if (label.length > LIMITS.resourceLabel) errors.push(`${position} label must be at most ${LIMITS.resourceLabel} characters.`);
    if (url.length === 0) errors.push(`${position} needs a URL.`);
    else if (url.length > LIMITS.resourceUrl) errors.push(`${position} URL must be at most ${LIMITS.resourceUrl} characters.`);
    else if (!isHttpUrl(url)) errors.push(`${position} URL must be a valid http(s) URL.`);
    resourceLinks.push({ label, url, shareExternally: row.shareExternally });
  });
  if (resourceLinks.length > LIMITS.resourceLinksMax) errors.push(`At most ${LIMITS.resourceLinksMax} resource links.`);

  if (errors.length > 0) return { ok: false, errors };

  // Optional fields are OMITTED when empty (the server's schema requires
  // min(1) for every present string). No owner field exists anywhere in
  // this payload on purpose: the backend snapshots owner/regions/teams from
  // the Campaign, so an Assignment has no separately-settable owner.
  return {
    ok: true,
    input: {
      campaignRef: args.campaignRef,
      partnerRef: args.partnerRef,
      partnerAccountRefs: args.selectedAccounts.map((account) => account.partnerAccountRef),
      brief: {
        platforms: distinctNormalizedPlatforms(args.selectedAccounts),
        ...(instructions ? { instructions } : {}),
        ...(contentRequirementSummary ? { contentRequirementSummary } : {}),
        ...(requiredCount !== undefined ? { requiredCount } : {}),
        ...(formats.length > 0 ? { formats } : {}),
        ...(language ? { language } : {}),
        ...(hashtags.length > 0 ? { hashtags } : {}),
        ...(dueAt ? { dueAt } : {}),
        ...(resourceLinks.length > 0 ? { resourceLinks } : {}),
      },
    },
  };
}

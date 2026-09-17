import { z } from "zod";

// Step 9A.1: the one shared, domain-neutral platform-identifier contract,
// extracted from Partner Account's own accepted behavior
// (src/server/partners/identity.ts's normalizePlatform - unchanged there,
// now imported from here instead of redefined) so no domain can drift
// from it. Deliberately NOT a closed enum - Partner Account platform
// values have always been free text (bounded, normalized), never a fixed
// catalog, and Campaign must speak the exact same language since it will
// later need to select/match against real Partner Account platforms.
export const MAX_PLATFORM_IDENTIFIER_LENGTH = 60;

export function normalizePlatformIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

// Same raw bound Partner Account's own createPartnerAccountInputSchema
// already applies to `platform` (z.string().min(1).max(60)) - never
// stricter, never looser - plus a post-normalization non-empty check,
// which rejects whitespace-only input (e.g. "   ") that would otherwise
// pass the raw min(1) check but normalize to "". This mirrors Partner
// Account's own REAL effective behavior: computeNormalizedIdentity
// already treats an empty-after-normalization platform as unusable
// (`if (!platform) return null`), just reached via a different error
// path there.
export const platformIdentifierSchema = z
  .string()
  .min(1)
  .max(MAX_PLATFORM_IDENTIFIER_LENGTH)
  .transform((value) => normalizePlatformIdentifier(value))
  .refine((value) => value.length > 0, { message: "Platform cannot be empty or whitespace-only." });

// A bounded array of platform identifiers, each normalized, with
// duplicates (after normalization) REJECTED rather than silently
// dropped - the caller submitted something inconsistent, and this
// surfaces that as an ordinary invalid_input rather than quietly
// discarding what they sent. Used identically for both Campaign's own
// top-level `platforms[]` and its `criteria.platforms` - one shared
// contract, never two representations.
export function platformIdentifierArraySchema(maxItems: number) {
  return z
    .array(platformIdentifierSchema)
    .max(maxItems)
    .superRefine((values, ctx) => {
      const seen = new Set<string>();
      for (const value of values) {
        if (seen.has(value)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate platform "${value}" after normalization.` });
          return;
        }
        seen.add(value);
      }
    });
}

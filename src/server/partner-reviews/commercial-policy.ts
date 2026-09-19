import { z } from "zod";

// Step 13A.1 (revised): the ONE narrow, replaceable seam through which every
// Agreement-governed value reaches Partner Reviews.
//
// There is NO Agreement module yet, and this module must not grow one. So the
// governing commercial policy for a Partner + period comes exclusively from a
// CommercialPolicyProvider, and the DEFAULT provider returns null ("Agreement
// module not built"). With today's data every commercial section is therefore
// honestly `unavailable`. When an Agreement module exists, ONLY the default
// provider below is replaced; nothing in the builder, snapshot, fingerprint,
// redaction or handoff changes.
//
// Hard rules:
//   - Partner Reviews never invents, defaults, edits or manually enters a
//     requirement, count, classification or target. What the policy says is
//     copied verbatim; what it does not say stays null/unavailable.
//   - The policy is data only (no I/O, no functions), versioned, and is fetched
//     by the trusted service exactly like the rest of the evidence: actor-
//     independent, NEVER supplied by a client payload.
//   - A policy that cannot be validated is a contract violation and fails
//     LOUD (throws) - it is never silently degraded to "no policy", because
//     that would hide a payment-affecting Agreement.

// The shape of one target inside a policy. Only "at_least" exists.
const policyTargetSchema = z
  .object({
    targetRef: z.string().min(1).max(200),
    metricId: z.string().min(1).max(100),
    targetValue: z.number().finite(),
    unit: z.string().min(1).max(60),
    comparison: z.literal("at_least"),
  })
  .strict();

// A version document must stay far below Firestore's 1 MiB limit (each
// target carries its provenance refs), so the number of targets is bounded.
export const MAX_POLICY_TARGETS = 12;
export const MAX_POLICY_RULE_FORMATS = 40;

export const governingCommercialPolicySchema = z
  .object({
    agreementRef: z.string().min(1).max(200),
    agreementVersion: z.number().int().min(1),
    monthlyDeliverableRequirement: z
      .object({
        requiredCount: z.number().int().min(0),
        // Deliberately a plain string here: the SUPPORTED units are checked
        // by the pure builder (see QUALIFYING_UNITS in types.ts). A future
        // Agreement module may name a unit this build does not support; that
        // must make the deliverable `unavailable` (unsupported_qualifying_unit),
        // never make review generation throw and never be guessed.
        qualifyingUnit: z.string().min(1).max(100),
        requirementSourceRef: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
    lfcSfcRule: z
      .object({
        ruleRef: z.string().min(1).max(200),
        // Assignment brief `format` value -> class. Matched case-insensitive,
        // exact, after trimming (see the builder).
        byFormat: z.record(z.string().min(1).max(60), z.enum(["LFC", "SFC"])).refine((value) => Object.keys(value).length <= MAX_POLICY_RULE_FORMATS, { message: "Too many formats in one rule." }),
        affectsPayment: z.literal(true),
      })
      .strict()
      .optional(),
    targets: z.array(policyTargetSchema).max(MAX_POLICY_TARGETS).optional(),
  })
  .strict();
export type GoverningCommercialPolicy = z.infer<typeof governingCommercialPolicySchema>;

// (partnerRef, periodKey) -> the governing policy, or null when none governs.
export type CommercialPolicyProvider = (partnerRef: string, periodKey: string) => Promise<GoverningCommercialPolicy | null>;

// The default: no Agreement module exists, so no policy ever governs.
const defaultCommercialPolicyProvider: CommercialPolicyProvider = async () => null;

let providerOverride: CommercialPolicyProvider | null = null;

// TEST-ONLY seam: lets a test prove behavior with a stub policy. It throws
// unless running under a test runner (NODE_ENV=test or VITEST set), so it can
// never change production behavior. Pass null to restore the default provider.
export function setCommercialPolicyProviderForTests(provider: CommercialPolicyProvider | null): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
    throw new Error("setCommercialPolicyProviderForTests may only be called from a test run.");
  }
  providerOverride = provider;
}

export class CommercialPolicyContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommercialPolicyContractError";
  }
}

// The governing policy for one Partner + review period (null = none).
export async function getGoverningCommercialPolicy(partnerRef: string, periodKey: string): Promise<GoverningCommercialPolicy | null> {
  const raw = await (providerOverride ?? defaultCommercialPolicyProvider)(partnerRef, periodKey);
  if (raw === null || raw === undefined) return null;
  const parsed = governingCommercialPolicySchema.safeParse(raw);
  if (!parsed.success) {
    throw new CommercialPolicyContractError(`The governing commercial policy failed validation: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

// The canonical, key-sorted, time-independent identity of everything in a
// policy that can change an evaluated result. Feeds the source fingerprint
// ONLY when a policy exists, so an Agreement version / requirement / rule /
// target change surfaces as refresh / revision available, while a null policy
// leaves the fingerprint exactly as it was before commercial evidence existed.
export function policyFingerprintFacts(policy: GoverningCommercialPolicy) {
  return {
    agreementRef: policy.agreementRef,
    agreementVersion: policy.agreementVersion,
    requirement: policy.monthlyDeliverableRequirement
      ? {
          requiredCount: policy.monthlyDeliverableRequirement.requiredCount,
          qualifyingUnit: policy.monthlyDeliverableRequirement.qualifyingUnit,
          requirementSourceRef: policy.monthlyDeliverableRequirement.requirementSourceRef ?? null,
        }
      : null,
    lfcSfcRule: policy.lfcSfcRule
      ? {
          ruleRef: policy.lfcSfcRule.ruleRef,
          byFormat: Object.entries(policy.lfcSfcRule.byFormat)
            .map(([format, classification]) => [format.trim().toLowerCase(), classification] as const)
            .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1)),
        }
      : null,
    targets: [...(policy.targets ?? [])]
      .map((target) => ({ targetRef: target.targetRef, metricId: target.metricId, targetValue: target.targetValue, unit: target.unit, comparison: target.comparison }))
      .sort((a, b) => (a.targetRef === b.targetRef ? (a.metricId < b.metricId ? -1 : a.metricId > b.metricId ? 1 : 0) : a.targetRef < b.targetRef ? -1 : 1)),
  };
}

// True when the policy asks for the derived follower-growth target (the only
// target that needs channel snapshot records).
export function policyNeedsChannelSnapshots(policy: GoverningCommercialPolicy | null): boolean {
  return (policy?.targets ?? []).some((target) => target.metricId === "followerGrowth");
}

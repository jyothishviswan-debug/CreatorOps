import { z } from "zod";

// Step 13A.1 (revised): the ONE narrow, replaceable seam through which every
// Agreement-governed value reaches Partner Reviews.
//
// This module must not grow an Agreement module. The governing commercial
// policy for a Partner + period comes exclusively from a
// CommercialPolicyProvider. Resolution order (Step 14C):
//   1. the TEST override (setCommercialPolicyProviderForTests, tests only);
//   2. the PRODUCTION-registered provider (registerCommercialPolicyProvider,
//      called ONLY by the server composition module at process start);
//   3. the DEFAULT provider, which returns null (no policy governs).
// With no registered provider every commercial section is honestly
// `unavailable`. Nothing in the builder, snapshot, fingerprint, redaction or
// handoff knows which provider answered.
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

// Step 14C: an overlap is a first-class, NEUTRAL answer. When more than one
// Agreement of the Partner covers the month, the provider does not pick one and
// does not throw: it reports the conflict (sorted, distinct, bounded refs).
// Partner Reviews then shows the commercial evidence as unavailable with a typed
// reason; nothing is merged and nothing is guessed.
export const MAX_POLICY_CONFLICT_REFS = 50;
export const POLICY_CONFLICT_REASON = "multiple_applicable_agreements" as const;
export const commercialPolicyConflictSchema = z
  .object({
    kind: z.literal("conflict"),
    reason: z.literal(POLICY_CONFLICT_REASON),
    agreementRefs: z
      .array(z.string().min(1).max(200))
      .min(2)
      .max(MAX_POLICY_CONFLICT_REFS)
      .refine((refs) => new Set(refs).size === refs.length, { message: "Conflicting Agreement refs must be distinct." }),
  })
  .strict();
export type CommercialPolicyConflict = z.infer<typeof commercialPolicyConflictSchema>;

// (partnerRef, periodKey) -> the governing policy, a conflict, or null when none governs.
export type CommercialPolicyProvider = (partnerRef: string, periodKey: string) => Promise<GoverningCommercialPolicy | CommercialPolicyConflict | null>;

// The default: no provider registered, so no policy ever governs.
const defaultCommercialPolicyProvider: CommercialPolicyProvider = async () => null;

let providerOverride: CommercialPolicyProvider | null = null;

// --- Production registry ---------------------------------------------------------------------
// ONE slot, backed by a Symbol.for() key on globalThis so it is shared even if the bundler gives
// the instrumentation hook and a route bundle their own copy of this module. Re-registering the
// SAME id replaces the provider (idempotent, dev-HMR safe); a DIFFERENT id is a wiring error and
// throws - there is exactly one governing-policy source. Only the server composition module calls
// registerCommercialPolicyProvider.
const REGISTRY_KEY = Symbol.for("creatorops.partnerReviews.commercialPolicyProvider");
type RegisteredProvider = { id: string; provider: CommercialPolicyProvider };
type RegistryHost = { [REGISTRY_KEY]?: RegisteredProvider | null };

function registryHost(): RegistryHost {
  return globalThis as unknown as RegistryHost;
}

export class CommercialPolicyRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommercialPolicyRegistrationError";
  }
}

export function registerCommercialPolicyProvider(entry: RegisteredProvider): void {
  if (!entry || typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 100) throw new CommercialPolicyRegistrationError("A commercial policy provider needs a non-empty id (at most 100 characters).");
  if (typeof entry.provider !== "function") throw new CommercialPolicyRegistrationError("A commercial policy provider must be a function.");
  const current = registryHost()[REGISTRY_KEY] ?? null;
  if (current && current.id !== entry.id) throw new CommercialPolicyRegistrationError(`A different commercial policy provider ("${current.id}") is already registered.`);
  registryHost()[REGISTRY_KEY] = { id: entry.id, provider: entry.provider };
}

// The id of the registered provider (null when none) - for the composition test and diagnostics.
export function getRegisteredCommercialPolicyProviderId(): string | null {
  return registryHost()[REGISTRY_KEY]?.id ?? null;
}

// TEST-ONLY: clears the registered provider so a test file can restore the null default.
export function resetRegisteredCommercialPolicyProviderForTests(): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
    throw new Error("resetRegisteredCommercialPolicyProviderForTests may only be called from a test run.");
  }
  registryHost()[REGISTRY_KEY] = null;
}

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

export type CommercialPolicyResolution = { kind: "none" } | { kind: "policy"; policy: GoverningCommercialPolicy } | { kind: "conflict"; agreementRefs: string[] };

// The governing-policy answer for one Partner + review period: none, one strict policy, or a
// neutral overlap conflict. Every provider answer is schema-validated (an invalid answer is a
// contract violation and throws); a conflict's refs come back sorted.
export async function getGoverningCommercialPolicyResolution(partnerRef: string, periodKey: string): Promise<CommercialPolicyResolution> {
  const provider = providerOverride ?? registryHost()[REGISTRY_KEY]?.provider ?? defaultCommercialPolicyProvider;
  const raw = await provider(partnerRef, periodKey);
  if (raw === null || raw === undefined) return { kind: "none" };

  if (typeof raw === "object" && (raw as { kind?: unknown }).kind === "conflict") {
    const conflict = commercialPolicyConflictSchema.safeParse(raw);
    if (!conflict.success) {
      throw new CommercialPolicyContractError(`The commercial policy conflict failed validation: ${conflict.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
    }
    return { kind: "conflict", agreementRefs: [...conflict.data.agreementRefs].sort() };
  }

  const parsed = governingCommercialPolicySchema.safeParse(raw);
  if (!parsed.success) {
    throw new CommercialPolicyContractError(`The governing commercial policy failed validation: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
  }
  return { kind: "policy", policy: parsed.data };
}

// The governing policy for one Partner + review period (null = none). Kept for callers that can
// only represent a policy: an overlap conflict FAILS LOUD here (it is never degraded to "no
// policy", which would hide a payment-affecting Agreement). The evidence collector uses the
// resolution above and handles the conflict explicitly.
export async function getGoverningCommercialPolicy(partnerRef: string, periodKey: string): Promise<GoverningCommercialPolicy | null> {
  const resolution = await getGoverningCommercialPolicyResolution(partnerRef, periodKey);
  if (resolution.kind === "conflict") throw new CommercialPolicyContractError("More than one applicable Agreement governs this Partner-month; use the resolution API.");
  return resolution.kind === "policy" ? resolution.policy : null;
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

// The fingerprint identity of an overlap conflict (sorted refs). Present ONLY when a conflict
// exists, so resolving it (a policy or nothing) changes the fingerprint, while a Partner with no
// conflict hashes exactly as before.
export function policyConflictFingerprintFacts(conflict: { reason: string; agreementRefs: readonly string[] }) {
  return { reason: conflict.reason, agreementRefs: [...conflict.agreementRefs].sort() };
}

// True when the policy asks for the derived follower-growth target (the only
// target that needs channel snapshot records).
export function policyNeedsChannelSnapshots(policy: GoverningCommercialPolicy | null): boolean {
  return (policy?.targets ?? []).some((target) => target.metricId === "followerGrowth");
}

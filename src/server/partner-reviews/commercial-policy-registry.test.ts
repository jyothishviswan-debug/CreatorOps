import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CommercialPolicyContractError,
  CommercialPolicyRegistrationError,
  MAX_POLICY_CONFLICT_REFS,
  POLICY_CONFLICT_REASON,
  commercialPolicyConflictSchema,
  getGoverningCommercialPolicy,
  getGoverningCommercialPolicyResolution,
  getRegisteredCommercialPolicyProviderId,
  policyConflictFingerprintFacts,
  registerCommercialPolicyProvider,
  resetRegisteredCommercialPolicyProviderForTests,
  setCommercialPolicyProviderForTests,
  type CommercialPolicyProvider,
} from "./commercial-policy";
import { policyConflictSchema } from "./types";

// Step 14C: the PRODUCTION provider registry (the slot the server composition module fills) and the additive
// overlap-conflict contract. Pure - no Firestore. Every test restores the null default.

const POLICY = { agreementRef: "agr-a", agreementVersion: 1 };
const providerReturning = (value: unknown): CommercialPolicyProvider => async () => value as never;

beforeEach(() => {
  resetRegisteredCommercialPolicyProviderForTests();
  setCommercialPolicyProviderForTests(null);
});
afterEach(() => {
  resetRegisteredCommercialPolicyProviderForTests();
  setCommercialPolicyProviderForTests(null);
});

describe("the provider registry", () => {
  it("defaults to null: nothing registered, no override -> no policy governs", async () => {
    expect(getRegisteredCommercialPolicyProviderId()).toBeNull();
    expect(await getGoverningCommercialPolicyResolution("p", "2026-03")).toEqual({ kind: "none" });
    expect(await getGoverningCommercialPolicy("p", "2026-03")).toBeNull();
  });

  it("a registered provider is used (production path) and receives (partnerRef, periodKey)", async () => {
    const calls: Array<[string, string]> = [];
    registerCommercialPolicyProvider({
      id: "test.a",
      provider: async (partnerRef, periodKey) => {
        calls.push([partnerRef, periodKey]);
        return POLICY;
      },
    });
    expect(getRegisteredCommercialPolicyProviderId()).toBe("test.a");
    expect(await getGoverningCommercialPolicyResolution("partner-1", "2026-03")).toEqual({ kind: "policy", policy: POLICY });
    expect(calls).toEqual([["partner-1", "2026-03"]]);
  });

  it("re-registering the SAME id replaces the provider (idempotent, HMR-safe)", async () => {
    registerCommercialPolicyProvider({ id: "test.a", provider: providerReturning({ ...POLICY, agreementVersion: 1 }) });
    registerCommercialPolicyProvider({ id: "test.a", provider: providerReturning({ ...POLICY, agreementVersion: 2 }) });
    registerCommercialPolicyProvider({ id: "test.a", provider: providerReturning({ ...POLICY, agreementVersion: 2 }) });
    expect(getRegisteredCommercialPolicyProviderId()).toBe("test.a");
    expect(await getGoverningCommercialPolicyResolution("p", "2026-03")).toEqual({ kind: "policy", policy: { ...POLICY, agreementVersion: 2 } });
  });

  it("registering a DIFFERENT id throws and leaves the first provider in place", async () => {
    registerCommercialPolicyProvider({ id: "test.a", provider: providerReturning(POLICY) });
    expect(() => registerCommercialPolicyProvider({ id: "test.b", provider: providerReturning(null) })).toThrow(CommercialPolicyRegistrationError);
    expect(getRegisteredCommercialPolicyProviderId()).toBe("test.a");
    expect(await getGoverningCommercialPolicyResolution("p", "2026-03")).toEqual({ kind: "policy", policy: POLICY });
  });

  it("rejects an empty / oversized id and a non-function provider", () => {
    expect(() => registerCommercialPolicyProvider({ id: "", provider: providerReturning(null) })).toThrow(CommercialPolicyRegistrationError);
    expect(() => registerCommercialPolicyProvider({ id: "x".repeat(101), provider: providerReturning(null) })).toThrow(CommercialPolicyRegistrationError);
    expect(() => registerCommercialPolicyProvider({ id: "ok", provider: "nope" as never })).toThrow(CommercialPolicyRegistrationError);
    expect(getRegisteredCommercialPolicyProviderId()).toBeNull();
  });

  it("the TEST override still wins over a registered provider, and clearing it falls back to the registered one", async () => {
    registerCommercialPolicyProvider({ id: "test.a", provider: providerReturning({ ...POLICY, agreementRef: "agr-registered" }) });
    setCommercialPolicyProviderForTests(providerReturning({ ...POLICY, agreementRef: "agr-override" }));
    expect(await getGoverningCommercialPolicyResolution("p", "2026-03")).toMatchObject({ kind: "policy", policy: { agreementRef: "agr-override" } });
    setCommercialPolicyProviderForTests(null);
    expect(await getGoverningCommercialPolicyResolution("p", "2026-03")).toMatchObject({ kind: "policy", policy: { agreementRef: "agr-registered" } });
  });

  it("the slot is a Symbol.for() key on globalThis, so a duplicated module instance still shares it", async () => {
    registerCommercialPolicyProvider({ id: "test.a", provider: providerReturning(POLICY) });
    const slot = (globalThis as unknown as Record<symbol, { id: string } | null>)[Symbol.for("creatorops.partnerReviews.commercialPolicyProvider")];
    expect(slot?.id).toBe("test.a");
  });

  it("a registered provider's output is still schema-validated (an invalid policy is a contract violation, never silently no-policy)", async () => {
    registerCommercialPolicyProvider({ id: "test.a", provider: providerReturning({ agreementRef: "agr-a", agreementVersion: 0, surprise: true }) });
    await expect(getGoverningCommercialPolicyResolution("p", "2026-03")).rejects.toBeInstanceOf(CommercialPolicyContractError);
  });

  it("reset is test-only: it is guarded by the test runner check", () => {
    const previous = { node: process.env.NODE_ENV, vitest: process.env.VITEST };
    try {
      delete process.env.VITEST;
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      expect(() => resetRegisteredCommercialPolicyProviderForTests()).toThrow(/test run/);
    } finally {
      if (previous.vitest !== undefined) process.env.VITEST = previous.vitest;
      (process.env as Record<string, string | undefined>).NODE_ENV = previous.node;
    }
  });
});

describe("the overlap-conflict contract", () => {
  const conflict = (refs: string[]) => ({ kind: "conflict", reason: "multiple_applicable_agreements", agreementRefs: refs });

  it("a conflict answer resolves to {kind:'conflict'} with the refs SORTED, from a registered provider", async () => {
    registerCommercialPolicyProvider({ id: "test.a", provider: providerReturning(conflict(["agr-z", "agr-a", "agr-m"])) });
    expect(await getGoverningCommercialPolicyResolution("p", "2026-03")).toEqual({ kind: "conflict", agreementRefs: ["agr-a", "agr-m", "agr-z"] });
  });

  it("a conflict also resolves through the test override", async () => {
    setCommercialPolicyProviderForTests(providerReturning(conflict(["agr-b", "agr-a"])));
    expect(await getGoverningCommercialPolicyResolution("p", "2026-03")).toEqual({ kind: "conflict", agreementRefs: ["agr-a", "agr-b"] });
  });

  it("the legacy getGoverningCommercialPolicy FAILS LOUD on a conflict (never degraded to 'no policy')", async () => {
    registerCommercialPolicyProvider({ id: "test.a", provider: providerReturning(conflict(["agr-a", "agr-b"])) });
    await expect(getGoverningCommercialPolicy("p", "2026-03")).rejects.toBeInstanceOf(CommercialPolicyContractError);
  });

  it("the conflict schema is strict: two or more DISTINCT refs, bounded, no extra key, the one reason", () => {
    expect(commercialPolicyConflictSchema.safeParse(conflict(["a", "b"])).success).toBe(true);
    expect(commercialPolicyConflictSchema.safeParse(conflict(["a"])).success).toBe(false);
    expect(commercialPolicyConflictSchema.safeParse(conflict([])).success).toBe(false);
    expect(commercialPolicyConflictSchema.safeParse(conflict(["a", "a"])).success).toBe(false);
    expect(commercialPolicyConflictSchema.safeParse(conflict(Array.from({ length: MAX_POLICY_CONFLICT_REFS + 1 }, (_, i) => `agr-${i}`))).success).toBe(false);
    expect(commercialPolicyConflictSchema.safeParse(conflict(Array.from({ length: MAX_POLICY_CONFLICT_REFS }, (_, i) => `agr-${i}`))).success).toBe(true);
    expect(commercialPolicyConflictSchema.safeParse({ ...conflict(["a", "b"]), extra: 1 }).success).toBe(false);
    expect(commercialPolicyConflictSchema.safeParse({ ...conflict(["a", "b"]), reason: "other" }).success).toBe(false);
  });

  it("an invalid conflict answer is a contract violation (throws), not a silent no-policy", async () => {
    registerCommercialPolicyProvider({ id: "test.a", provider: providerReturning(conflict(["only-one"])) });
    await expect(getGoverningCommercialPolicyResolution("p", "2026-03")).rejects.toBeInstanceOf(CommercialPolicyContractError);
  });

  it("the stored snapshot marker schema mirrors the provider contract's reason and bound", () => {
    expect(POLICY_CONFLICT_REASON).toBe("multiple_applicable_agreements");
    expect(policyConflictSchema.safeParse({ reason: POLICY_CONFLICT_REASON, agreementRefs: ["a", "b"] }).success).toBe(true);
    expect(policyConflictSchema.safeParse({ reason: POLICY_CONFLICT_REASON, agreementRefs: Array.from({ length: MAX_POLICY_CONFLICT_REFS }, (_, i) => `r${i}`) }).success).toBe(true);
    expect(policyConflictSchema.safeParse({ reason: POLICY_CONFLICT_REASON, agreementRefs: Array.from({ length: MAX_POLICY_CONFLICT_REFS + 1 }, (_, i) => `r${i}`) }).success).toBe(false);
    expect(policyConflictSchema.safeParse({ reason: "other", agreementRefs: ["a", "b"] }).success).toBe(false);
  });

  it("the conflict fingerprint facts are order-independent", () => {
    expect(policyConflictFingerprintFacts({ reason: POLICY_CONFLICT_REASON, agreementRefs: ["b", "a"] })).toEqual(policyConflictFingerprintFacts({ reason: POLICY_CONFLICT_REASON, agreementRefs: ["a", "b"] }));
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agreementCommercialPolicyProvider } from "@/server/finance-agreements/policy-adapter";
import {
  CommercialPolicyRegistrationError,
  getGoverningCommercialPolicyResolution,
  getRegisteredCommercialPolicyProviderId,
  registerCommercialPolicyProvider,
  resetRegisteredCommercialPolicyProviderForTests,
  setCommercialPolicyProviderForTests,
} from "@/server/partner-reviews/commercial-policy";

import { AGREEMENT_COMMERCIAL_POLICY_PROVIDER_ID, registerAgreementCommercialPolicyProvider, registerServerProviders } from "./register-providers";

// Step 14C: the server composition point. Pure (no Firestore is read: only the REGISTRATION is observed).

beforeEach(() => {
  resetRegisteredCommercialPolicyProviderForTests();
  setCommercialPolicyProviderForTests(null);
});
afterEach(() => {
  resetRegisteredCommercialPolicyProviderForTests();
  setCommercialPolicyProviderForTests(null);
});

describe("registerServerProviders", () => {
  it("starts from the null default, then registers the Agreement commercial-policy provider under its stable id", () => {
    expect(getRegisteredCommercialPolicyProviderId()).toBeNull();
    registerServerProviders();
    expect(getRegisteredCommercialPolicyProviderId()).toBe(AGREEMENT_COMMERCIAL_POLICY_PROVIDER_ID);
    expect(AGREEMENT_COMMERCIAL_POLICY_PROVIDER_ID).toBe("finance-agreements.commercial-policy");
  });

  it("is IDEMPOTENT: calling it repeatedly (dev HMR, a second server instance) never throws and keeps the one provider", () => {
    registerServerProviders();
    registerServerProviders();
    registerServerProviders();
    registerAgreementCommercialPolicyProvider();
    expect(getRegisteredCommercialPolicyProviderId()).toBe(AGREEMENT_COMMERCIAL_POLICY_PROVIDER_ID);
  });

  it("registers exactly the Agreement adapter function (the slot holds the adapter itself)", () => {
    registerServerProviders();
    const slot = (globalThis as unknown as Record<symbol, { id: string; provider: unknown } | null>)[Symbol.for("creatorops.partnerReviews.commercialPolicyProvider")];
    expect(slot?.provider).toBe(agreementCommercialPolicyProvider);
  });

  it("a malformed period is the adapter's own null before any I/O, so the registered path resolves to none without Firestore", async () => {
    registerServerProviders();
    expect(await getGoverningCommercialPolicyResolution("any-partner", "not-a-period")).toEqual({ kind: "none" });
  });

  it("a different provider id already in the slot makes registration fail loudly (one governing-policy source)", () => {
    registerCommercialPolicyProvider({ id: "someone.else", provider: async () => null });
    expect(() => registerServerProviders()).toThrow(CommercialPolicyRegistrationError);
    expect(getRegisteredCommercialPolicyProviderId()).toBe("someone.else");
  });

  it("a test override still wins over the registered production provider", async () => {
    registerServerProviders();
    setCommercialPolicyProviderForTests(async () => ({ agreementRef: "agr-override", agreementVersion: 1 }));
    expect(await getGoverningCommercialPolicyResolution("p", "2026-03")).toMatchObject({ kind: "policy", policy: { agreementRef: "agr-override" } });
  });
});

describe("the composition module (static)", () => {
  const source = readFileSync(path.join(import.meta.dirname, "register-providers.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("registers only through the neutral registry, never through the test-only seams, and never at import time", () => {
    expect(code).not.toMatch(/setCommercialPolicyProviderForTests|resetRegisteredCommercialPolicyProviderForTests/);
    // every registration call sits inside a function body (indented), none at module top level
    expect(code).not.toMatch(/^register[A-Za-z]*\(/m);
  });

  it("documents the extension point for further register*() calls", () => {
    expect(source).toMatch(/REGISTRATION LIST - EXTENSION POINT/);
    expect(source).toMatch(/END REGISTRATION LIST/);
  });
});

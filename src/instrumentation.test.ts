import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGREEMENT_COMMERCIAL_POLICY_PROVIDER_ID } from "@/server/composition/register-providers";
import { getRegisteredCommercialPolicyProviderId, resetRegisteredCommercialPolicyProviderForTests } from "@/server/partner-reviews/commercial-policy";

import { register } from "./instrumentation";

// Step 14C: src/instrumentation.ts is Next's once-per-server-instance hook and the ONLY production caller of the server
// composition point. (That Next actually invokes it in `next dev` / `next start` is a runtime fact proven by the e2e smoke,
// not here.)

const source = readFileSync(path.join(import.meta.dirname, "instrumentation.ts"), "utf8");
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("src/instrumentation.ts (static)", () => {
  it("exports register and imports ONLY the composition module (dynamically, so nothing loads at module evaluation)", () => {
    expect(code).toMatch(/export async function register\(\)/);
    expect(code).not.toMatch(/^\s*import\s/m);
    const dynamic = [...code.matchAll(/import\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]);
    expect(dynamic).toEqual(["@/server/composition/register-providers"]);
    expect(code).not.toMatch(/finance-agreements|partner-reviews|policy-adapter|firebase/);
  });

  it("registers only under the Node.js runtime (the composition reaches firebase-admin, which cannot run on the Edge runtime)", () => {
    expect(code).toMatch(/if \(process\.env\.NEXT_RUNTIME === "nodejs"\)/);
    const guard = code.indexOf('process.env.NEXT_RUNTIME === "nodejs"');
    expect(guard).toBeGreaterThan(-1);
    expect(code.indexOf("registerServerProviders()")).toBeGreaterThan(guard);
    expect(code.indexOf('import("@/server/composition/register-providers")')).toBeGreaterThan(guard);
  });
});

describe("register() at runtime", () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.NEXT_RUNTIME;
    resetRegisteredCommercialPolicyProviderForTests();
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = previous;
    resetRegisteredCommercialPolicyProviderForTests();
  });

  it("on the nodejs runtime it registers the providers (twice is harmless)", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    await register();
    expect(getRegisteredCommercialPolicyProviderId()).toBe(AGREEMENT_COMMERCIAL_POLICY_PROVIDER_ID);
    await register();
    expect(getRegisteredCommercialPolicyProviderId()).toBe(AGREEMENT_COMMERCIAL_POLICY_PROVIDER_ID);
  });

  it("on the edge runtime, or with no runtime set, it registers nothing", async () => {
    process.env.NEXT_RUNTIME = "edge";
    await register();
    expect(getRegisteredCommercialPolicyProviderId()).toBeNull();
    delete process.env.NEXT_RUNTIME;
    await register();
    expect(getRegisteredCommercialPolicyProviderId()).toBeNull();
  });
});

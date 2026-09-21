import { registerFinanceDependencyGuards } from "@/server/composition/finance-dependency-guard";
import { agreementCommercialPolicyProvider } from "@/server/finance-agreements/policy-adapter";
import { registerCommercialPolicyProvider } from "@/server/partner-reviews/commercial-policy";

// Step 14C: the SERVER COMPOSITION POINT - the one place where modules that must not know each other are
// wired together at process start. src/instrumentation.ts (Next's once-per-server-instance hook) is the only
// production caller of registerServerProviders().
//
// Rules of this folder:
//   - it is the ONLY production code that imports the Finance Agreement policy adapter;
//   - the modules it wires stay ignorant of each other: Partner Reviews exposes a neutral registry
//     (partner-reviews/commercial-policy.ts) and never imports anything Agreement / Finance shaped;
//   - every register*() below is IDEMPOTENT (an id-based replace) so a repeated call - dev HMR, a second
//     server instance in one process, a test - is harmless.

// The stable id of the Agreement-backed commercial policy provider. Re-registering the same id replaces; a
// different id for the same slot throws (there is exactly one governing-policy source).
export const AGREEMENT_COMMERCIAL_POLICY_PROVIDER_ID = "finance-agreements.commercial-policy";

export function registerAgreementCommercialPolicyProvider(): void {
  registerCommercialPolicyProvider({ id: AGREEMENT_COMMERCIAL_POLICY_PROVIDER_ID, provider: agreementCommercialPolicyProvider });
}

export function registerServerProviders(): void {
  // ==== REGISTRATION LIST - EXTENSION POINT =====================================================================
  // One idempotent register*() call per provider / guard, in dependency-free order. Add new lines here (and
  // import the function above); do not register anything from module top-level code or from a route.
  registerAgreementCommercialPolicyProvider();
  registerFinanceDependencyGuards();
  // ==== END REGISTRATION LIST ===================================================================================
}

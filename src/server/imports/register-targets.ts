import { registerAnalyticsImportTarget } from "@/server/analytics/import-service";
import { registerContractBundleImportTarget } from "./contract-bundle-import";

// Step 12A / Import Center Completion: registers every real Import
// Center target - imported for its side effect wherever a route needs
// the registry populated (see src/app/api/imports/*/route.ts).
// Idempotent - calling this more than once simply re-registers the same
// entries.
export function registerImportTargets(): void {
  registerAnalyticsImportTarget();
  registerContractBundleImportTarget();
}

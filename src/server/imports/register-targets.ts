import { registerAnalyticsImportTarget } from "@/server/analytics/import-service";

// Step 12A: registers every real Import Center target. Analytics is the
// first and, for now, the only one - imported for its side effect
// wherever a route needs the registry populated (see
// src/app/api/imports/dry-run/route.ts). Idempotent - calling this more
// than once simply re-registers the same entries.
export function registerImportTargets(): void {
  registerAnalyticsImportTarget();
}

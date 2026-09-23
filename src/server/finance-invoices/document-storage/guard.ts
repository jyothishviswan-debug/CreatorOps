// Step 16A: the LIVE-BACKEND GUARD, identical discipline to Agreements' own document-storage/
// guard.ts (a deliberately tiny standalone module with no imports, so every caller consults the
// same predicate). No live backend exists behind this port yet (see index.ts), but the guard is
// defined now so a future adapter can reuse it exactly like Agreements' own.
export function isAutomatedTestRun(): boolean {
  return process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
}

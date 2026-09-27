# CreatorOps continuity

Status: Whole-Product Integration Closure is **BLOCKED BY CONFIRMED MASTER-SCOPE GAPS** (see "Confirmed master-scope gaps").
This is a truth-reconciliation record, not a production-readiness claim. Nothing has been pushed, deployed, or run against live Firebase, real Drive, or any external provider.

Base: local `main` @ `6f907b2`; integration branch `whole-product-integration` (see `git log` for the closure commit).

## Module status (against source, not against the master)

| Module | State |
| --- | --- |
| Foundation / Auth / Administration | Closed |
| Discovery, Partners (+Accounts), Vendors | Closed |
| Campaigns, Assignments, Content | Closed |
| Analytics (+ Import Center for Analytics uploads) | Closed |
| Partner Reviews | Closed |
| Finance: Agreements, Payables, Invoices, Payments | Closed (text-PDF extraction only; no OCR) |
| Operations: Tasks, Approval Queue, Reminders | Closed; target labels now resolve to display names through the owning modules' gated getters |
| Reports | 13 governed reports + immutable `reportSnapshots`; no narrative / versioning / Report-owned artifacts |
| Export Center | 3 targets (partners, campaigns, assignments); CSV/XLSX/PDF; jobs; Storage-emulator artifacts |
| Import Center | One target (Analytics); dry-run -> explicit execute; batch idempotency claim; per-row outcomes |
| Notes / Meetings / MoM | **Absent** (only "Not yet built" dialogs in Assignment/Content detail) |
| Notifications | **Absent** (topbar bell is now an honestly disabled control) |
| OCR | **Absent** (scanned/image-only PDFs -> MANUAL_REVIEW_REQUIRED) |
| Global search | **Absent** (topbar trigger is now an honestly disabled control) |

## Confirmed master-scope gaps (each blocks closure)

1. Notes / Meetings / MoM / action items and explicit MeetingActionItem -> OperationsTask promotion: no collections, services, routes or DTOs exist under `src/server/**`.
2. Recipient-scoped Notifications: no subsystem; the topbar bell was inert.
3. Reports final-master model: `reportSnapshots` are immutable evidence snapshots only. Missing: editable grounded narrative sections, Draft / In Review / Finalized / Superseded lifecycle, correction by new version, Report-owned PDF/XLSX/CSV artifacts (Export Center is not a substitute; it exports three Partner/Campaign/Assignment tables).
4. OCR (mandatory pre-launch): insertion point is the no-text branch of `src/server/finance-invoices/extraction/pipeline.ts` (and the restricted-evidence path in `finance-invoices/payee-identity/restricted-extraction.ts`), server-side only, local engine, no external provider, behind the existing sensitive-access boundaries.

## Import Center vs master
Implemented: 10 MB file cap, 5000 rows, 20 sheets, macro rejection, dry-run then explicit execute, batch-level idempotency, per-row outcomes, target-specific authorization. Not present: decompressed-size cap, quarantine/resume, any second adapter (e.g. contract bundle). Classified as hardening / deferred adapters, not a closure blocker on their own.

## Closed architecture decisions
- Authorization is explicit grants only (FeatureAccess, ActionPermission, RecordScope, SensitiveAccess, LifecyclePreconditions); no role ranking, wildcard or minimumRole.
- Operations never owns source lifecycle; Approval Queue is a derived read model; Reports never mutate sources; Export re-authorizes against source scope.
- Partner Review keeps Production / Compliance / Performance separate; no synthetic score; missing evidence is never zero.
- Overview (`src/app/dashboard/page.tsx`, `src/ui/Overview.tsx`, `src/ui/overview.css`) is frozen.

## Integration-stage findings and fixes
- `routes.spec.ts` 3 failures: root cause was the Playwright `setup` project regex `/auth\.setup\.ts/` also matching `exports-auth.setup.ts`, which reset the emulator after the shared admin sign-in and silently signed every later test out (the sign-in page returns 200, has an `<h1>`, and never shows "Access denied"). Not a product defect; not-found/authz behavior is correct. Fixed by anchoring the match and deleting the orphan setup file; the static-route test now also asserts no redirect.
- `emulator-reset.ts` now also wipes Finance Payables/Invoices/Payments, Operations, Reports and Exports collections (create-only claim docs leaked across runs).
- Agreement fixture drift (contentObligations / monetisationTerms; policy target period/anchor) fixed in test expectations only.
- `PartiesKycStep.tsx` static-guard false positive (Agreement party role, not an auth role) removed by destructuring, guard unchanged.
- Campaign "no Finance collection" guard now exempts exactly the closed Finance roots that other test files create concurrently; unknown Finance-shaped roots still fail.

## Known debt (short list)
- Full-suite contention flake: e.g. `onboarding.emulator.test.ts` "IN_PROGRESS" under parallel load, passes 42/42 in isolation. Playwright under parallel workers on a single emulator shows timeouts; see regression totals.
- Topbar "ILLUSTRATIVE DATA" pill is still shown (golden-master artifact); needs a product decision.
- Approved neutral "not yet available" KPI slots remain by design.

## Hardening backlog (not done here)
Production-scale query measurement; decompressed-size limits for imports; retention/encryption review of restricted evidence; edge/WAF/rate limiting; real Drive activation; monitoring; backup/restore; staging.

## Next stages (each a blocker)
1. Notes / Meetings / MoM + MeetingActionItem -> OperationsTask promotion.
2. Notifications (in-app, recipient-scoped, deduplicated, deep-linked, re-authorized on open).
3. Reports narrative / versioning (Draft, In Review, Finalized, Superseded) / Report-owned artifacts.
4. OCR for Invoice (and Agreement) extraction, server-side, no external provider.
Then: Production Hardening.

## Regression totals
See the closure report for the exact run numbers; they are recorded in the commit message body.

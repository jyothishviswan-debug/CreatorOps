# CreatorOps continuity

Status: Whole-Product Integration Closure is **BLOCKED BY CONFIRMED MASTER-SCOPE GAPS** (see "Confirmed master-scope gaps").
This is a truth-reconciliation record, not a production-readiness claim. Nothing has been pushed, deployed, or run against live Firebase, real Drive, or any external provider.

Base: local `main` @ `6f907b2`; integration branch `whole-product-integration` (see `git log` for the closure commit).

**Import Center Completion stage** (this update): started from local `main` @ `43db934`, worked in worktree branch `import-center-completion` (see `git log` on that branch for the exact commit(s) - starts with `Import Center Completion`). Not fast-forwarded into `main` by this stage - that is the supervising session's own step. No push, no deploy, no live Firebase, no real Drive, no external OCR/provider call.

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
| Import Center | **Completed this stage.** Two targets (Analytics, contract-bundle) on one governed registry substrate; full Choose Data → Upload → File/Sheet Preview → Mapping (conditional) → Validation & Diff/Review → Import → Results → History/Provenance UX; classified error taxonomy; quarantine + resume; decompression/cell-size limits. See "Import Center Completion (this stage)" below. |
| Notes / Meetings / MoM | **Absent** (only "Not yet built" dialogs in Assignment/Content detail) |
| Notifications | **Absent** (topbar bell is now an honestly disabled control) |
| OCR | **Absent** (scanned/image-only PDFs -> MANUAL_REVIEW_REQUIRED) |
| Global search | **Absent** (topbar trigger is now an honestly disabled control) |

## Confirmed master-scope gaps (each blocks closure)

1. Notes / Meetings / MoM / action items and explicit MeetingActionItem -> OperationsTask promotion: no collections, services, routes or DTOs exist under `src/server/**`.
2. Recipient-scoped Notifications: no subsystem; the topbar bell was inert.
3. Reports final-master model: `reportSnapshots` are immutable evidence snapshots only. Missing: editable grounded narrative sections, Draft / In Review / Finalized / Superseded lifecycle, correction by new version, Report-owned PDF/XLSX/CSV artifacts (Export Center is not a substitute; it exports three Partner/Campaign/Assignment tables).
4. OCR (mandatory pre-launch): insertion point is the no-text branch of `src/server/finance-invoices/extraction/pipeline.ts` (and the restricted-evidence path in `finance-invoices/payee-identity/restricted-extraction.ts`), server-side only, local engine, no external provider, behind the existing sensitive-access boundaries.

## Import Center Completion (this stage)

Accepted local SHA: see `git log` on branch `import-center-completion` (first commit message starts `Import Center Completion`), based on `main @ 43db934`.

**Substrate**: one governed registry (`src/server/imports/target-registry.ts`, unchanged contract, extended with an optional generic `rows`/`rowsTruncated` field and a shared `ImportAdapterError` for classified-error propagation through the generic dispatch path). `src/app/api/imports/dry-run` and `/execute` still call the Analytics service directly (precise, pre-existing error-code mapping) and dispatch through `getImportTarget()` for any other registered module - proven with two real targets, not a hypothetical single-target registry.

**Adapters** (`listImportTargets()` after `registerImportTargets()`):
- `analytics` - preserved, extended (below). Preserved without behavior change: deterministic row-identity matching, batch-level source-hash idempotency, Content/Partner-Account matcher contracts, `ANALYTICS_ROW_CLASSIFICATIONS` (all nine original values still mean exactly what they meant).
- `contract_bundle` - new. Bulk Partner/Vendor + one Partner Account + Agreement-draft-to-be, one row per bundle, via `src/server/imports/contract-bundle-import.ts`. Every mutation goes through the EXISTING `createCounterpartyFromOnboarding` (Step 14B.1) - no bespoke Partner/Vendor/Agreement write anywhere in this file. Deliberate, documented scope decisions for this stage: (1) one Partner Account per row; (2) NO restricted/KYC/payee-identity columns at all - a sheet with any PAN/Aadhaar/GST/bank/IFSC/UPI/passport/KYC-looking header is rejected wholesale (`RESTRICTED_FIELD_REJECTED`) before a single row is read; KYC continues to be captured afterward, per Agreement, through the existing `SecureKycDialog`/KYC service, never through this bulk path; (3) no bundle-specific resume endpoint - each row's own onboarding step-ledger is already resumable by re-executing the same bundle (same deterministic row `clientRequestId`), so a second resume mechanism would only duplicate that orchestration; (4) a likely-duplicate row is never force-created - it is reported (`AMBIGUOUS`) for the actor to resolve through the ordinary, interactive Agreement-led onboarding screen, which can supply the acknowledgement + reason a STRONG duplicate needs; a bulk import never supplies that on the actor's behalf.
- Intentionally unsupported / future adapters (classified during inspection, not built): Payables/Invoices/Payments bulk import, Operations Task/Reminder bulk import, Vendor-only bulk roster import. None of these had a real, working minimal implementation to extend (unlike Analytics/contract-bundle); adding them now would be "arbitrary targets just to increase the count," which the spec explicitly warns against.

**Governed UX** (`src/features/imports/ImportCenterTabs.tsx` -> `ImportCenterWizard.tsx` + `ImportHistoryPanel.tsx`, replacing the prior bare `ImportCenterPanel.tsx`): Choose Data → Upload (drag/drop + picker, remove/replace, exact accepted types) → File/Sheet Preview (`/api/imports/preview`, bounded sample rows, duplicate/empty header + trailing-blank-row detection, all read-only) → Mapping (conditional - shown only when a sheet is unrecognized or has ignored columns; an unrecognized sheet blocks with an actionable message, since this stage does not implement free-form column remapping - see scope note below) → Validation & Diff/Review (bounded per-row detail, outcome-group counts, mandatory acknowledgement checkbox, Import disabled until acknowledged AND the file is unchanged since review) → Import (explicit, re-authorizes/re-validates server-side regardless of the client's own prior dry-run) → Results (counts, row outcomes, inline resume prompt when rows are quarantined) → History (`/api/imports/batches`, module-aware, attempt history, resume from a quarantined batch).

**Scope decision - Mapping is informational, not a free-form remapper**: the existing Analytics adapters recognize a sheet by matching a FIXED set of header aliases per platform template (all-or-nothing per sheet), not by letting an actor redirect an arbitrary column to an arbitrary canonical field. Building true drag-and-drop column remapping would mean re-engineering those adapters' matching contracts - a materially larger, higher-regression-risk change than this stage's budget allows, and not required to satisfy "mapping only when needed" (an unrecognized sheet is the one real case that needs a decision, and the correct, safe decision there is "fix the source file and re-upload," not "let the browser guess a mapping the server never validated"). The Mapping step is real (it shows exactly what was recognized/ignored and blocks progress on a real problem) but does not accept a redirected mapping.

**Error taxonomy** (`src/server/imports/error-taxonomy.ts`): FILE / STRUCTURE / ROW / AUTHORIZATION / SYSTEM, each with a `correctable` flag; used by the generic dispatch routes for `ImportAdapterError`, and by the client (`src/features/imports/api-client.ts`, `copy.ts`) to render a category-labeled banner instead of a generic failure. Every branch is a closed-list reason code with a hand-written safe message - nothing here ever formats a caught exception's own text.

**Hard limits** (`src/server/imports/file-safety.ts`, enforced in `src/server/analytics/xlsx-parser.ts`, shared by both adapters): `MAX_IMPORT_FILE_BYTES` 10 MB, `MAX_IMPORT_ROWS_PER_BATCH` 5000, `MAX_IMPORT_SHEETS_PER_FILE` 20 (all pre-existing, unchanged), plus new `MAX_IMPORT_CELL_CHARS` 20,000 and `MAX_IMPORT_DECOMPRESSED_CHARS` 25,000,000 (a running total of every character read out of every cell, across every sheet - the decompression-bomb defense; `parseWorkbookBuffer`'s new `includeBlankRows` option defaults to `false`, preserving the Analytics pipeline's existing blank-row-skip behavior exactly, and is opted into only by the generic preview module).

**Partial success / quarantine / resume** (Analytics): a per-row COMMIT failure (never a validation failure) is classified `quarantined` - a genuinely new, tenth `AnalyticsRowClassification` value (the spec's own explicit allowance for a state the original nine didn't cover). `resumeAnalyticsImportBatch` (new, `src/server/analytics/import-service.ts`) retries only quarantined rows, under the SAME `batchRef` (never a new batch), re-authorizes and re-validates via the exact same `runAnalyticsImportPipeline`/`commitContentRow`/`commitChannelRow` execute uses, requires the actor re-upload the exact same source file (sourceHash checked), and is resumable from either `COMPLETED_WITH_ERRORS` or `FAILED` (a batch where every row quarantined is `FAILED`, not `COMPLETED_WITH_ERRORS`, since zero rows succeeded - both are resumable as long as `quarantinedRows > 0`). `AnalyticsImportBatchDoc` gained `quarantinedRows`, `attempts`, `attemptHistory[]` (all `.default()`-backed, so every pre-existing batch doc still parses). Proven end-to-end against the real emulator with a test-only fault-injection seam (`setAnalyticsCommitFaultHookForTests`, same idiom as onboarding's own `setOnboardingFaultHookForTests`) - see `src/server/analytics/import-resume.emulator.test.ts`. contract-bundle's own "resume" is the existing per-row onboarding step-ledger (re-executing the same bundle resumes any row that didn't finish) - no second mechanism was added, by design (see adapter scope note above).

**Idempotency**: Analytics batch-level source-hash claim (pre-existing, unchanged, still proven) plus row-level identity-key dedup; contract-bundle row-level via the onboarding ledger's own `clientRequestId` fingerprint (deterministic per `sha256(sourceHash:sheetName:rowNumber)`), so re-running the exact same bundle file is a safe no-op replay, never a duplicate Partner/Vendor/Agreement.

**Authorization**: Analytics unchanged (`requireImportsModuleAccess` + `requireAnalyticsManageAccess`, Analyst-only among non-Super-Admin roles). contract-bundle reuses the exact same two-gate shape - `requireImportsModuleAccess` (generic Import Center module gate) AND `requireFinanceAgreementsAccess(actor, "manage_agreements")` (target-specific) - proven with an explicit-grant-only actor (no seeded role holds both by default; the emulator suite grants `imports:manage_imports` as an explicit override on top of `partnership_manager`'s existing `finance:manage_agreements`, which is itself the "grants, not roles" proof the spec asks for) plus two denial cases (finance access without imports access; imports access without finance access). Row-level create rights (`partners:create`/`vendors:create`/`partners:manage_partner_accounts`) are the EXISTING onboarding gate's own checks, re-run unchanged.

**Sensitive data**: contract-bundle rejects any restricted-looking column wholesale (never maps, never stores, never previews/diffs it); Analytics carries no restricted/KYC data by design (unchanged). No batch/history record for either adapter ever stores a restricted value. No raw Firebase error, stack trace, auth uid, or raw doc id reaches an HTTP response or the client, by construction of the error-taxonomy layer.

**Deferred / honestly scoped down**: free-form column remapping (Mapping step is informational-only - see above); a bundle-level batch-hash idempotency claim analogous to Analytics's own (row-level idempotency via the onboarding ledger covers the correctness property; a batch-level claim would be a nice-to-have, not added given the time budget); a dedicated contract-bundle "resume" endpoint (unnecessary - see above); Playwright coverage of the contract-bundle happy-path creation flow through the browser (covered at the service layer by `contract-bundle-import.emulator.test.ts`; the E2E suite covers its authorization-denial path through the real UI, not its full creation path, given the time budget).

**Remaining master-scope blockers**: unchanged by this stage - see "Confirmed master-scope gaps" above. This stage does not claim Export Center, Notes/Meetings, Notifications, Reports final-master scope, or OCR complete.

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
Production-scale query measurement; retention/encryption review of restricted evidence; edge/WAF/rate limiting; real Drive activation; monitoring; backup/restore; staging. (Decompressed-size limits for imports were closed in the Import Center Completion stage - see that section above.)

## Next stages (each a blocker)
1. Notes / Meetings / MoM + MeetingActionItem -> OperationsTask promotion.
2. Notifications (in-app, recipient-scoped, deduplicated, deep-linked, re-authorized on open).
3. Reports narrative / versioning (Draft, In Review, Finalized, Superseded) / Report-owned artifacts.
4. OCR for Invoice (and Agreement) extraction, server-side, no external provider.
Then: Production Hardening.

## Regression totals

Pre-existing totals: see the closure report for the whole-product numbers as of `43db934`.

**Import Center Completion stage** (this update, run from worktree `import-center-completion`):
- `tsc --noEmit`: clean.
- `eslint .`: clean.
- Unit (`vitest run`): 3801/3801 passed, 266 files (baseline was 3762; +39 new/updated, no removals).
- Focused emulator (`vitest run --config vitest.emulator.config.mts`, targeted files): `analytics.emulator.test.ts` 22/22, `onboarding.emulator.test.ts` 42/42, `import-resume.emulator.test.ts` (new) 6/6, `contract-bundle-import.emulator.test.ts` (new) 7/7.
- Full emulator regression (same config, whole suite, private ports, three consecutive full runs to isolate flakes): 1147/1147 passed on two of three runs; the third run's two failures (`administration.emulator.test.ts` sensitive-grant test, `finance-agreements/onboarding.emulator.test.ts` fault-hook-timing test) each re-ran clean in isolation immediately after - the documented load-contention-flake class, appearing in different files than previously observed (exactly as the class was described - it moves), not a regression from this stage's changes. The pre-existing `emulator-reset.ts` wipe fix (Payables/Invoices/Payments/Operations/Reports/Exports) was NOT touched and remained in effect throughout (confirmed by the full-suite passes).
- Playwright: `tests/e2e/imports.spec.ts` (rewritten for the new UI) 17/17 - flagship flow (Choose Data→...→History), malformed file, unrecognized sheet/Mapping block, invalid row, duplicate-identity recognition, correction/re-upload, partial success, Viewer denial, contract-bundle authorization denial, and all six certified widths (1440/1200/1050/760/390/375) with a no-horizontal-overflow assertion through Upload→Preview→Review. `tests/e2e/authorization.spec.ts` + `tests/e2e/routes.spec.ts` (cross-module, Import-Center-adjacent): 50/50, unaffected. The full E2E suite (every other module's own specs) was not re-run in this stage given the time budget - none of those specs' own source areas were touched.
- Overview: `src/app/dashboard/page.tsx`, `src/ui/Overview.tsx`, `src/ui/overview.css` untouched by this stage (no diff).
- Config/port/PID hygiene: `.env.local` (gitignored, not committed) and `firebase.json`/`playwright.config.ts` were pointed at private ports (19099/18080/19199/13100) for this stage's own emulator/Playwright runs, then restored byte-for-byte before this stage's commit - not an independently-justified fix, a straight revert. Every emulator/dev-server process started by this stage was stopped by its own exact PID (never a broad kill).

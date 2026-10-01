# Real-Data Pilot — UI/Logic Findings

Collected during the live, real-data pilot run for Mrinal Jha (Discovery Lead → Partner → Finance
Agreement → Campaign), 2026-09-29. These are observational findings surfaced while driving the real
app end-to-end with real data — not implemented yet except where marked **[FIXED]**. Working list,
most-recent additions at the bottom of each section; not yet prioritized.

**When resolving any item below:** implement the real, proper fix described in that finding — never a
workaround, patch-around, or bypass that only clears the immediate symptom. Every **[FIXED]** entry
below should mean the underlying cause was actually addressed (with real verification: typecheck,
lint, tests, and a live re-check against real data), not that a specific instance was worked around.

## Fixed during the pilot

1. **[FIXED]** Discovery-stage KYC/Restricted Identity data was not migrated to the Partner's
   Restricted Identity record on conversion (`src/server/discovery/conversion-service.ts`). Fixed:
   the conversion transaction now reads the Lead's KYC doc and writes it into the Partner's
   `restrictedFinancialIdentities` record in the same transaction. Backfilled for the one pilot
   record (`e6a41140-36a5-42a9-b508-51e0b499bd74`) that converted before the fix landed, using the
   same schema/collection helpers (not a parallel reimplementation).
   - **Broader principle (not yet fixed):** any field captured at Discovery that has a real
     corresponding Partner field should carry forward automatically on conversion, not just KYC.
     Confirmed also dropped today: **Manager assignment** (no equivalent field exists on `PartnerDoc`
     at all — may need adding), and **Notes & meetings** (kept keyed to the Discovery Lead's own
     `ownerRef`, never re-associated to the new Partner even though `originLeadRefs` links back).

## Discovery — Agreement / Commercial evidence forms

2. The "confirmed" checkbox on Agreement evidence and Commercial/Negotiation evidence forms is
   intentional (a genuine draft-vs-confirm gate — the surrounding "prepare ahead of time" vs "saved
   evidence" copy depends on it), but it silently doesn't respond to programmatic `value` assignment
   the way normal inputs do — only a real click toggles it. Worth a UI-automation/accessibility look
   independent of whether the gate itself is right.
3. Once a stage's evidence is saved/confirmed, it should render as a **read-only summary with an
   "Edit" button** — matching the Lead tab's existing "Edit lead" convention — instead of leaving the
   full editable form open underneath the summary with its own always-active Save button. Confirmed
   recurring on **both** Discovery (Agreement, Commercial) and Partner (Restricted Identity) panels;
   needs a systematic audit across every stage panel in both domains, not a one-off fix.

## Discovery — KYC

4. Restricted KYC "Email" field doesn't pre-fill from the Lead's already-known email even though it's
   already on file.
5. KYC document-upload field doesn't reset when switching the document-type selector — the previous
   file/attachment stays shown for the newly selected type. Confirmed also present on the Partner's
   Restricted Identity → Document evidence panel: an already-evidenced document type still shows its
   upload/add-link control as if nothing were attached yet.
6. Attached KYC files render as plain text (`docType · filename`), not a real attached-file UI
   element. Should reuse the Finance Agreement module's document UI throughout — its upload control
   *and* its "Open Agreement document" button pattern for viewing an already-stored file — instead of
   plain text with no open affordance.

## Discovery — Outreach & Negotiation

7. "Channel" should be a dropdown (Email, WhatsApp, Instagram, Facebook, YouTube, etc.), not free
   text.
8. The tab's "contact timestamp is always server-captured" disclaimer is orphaned copy — the form has
   no timestamp field anywhere for it to refer to.
9. No way to view past outreach attempts individually — only a rolled-up "Attempts logged: N / Last
   contact: ..." summary, no per-attempt log/list view.
10. Simplify: drop the Inbound/Outbound Direction distinction, just Channel / Discussion / Outcome —
    doesn't map cleanly to how contact actually happens.
11. The "meaningful response" readiness blocker is invisibly tied to `Direction: Inbound` with no
    explicit UI signal that this is what satisfies it — there's no actual "response received"
    checkbox, just an inferred computation from a dropdown value. Confusing; consider an explicit
    indicator instead.

## Discovery — Lead / Owner

12. Lead "Owner" (`ownerUid`) can only ever be set once, at Lead creation, via an optional field — no
    edit/assign path exists afterward, unlike "Manager" which has a proper assign/remove UI on the
    Manager & KYC tab.
13. Owner should default to whoever created the Lead (`createdByUserRef`) rather than requiring a
    separate, never-editable-later selection.

## Discovery — Asset Setup / Conversion

14. The Convert-to-Partner confirmation dialog prints the raw backend enum for Asset decision (e.g.
    `TRANSFER_AND_MAINTAIN`) instead of the human-readable label used on the Asset Setup form itself
    (`ReadyConvertedStages.tsx:242`).
15. Real validation gap: saving an Asset decision of `MAINTAIN_EXISTING` / `TRANSFER_AND_MAINTAIN`
    with `existingPartnerAccountRef` empty succeeds silently even though `lead-service.ts:525`
    explicitly requires it for any non-`NEW_ACCOUNT` decision — the resulting confusing error ("The
    referenced existing Partner Account no longer resolves") only surfaces later, at conversion time.
16. Asset Setup's three options (New Account / Maintain Existing / Transfer & Maintain) should be
    redefined around **who owns/operates the account going forward** — new / creator keeps and
    operates it themselves / ownership transferred to the company — decoupled from whether an
    internal Partner Account record happens to already exist in CreatorOps. Right now
    `existingPartnerAccountRef` only means "an internal CreatorOps Partner Account record that
    already exists," which can never be true for a first-time onboarding regardless of which option
    is semantically correct for the real relationship.
17. On successful conversion, auto-navigate to the new Partner page instead of requiring an explicit
    click on the "Partner reference" link inside the success dialog.

## Partner — Accounts

18. "Create account" form's Platform field doesn't pre-fill from the Discovery Lead's already-
    confirmed Platform (shown blank with just placeholder text).
19. Platform field is free text instead of the same closed dropdown used on the Discovery Lead edit
    form (Instagram / YouTube / Other) — inconsistent, should match.
20. Reorder the form so Profile URL comes right after Platform (before Handle), and have entering the
    Profile URL auto-derive/auto-fill Handle by parsing it, instead of requiring both separately.
    Likely the same gap exists on the Discovery Lead edit form.
21. Only "Platform" is actually required on this form (`required` in code), but nothing in the UI
    signals that Display name / Follower count / Profile URL / Stable platform account id are
    optional — needs visual "(optional)" labeling. Follower count is meant to come from a real
    Analytics sync once that exists, not manual entry — leaving it blank for a brand-new account is
    correct, not a gap.

## Finance — New Agreement wizard

22. "Party & Source" cards (Instagram Partner / YouTube Partner / Instagram + YouTube Partner /
    Vendor) render oversized with excess padding/whitespace.
23. "Collaborator" terminology is used only on the "Platform & page" review tab ("collaborator page
    link/name") — inconsistent with "Partner"/"account" used everywhere else in the app.
24. "Collaborator page name" field is consistently empty for real accounts (mirrors the empty Display
    Name gap on Partner Accounts) — consider dropping it or deriving it from the Partner Account's
    own display name.
25. Contact details / Platform & page comparison tables have severe horizontal overflow — the
    "Status" and "Action" columns (including "Enter corrected value," the actual control for fixing a
    missing field like Contact number) are pushed off-screen, ~15 scroll-ticks away. The capability
    exists but is practically undiscoverable.
26. Contact number should be a mandatory field on Discovery Lead and Partner forms so it can't stay
    unset all the way through to Agreement extraction.
27. The Partner Accounts table on the "Parties & KYC" step only shows Platform + Scope (e.g.
    "Instagram | Specific account"), not the actual linked account identity (handle/profile URL) —
    should show it so the right account being linked is visibly confirmable.
28. "Terms & Targets" step layout needs rework — inconsistent card sizing, several fully-empty cards
    (Account transfer fee, Advance payment) taking as much visual space as populated ones.
29. The "Qualifying unit" card's header text overflows/clips above the card boundary; the card itself
    appears to extend past its grid column.
30. "Qualifying unit" dropdown lacks an option for count-based short-form video content (Reels) — only
    "Approved Content" and "Approved current link" exist, neither a precise match for a real
    monthly-count deliverable like Mrinal's Agreement (20 short-format Instagram content/month).
    Selected "Approved Content" as the closer match for this pilot; the taxonomy itself needs fixing.
31. "Create Agreement" should automatically trigger the Drive document-storage attempt right after a
    successful confirm (still its own independent, retryable operation under the hood — just
    auto-fired instead of requiring a separate manual "Store Agreement document" click). Also: the UI
    should explain *why* document storage is deliberately deferred to post-confirmation (protects
    against writing to the real external Drive record for a still-mutable draft) — right now it just
    reads as an incomplete/pending state with no rationale.

## Campaigns — New Campaign form

32. Remove the "Categories" field/column from the Campaign creation form entirely — not needed.
33. **Real bug:** "End date" is silently `required` in the DOM (`input[type=date].required === true`)
    with **no visual "Required" indicator** anywhere in the UI, unlike every other genuinely-required
    field in the app (which explicitly shows "Required" text next to the label, e.g. "Currency
    Required when any amount is present"). Leaving it blank keeps "Create campaign" permanently
    disabled with **zero visible error message** — a real silent-failure trap, not just a missing
    "Required" label. Either make End date genuinely optional (matching its UI presentation) or add
    the same "Required" labeling every other required field gets.
34. "Targeting platforms" (in the Targeting section) asks for platform info again even though
    "Platforms" was already set above in Campaign basics — redundant, same data asked twice.
35. Rework the "Create a campaign" (and likely other creation forms) layout — move the static tips
    panel ("A cleaner first step") to a compact banner at the top, use the full page width, and
    arrange related fields in a two-column layout instead of stacking everything in one narrow
    column. Not just cosmetic: the current excessive page height pushes the submit button ~1600px
    down, which made it genuinely hard to reliably click during this pilot.
36. Campaign Resources should support real file upload to a Drive folder named after the Campaign
    (mirroring the KYC/Agreement Drive-folder pattern) — currently it's link-only, explicitly "No
    file upload, no restricted content." This is the correct fix for attaching real reference
    documents (like a campaign brief PDF) — see #39 below for why this should stay separate from
    Notes & Meetings' own attachment mechanism rather than the two being merged.
37. Simplify Campaign Resources "Type" to 3 options — Link, Upload, Text details — instead of the
    current 5 (Link/Document/Brief/Asset/Other). When "Text details" is picked, a URL shouldn't be
    required — plain text should be sufficient on its own.
38. When sending Campaign details to the assigned creator (at the Assignment step), any Resource
    link(s) should be included in that outgoing message automatically.
39. ~~Standardize Notes & Meetings attachments onto real Drive~~ — **reconsidered, not a real gap.**
    Notes/Meetings attachments deliberately use Firebase Storage, not Drive (confirmed in
    `attachment-store.ts`'s own comment and `docs/CREATOROPS_CONTINUITY.md`: "Notes/Meetings never
    wires real Drive at all"). That's a correct, disclosed architectural choice for casual/internal
    attachments (meeting notes, quick files) — real Drive was deliberately reserved for
    compliance-grade documents (KYC evidence, the Finance Agreement's signed PDF) that need to be
    real, durable, externally-referenceable artifacts. The actual gap is narrower: Campaigns have no
    good way to attach a real reference *document* (as opposed to a link or a casual note file) —
    Resources is link-only (see #36) and Notes attachments are the wrong tier for this. Fix: give
    Resources real Drive upload (#36); leave Notes & Meetings on Storage for its own genuine use case.
    **Resolved scope for #36/37:** once Resources supports real upload, remove file-attachment
    capability from Notes entirely — Notes & Meetings should go back to being text-only (notes +
    meeting logs, its actual job), with document attachment consolidated onto Resources alone. The
    "Notes & meetings" section itself stays — free-form commentary and meeting logs are a genuinely
    different, still-needed function, distinct from reference-document storage.

## Assignments

40. "Create Assignment" dialog's Partner search is Partner-only (`SearchInput
    placeholder="Search Partners by name…"` in `CreateAssignmentDialog.tsx`) — should also search
    Vendors, and should support multi-select so one Campaign can be assigned to several
    Partners/Vendors at once instead of one Assignment dialog per recipient.
41. After successfully creating an Assignment, the Campaign's "Downstream availability" panel
    doesn't refresh its counts — it keeps showing the stale "0 Assignments" until the page is
    manually reloaded, even though the creation genuinely succeeded (`201 Created`).
42. **Proposed simplified flow** (design direction, not yet built) for Campaign → Assignment →
    Creator, based on how thin the current mechanics actually are once traced through the code:
    - **Bulk-create at Campaign creation:** let Campaign creation select multiple Partners/Vendors
      directly and auto-create one Assignment per recipient, inheriting the Campaign's own defaults
      (required count, format, etc.) — with per-Assignment edits still available afterward for
      recipients who genuinely need something different. Today this is Campaign creation, then a
      separate single-recipient "Create Assignment" dialog per Partner.
    - **Collapse "Issue Assignment" + "Share via WhatsApp" into one "Send" action** on the
      Assignment's default view (positioned after Owner), which transitions Draft → Assigned *and*
      opens the WhatsApp share in one step, then marks itself sent and disables to prevent
      accidental re-sends. Today these are two separate manual actions, and "Share via WhatsApp"
      only appears once status is already `ASSIGNED` (`SHARE_ELIGIBLE_STATUSES` in
      `assignments/format.ts:24`). Caveat: the system can only know the manager clicked "Open
      WhatsApp" or copied the link, not that the message was actually delivered/read — "Sent" here
      means "handed off," same approximation most "email sent" indicators make.
    - **Skip both "Accepted" and "Start Work" as separate manual steps; default new Assignments
      straight to functionally In Progress once Assigned, with a manual "discard" override for the
      manager.** Verified this loses no real signal for either: opening the public submission link
      does **not** auto-transition anything (`external-submission-service.ts:52` treats
      `ASSIGNED`/`ACCEPTED`/`IN_PROGRESS` identically for accepting a submission), and both "Mark
      Accepted" and "Start Work" (`AssignmentNextActionPanel.tsx:29-30`) are pure manual internal
      buttons with zero signal captured from the creator's actual response — neither is measuring
      participation, confirmed for both in finding #51. **Final consolidated flow (confirmed):** Draft
      → Assigned (real transition, the "Send" action from above) → **automatically** In Progress (no
      manual Accept/Start Work clicks) → creator Submits (or Resubmits, after a "Request changes"
      decision) → manager decision → **Approved**, which completes the Assignment in the same
      transaction (already true today — approving the content thread auto-completes the Assignment).
      Before implementing, check whether any other part of the app (reports, filters,
      content-fulfillment logic) treats `ACCEPTED` as a distinct, meaningful state on its own.
43. **Real bug, confirmed live:** the Share Assignment dialog's own conflict error ("An active
    submission link already exists for this recipient. Revoke it first — from the submission
    session's own history — to issue a new one.") points at a UI control that **does not exist
    anywhere in the app**. The revoke capability is real and working server-side
    (`revokeExternalSubmissionSession` in `external-submission-service.ts`, wired to a real route at
    `/api/assignments/[assignmentRef]/submission-sessions/[sessionRef]/revoke`), and
    `getActiveSubmissionSessionForRecipient` (the `GET` on the same collection route) can look up the
    active session's `sessionRef` — but no button, page, or "submission session history" view in the
    frontend calls either of them. Once a submission link has been generated for a recipient, a
    manager who needs to reissue it (lost link, wrong recipient, expired workflow) has **no way to do
    so through the UI at all** — confirmed by hitting this exact wall live during the pilot (had to
    call both APIs directly via `fetch` from the browser console to unblock). Needs a real "Revoke
    and reissue" control on the Assignment page.
44. Content submission is currently external-partner/token-driven only (via `/submit/<token>`) — no
    internal path exists for a Manager/Campaign Owner to manually record a link on the creator's
    behalf (e.g. the creator sent it over WhatsApp/call instead of using the submission page, or can't
    access the link). Needs an internal "Add link" action equivalent to the public submission form,
    plus a bulk **import** option (matching the app's existing Import Center pattern) for recording
    multiple links/Assignments at once rather than one at a time.
45. Review submission dialog's "Decision" (Approve / Request changes) should be the action buttons
    themselves, not a separate radio selection plus a second "Record decision" confirm click.
    "Request changes" still needs its reason text filled in first; "Approve" (reason optional) can be
    a single click straight through.
46. **Agreed spec:** add an "Approve" quick-action on the Assignments (and/or Content) list view, for
    rows where links have already been submitted — avoids opening each Assignment individually to
    approve, which is real friction at scale. Clicking it opens the same Review submission modal
    (submitted links shown, Approve/Request changes from there) rather than approving blind straight
    from the row — the manager still sees the actual submitted links before the decision is recorded,
    just without a full page navigation to get there.
47. **Real gap, confirmed live:** the Campaign's own "Resources" tab is purely internal — verified
    `external-submission-service.ts` (which builds the public `/submit/<token>` page a creator
    actually sees) has **zero references to Campaign Resources anywhere**. Only an Assignment-level
    "Resource link" explicitly marked "Share this link with the Partner" reaches that page; Campaign
    Resources never do, regardless of what's in them. This is misleading because the Assignment's own
    auto-filled Content requirement summary text (as typed during this pilot) said "See Campaign
    Resources for the reference brief" — a dead reference, since Campaign Resources are never
    externally visible at all. Separately, the full "Suggested counter narrative" guidance for
    Campaign 2 was only ever entered into the Campaign's own internal Objective field, which — same
    issue — is also never shown on the public submission page (only the shorter, separately-typed
    Assignment-level Content requirement summary is). Net effect: a creator has no real path to see
    detailed campaign guidance unless it's copy-pasted directly into the Assignment's own
    requirement-summary/instructions fields or attached as an Assignment-level shared Resource link —
    Campaign-level Objective and Resources are both internal-only today.
    - **Agreed fix direction:** Assignment creation should **auto-inherit** the Campaign's Objective
      and Resources onto the submission page by default (both shown to the creator automatically, no
      manual retyping) — this removes the exact mistake made live in this pilot (a shortened,
      hand-retyped summary with a dead "See Campaign Resources" reference instead of the real thing).
      "Content requirement summary" then becomes a genuinely optional **"Partner-specific
      instructions"** field, only filled in when *this* creator needs something different from or
      additional to the Campaign's own default guidance — not a mandatory re-entry step for every
      single Assignment when it's usually identical to the Campaign. Right now the Assignment form
      asks for this text unconditionally with no distinction between "inherited default" and
      "creator-specific override."
48. Due date on Create Assignment isn't pre-filled from the Campaign's own end date.
    `CreateAssignmentDialog.tsx:414-416` renders a blank date input for `dueAt`, even though the same
    dialog already displays the Campaign's `startDate`/`endDate` two fields above
    (`CreateAssignmentDialog.tsx:251-256`). Default `dueAt` to the Campaign's `endDate` (still
    editable) instead of requiring a retype of a date already on screen.
49. Language on Create Assignment is free text with no suggestion from the Partner's own already-known
    languages. `CreateAssignmentDialog.tsx:422-425` is a bare text input. The dialog's own
    `getAssignmentCreateOptions(partnerRef)` call already loads the full Partner record via
    `getPartner`, which has `languageIds` (`src/server/partners/types.ts:60`) — but
    `toSafePartnerOption` (`assignment-options-service.ts:113-115`) strips it to
    `{partnerRef, displayName, regionLabels}` before it reaches the dialog. The data needed to
    pre-fill/suggest Language is fetched and then discarded.
50. **Real bug:** "Required count" carries no downstream signal and is structurally unsatisfiable
    beyond 10. Accepts up to 1000 (`create-assignment-form.ts:40`), stored on
    `assignment.brief.requiredCount`, but: (a) never sent to the creator at all —
    `PublicAssignmentSubmissionDto` has no `requiredCount` field (`external-submission-types.ts:140-150`);
    (b) the public submission form hard-caps total links at `MAX_SUBMISSION_ROWS = 10`
    (`external-submission-types.ts:88`); (c) `evaluateAssignmentFulfillment` — the function deciding
    whether the Assignment can complete — ignores `assignment.brief.requiredCount` entirely and
    hardcodes `requiredCount: 1, qualifyingCount: 1` on approval
    (`src/server/content/fulfillment-service.ts:74-83`). One approved thread always satisfies
    fulfillment regardless of the number typed in. Same "no real signal" pattern as the Accepted-stage
    finding (#42). **Correction:** this is unrelated to the Agreement's own 20 content/month figure
    (finding #30) — per the user, that quota is tracked through Analytics import/reconciliation data,
    a separate mechanism, not through this per-Assignment field. "Required count" is a real, standalone
    bug on its own terms (a per-Assignment target that's silently capped/unenforceable), just not the
    thing that governs Agreement-level monthly quotas.
51. "Start Work" (Accepted → In Progress) carries the same zero-signal problem already diagnosed for
    "Mark Accepted" (#42). `AssignmentNextActionPanel.tsx:29-30` maps this to a manual manager click
    with no input from the creator — `external-submission-service.ts:52`'s
    `ASSIGNMENT_STATES_ACCEPTING_SUBMISSION` treats `ASSIGNED`/`ACCEPTED`/`IN_PROGRESS` identically for
    accepting a submission, so no creator action distinguishes any of these three states from each
    other. Extends #42's "skip Accepted" proposal: the same reasoning eliminates "Start Work" too,
    collapsing Draft → Assigned → [auto: functionally accepted/in-progress] → Completed, with only the
    manual Cancel/Complete edges kept.
52. Two overlapping free-text fields collected at Assignment creation, split confusingly on the public
    page. `CreateAssignmentDialog.tsx:401-408` has both "Partner-specific instructions" and "Content
    requirement summary" as separate textareas with no explanatory copy distinguishing their purpose.
    On the public submission page they render as different visual roles —
    `contentRequirementSummary` becomes the subtitle under the Campaign name
    (`external-submission-service.ts:371`), while `instructions` becomes a body paragraph
    (`external-submission-service.ts:372`). A manager filling in both is effectively typing "what to
    make" twice into fields whose only real difference is where they land on the page. Ties directly
    into #47's fix direction (Objective/Resources auto-inherit, `contentRequirementSummary` becomes
    the sole optional override) — but as implemented today, both fields already coexist and overlap.
53. **Verified, not a gap:** Campaign-level Target Audience/Regions/Languages (the `criteria`
    targeting block, `src/server/campaigns/types.ts:70-78`) are correctly *not* re-asked on Assignment
    creation — confirmed by the dialog's own comment (`CreateAssignmentDialog.tsx:39-44`,
    "Deliberately absent... Target Audience"). Note `criteria.languageIds` (which Partners to target)
    and the Assignment brief's `language` (what language the content should be in) are different
    concepts despite the similar name — not a true duplicate. Also re-confirmed the Review dialog has
    no further redundancy beyond #45 (`ContentReviewDialog.tsx:107-119`).

## Import Center — Analytics

54. **Observed once, not reproduced on retry:** the New Import wizard sent `targetKind:
    "channel_account"` to `/api/imports/dry-run` on a real attempt, even though "Campaign / Content
    (posts)" was the explicitly selected Import target at the "Choose data" step. A clean retry (same
    file, same target selection, more careful step-by-step navigation) correctly sent
    `"campaign_content"`. Something in the wizard's step navigation can drop/reset the selected target
    kind without any visible indication — worth instrumenting/reproducing deliberately, since the user
    gets no error, just silent misclassification and 100% "unmatched" rows for the wrong reason.
55. **[FIXED]** Real bug, confirmed and reproducible: the Instagram content adapter's
    header-recognition (`instagram-content-adapter.ts`'s `INSTAGRAM_CONTENT_HEADER_ALIASES`) expected
    spaced Title Case headers (`"Post ID"`, `"Post URL"`), and `normalizeHeaderKey`
    (`adapters/shared.ts:8-10`) only lowercased and collapsed whitespace — it never converted
    underscores to spaces. A real Supermetrics CSV export (snake_case: `post_id`, `post_url`, `likes`,
    `views`, `comments`, `followers`, `username`, `engagement`) failed classification entirely
    (`recognizedAs: "unrecognized"`, all rows `ERROR: missing_dependency`) purely because of the two
    identity-column header names — every other column would have mapped fine on its own. There was also
    no way to fix this from the UI: the "Mapping" step (visible in the wizard's own tab list) has no
    manual remap controls at all, just a read-only "Detected columns" table.
    - **Real fix applied** (not a workaround): `normalizeHeaderKey` now also folds underscores and
      hyphens to spaces before collapsing whitespace, so `post_id`/`post_url` normalize to the same key
      as `"Post ID"`/`"Post URL"`. This is the shared normalizer used by every adapter (Instagram
      content, YouTube content, channel snapshot), so it fixes the whole class of snake_case/kebab-case
      real-world exports, not just this one file. Verified: typecheck clean, lint clean, all 421
      existing analytics unit tests still pass (no existing alias relies on underscores/hyphens being
      *rejected*), and re-confirmed live against the original, unmodified real CSV — 4/5 rows now
      correctly match real canonical Content records (the 5th is a genuinely unrelated post, correctly
      left unmatched). No temporary renamed-CSV workaround needed anymore.
    - **Still open, not yet built:** the manual column-remap UI on the "Mapping" step, for any header
      variant the normalizer still can't reconcile (e.g. a genuinely different word, not just
      different punctuation). The normalizer fix covers this specific real case but isn't a substitute
      for that UI existing.
    **Note on "just add a Download Template":** a template (blank file with the correct headers, fill
    in and upload) helps someone building a sheet from scratch, but doesn't fix the *recurring* version
    of this problem — a real third-party export (Supermetrics here) has its own fixed header format the
    template can't change; every future export would still need manual reformatting before upload. The
    real fix was the normalizer change above; a template is a separate, complementary feature worth
    adding on its own merits (see #56), not a substitute for it.
56. **Agreed:** add a "Download Template" option on the Import Center's "Choose data" step — a blank
    file (matching the accepted format) pre-filled with the exact recognized column headers for the
    selected Import target/data kind, so a user building a sheet from scratch (rather than exporting
    from a third-party tool) starts from a correct-by-construction file instead of guessing headers.
    Complementary to #55's two real fixes, not a replacement for either.
57. **Real gap, corrected after deeper tracing:** Analytics import (Campaign/Content target) has no
    path to *attribute* post-level content that isn't tied to an existing Assignment-claimed Content
    record to its actual Partner. Initially described as "silently dropped" — that was wrong; corrected
    after isolated diagnostic testing (replicating `commitContentRow`'s exact logic against the real
    emulator) while debugging the live import failure below. What actually happens: a row with a real
    identity (postId/postUrl) but `NO_CLAIM_FOUND` still gets **written** as a real
    `analyticsContentSourceRecordDoc` (`matchState: "UNMATCHED"`), but `matchedPartnerRef`/`ownerUid`/
    `regionIds`/`teamIds` all stay null — per the schema's own comment (`types.ts:202-208`), an
    unmatched row "carries no scope evidence of its own" and is "only reachable by a GLOBAL-scoped
    actor via explorer-service.ts." So the record exists, but is effectively orphaned: invisible in any
    Partner-scoped productivity view, only visible to a global-scope Analytics Explorer user. The real
    fix is the same shape as originally proposed — a fallback Partner-account match (reusing
    `partner-account-matcher.ts`) so an unmatched-but-identifiable row can still populate
    `matchedPartnerRef`/scope fields and count toward that Partner's productivity — just not "recover
    from being dropped," since it wasn't being dropped.
    - **Note:** this finding's own diagnostic work also surfaced the real live import bug — see #60,
      now fixed.

58. Import Center wizard has no explicit "Back" button on most steps (Upload, Preview, Mapping) —
    only the "Review" step has one. Back-navigation does technically exist via the top step-nav tabs
    (`ImportCenterWizard.tsx:289`, `if (index <= maxReachedIndex) setStep(...)` — verified live,
    clicking an earlier tab like "Preview" from Review does navigate back correctly), but that's not an
    obvious "go back" affordance to a user who isn't told the tabs are clickable navigation, not just a
    progress indicator. Add a consistent "Back" button on every step, not just Review.

59. The Review table's "Detail" column only ever shows batch-conflict info
    (`import-service.ts:612`, `"Conflicts with batch X"`) — every other outcome (Warning/Unmatched/
    etc.) renders an empty "—" even though a real, human-readable reason (e.g. the match-evidence
    `reasonCode`, like `NO_CLAIM_FOUND`) exists server-side and is currently discarded before reaching
    the UI. Should surface that reason in Detail for every non-conflict outcome too.

60. **[FIXED]** Real bug, root-caused through direct reproduction: every row of a real Instagram
    analytics export failed to commit during actual Import/Resume (dry-run always looked fine — the
    failure only happened on the real write), with the error fully swallowed by `commitContentRow`'s
    catch block (`import-service.ts:305-311`) into an uninformative generic "quarantined" outcome, no
    message surfaced anywhere in the UI or the stored `safeErrorSummary`.
    - **Diagnosis:** exhausted safer diagnostics first (isolated schema/write tests with hand-typed
      data — both passed, which was misleading) before getting explicit permission to add a temporary
      diagnostic log and call the real exported pipeline (`runAnalyticsImportPipeline`) directly against
      the actual uploaded file. That surfaced the real, previously-hidden error: `ZodError: rawMediaUrl
      "Too big: expected string to have <=1000 characters"`. Real Instagram CDN media URLs carry long
      signed query strings (auth tokens, encoded parameters) and routinely exceed 1000 characters — this
      real export's values ran up to 1062, while `rawPostUrl`/`normalizedUrl`/`rawProfileUrl` (stable,
      short permalinks) correctly stay capped at 1000.
    - **Real fix applied:** widened `rawMediaUrl`'s cap specifically (not the other URL fields, which
      don't need it) to 4000 characters (`types.ts:163`, with a comment explaining why this one field
      differs from its neighbors) — generous headroom above the observed real value without going
      unbounded. Verified: typecheck clean, lint clean, all 421 analytics unit tests still pass,
      re-confirmed against the real pipeline directly (write succeeded), and finally re-confirmed
      through the actual live UI end-to-end — **Completed Batch, Matched: 4, Unmatched: 1**, all 5 real
      rows now commit correctly (the 4 real Assignment-linked Reels, plus the 1 organic post per the
      corrected #57 above).
    - **Secondary, non-blocking gaps noticed during this same diagnosis** (both nullable fields, so
      never blocked anything, just silently lost real data): the real CSV's `published_at` header
      doesn't match any `postDateTime` alias (`"Post Date"`, `"Date Posted"`, `"Published Date"`,
      `"Post Date/Time"` — "published_at" normalizes to "published at", not "published date"), so
      `postDateTimeIso` stayed null despite the real post date being present in the source file; same
      issue for the `name` header against `accountOrChannelName`'s aliases (`"Partner"`, `"Creator"`,
      `"Account Name"`, `"Creator Name"` — bare "name" doesn't match any, reasonably, since it's too
      generic on its own). Worth adding `"Published At"`/`"Published"` and reconsidering whether a bare
      "Name" column should map to `accountOrChannelName` when no more specific alias is present.

61. **Confusing recovery flow, studied directly through repeated real use.** Resuming a failed/
    quarantined Analytics import batch is needlessly indirect:
    - The only way to reach the resume file-input is to re-run an entire fresh "New import" wizard
      (Choose data → Upload → Preview → Review → Import) with the *same* file, which triggers an
      "already imported (no-op replay)" response landing back on Results — that's the *only* path to
      the actual resume control today.
    - The **History** tab shows the failed batch (confirmed live) but its detail view is read-only —
      no resume action there at all, even though that's the natural place to go looking for a failed
      import to retry.
    - The resume control itself is a bare, unlabeled `<input type="file">` above the "Resume
      quarantined rows" button (`ImportCenterWizard.tsx:521`) — easy to miss entirely; it didn't even
      surface in a text-based accessibility read of the page.
    - "This file was already imported (no-op replay)" (line 511) is misleading copy when the matched
      batch's status is actually FAILED — it reads like something succeeded.
    - **Proposed fix:** put a real "Resume" action directly on the batch's own History detail page
      (where a failed batch naturally gets found) with its own clearly-labeled upload control — no
      wizard replay required to reach it. Keep the same-file-hash integrity check (a reasonable safety
      constraint, not the problem). Fix the replay-message copy to distinguish "matches a previous
      **failed** attempt — upload again to resume" from a genuine successful no-op replay.

## Finance / Partner Reviews

62. "Create Payable" should support creating multiple Payables at once (multi-select Partners/Vendors
    and/or periods, generate all in one action) instead of one counterparty + one period per form
    submission. Real friction confirmed live: this pilot alone needed a separate pass per Partner-month.

63. Partner Reviews' "Generate Review" should have the same bulk option — generate reviews for
    multiple Partner-months in one action from the workspace list, instead of one "Generate Review"
    click per row.

64. **[FIXED]** Real design proposal, directly motivated by a real blocker hit in this pilot. Originally:
    a governing Agreement had to cover a calendar month in full (`policy-adapter.ts:36-39`, deliberate,
    documented: "never prorated") — a month only partially covered by the Agreement's effective range
    had no governing version at all, and Partner Reviews/Payables couldn't resolve any commercial
    evidence for it. Confirmed live: Mrinal's real Agreement is effective from 10 Sep 2026, so September
    2026 (where his real, approved content actually was) had zero governing Agreement, while October —
    the first full month — had no real activity yet. User's proposed fix: let the **first** reporting
    period run from the Agreement's actual signed/effective date through that same month's end (e.g.
    effective the 15th → first period is 15–30/31), with every subsequent period reverting to normal
    full calendar months (1st–end).
    - **Real fix applied** (`src/server/finance-agreements/policy-adapter.ts`'s `coversMonth`, "Step
      14D"): an Agreement's very first version (version 1) now also governs the ONE calendar month its
      own `effectiveFrom` falls inside, even though that month starts before `effectiveFrom`. Every
      other month — including that same version's later months, an ending/superseding mid-month, or any
      version after the first — still requires full whole-month coverage exactly as before (confirmed by
      a dedicated new test that a later mid-month revision does **not** get this treatment).
    - **Resolved the open design question** (how `monthlyDeliverableRequirement` should apply to the
      partial first period) by NOT touching it at all: it stays the Agreement's full, unscaled monthly
      figure. The evidence window (`partner-reviews/period.ts`'s `derivePeriod`) is also unchanged —
      still the full calendar month — so `actualQualifyingCount` naturally reflects only what the
      Partner could realistically deliver in the shorter real window. The already-existing,
      already-shipped base-provision proration (`amount-determination.ts` Step 15C: `serviceBase =
      fixed / required * min(actual, required)`) is what turns that into a fair prorated amount — no new
      day-based math was invented, keeping this a real root-cause fix rather than a second bespoke
      proration bolted on top.
    - **Real-data check made before implementing:** confirmed live (direct Firestore query) that both of
      Mrinal's real Assignments were created 2026-09-29 — safely after the Agreement's 2026-09-10
      effective date — so this fix carries no risk of over-counting pre-Agreement activity for this real
      case. Documented as a known, narrow edge case in the code comment for future Partners where it
      could matter: an Assignment dated before the Agreement's effective date, but still within that
      same inception month, would still count toward evidence since the evidence window itself wasn't
      narrowed to start at `effectiveFrom`.
    - **Verified:** typecheck clean, lint clean; updated the two emulator tests that pinned the old
      "partial months never governed" behavior (`policy-adapter.emulator.test.ts`,
      `policy-applicability.emulator.test.ts`) plus one new test proving the exception's exact scope;
      full finance-agreements/finance-payables/partner-reviews emulator suite (502 tests) and full unit
      suite (4102 tests) pass.
    - **Not yet done:** the actual real Payable for Mrinal/September 2026 was NOT generated — see #69, a
      blocker discovered immediately after this fix, before the planned live re-check could even run.

65. **[FIXED]** Real, secondary bug from #60's same diagnosis: the real Supermetrics `published_at`
    header wasn't recognized by either content adapter's `postDateTime` aliases
    (`instagram-content-adapter.ts:16`, `youtube-content-adapter.ts:12` — only spaced Title Case
    variants like `"Published Date"` existed; "published_at" normalizes to "published at", a genuinely
    different word from "published date", not just a punctuation difference the #55 fix could cover).
    Real effect: every imported record's `postDateTimeIso` silently stayed null despite the real date
    being present in the source. **Fix applied:** added `"Published At"`/`"Published"` to both
    adapters' `postDateTime` aliases. Verified: typecheck/lint clean, 421 tests still pass, and
    confirmed live — the real post dates now parse correctly.

66. **Real, confirmed gap:** the Analytics Import wizard has **no UI control at all** for
    `reportingPeriod`, even though it's a real, functioning field the pipeline and schema already
    support end-to-end (`AnalyticsImportPipelineInput.reportingPeriod`,
    `ImportCenterWizard.tsx` — confirmed zero matches for it anywhere in that file). Every
    Campaign/Content import through the real UI is permanently stuck with `reportingPeriod: null` on
    every record, which is exactly why "Analytics records in month" reads 0 even when real, correctly
    dated records exist (confirmed live in this pilot). For a content-post import specifically (each
    row already carries its own real `postDateTimeIso`), the better design is likely to **derive**
    `reportingPeriod` per-row from that date automatically, with an explicit UI field only needed as a
    fallback for imports where rows don't carry their own date (e.g. Channel/Account snapshots, which
    are inherently period-level, not per-post).

67. **Real, confirmed bug:** re-importing byte-identical file content with a genuinely different
    `reportingPeriod`/`supersedesBatchRef` is impossible through the real service. `executeAnalyticsImport`
    computes `sourceHash` from the raw file bytes and short-circuits on any prior `COMPLETED` batch
    with that same hash (`import-service.ts:365-371`) **before** even looking at `supersedesBatchRef` —
    so a legitimate correction (same source file, different reporting period) silently replays the old,
    uncorrected result instead of either applying the correction or rejecting it with a clear reason.
    Confirmed live: two direct attempts to supply a corrected `reportingPeriod` via `supersedesBatchRef`
    both silently no-op'd (`idempotentReplay: true`) until the file bytes were deliberately altered
    (a trailing newline) to force a different hash. The idempotency check should also consider
    `supersedesBatchRef`/`reportingPeriod`, not just the raw byte hash.

68. **Real UX finding, from live use of Partner Reviews (screenshot supplied by the user).** The Partner
    Review detail page's "Review status" panel (Lifecycle / Version / Freshness / Evidence cutoff /
    Evidence completeness / Generated / Last refreshed) exposes internal provenance/bookkeeping detail a
    normal daily reviewer has no use for. User's own framing, verbatim intent: a reviewer "just wants to
    know is his data updated, matched with criteria, discrepancies, approve or revise, that's all." This
    is one instance of a broader pattern across the app — multiple pages/modules across modules expose
    raw internal state (freshness timestamps, source fingerprints, version bookkeeping, etc.) that
    belongs in an audit/debug view, not the primary daily workflow.
    - **Proposed direction (from the user):** Partner Reviews doesn't need its own dedicated detail page
      for routine use — the workspace table itself could carry the review action directly: click a row
      to open a modal with just the relevant data (what changed, whether it matches criteria, any
      discrepancies) and a direct Approve / Revise action, instead of navigating to a full separate page
      that also surfaces lifecycle/freshness/versioning detail.
    - **Scope:** needs a systematic pass across Partner Reviews (and likely other modules with the same
      "internal bookkeeping mixed into the primary view" pattern — Finance Agreements' version/
      confirmation detail is a likely second instance) to separate "what a daily user decides on" from
      "what an admin/auditor needs to trace provenance," rather than a one-off panel redesign.
    - **Not implemented.** Per this pilot's standing rule, no UI redesign work starts without explicit
      authorization from the user first.

69. **Current blocker, discovered live immediately after implementing #64.** The Firestore emulator
    (`demo-creatorops`, port 18092, `firebase.private.json`) has no persistence configured — no
    `--import` snapshot on start, no `--export-on-exit`. The process was restarted today (12:36 PM) with
    a clean, empty state. When work resumed to live-verify the #64 fix and generate Mrinal's real
    September 2026 Payable, the emulator contained only generic seed fixtures
    (`seed-partner-archived`, `seed-partner-direct`, etc.) — **Mrinal Jha's real Partner record, the
    real Finance Agreement (effective 10 Sep 2026), the real Campaigns/Assignments/Content, and the
    imported real Supermetrics Analytics batch built earlier in this same pilot session were all gone**,
    with no export available to restore from.
    - **Effect:** real Payable generation for #64 is on hold until the real pilot data is either
      restored (if a snapshot turns up) or deliberately rebuilt from scratch through the real app flows
      (never fabricated directly into Firestore).
    - **Worth fixing separately:** local dev/pilot sessions like this should probably run the emulator
      with `--export-on-exit=<dir> --import=<dir>` (or an equivalent persistent data directory) by
      default, so a routine restart doesn't silently discard hours of real working data with no warning
      anywhere.

## Not yet triaged / severity

Everything above is unranked. #1 is the only one implemented; the rest are open for a future pass.
Item 15/33/43 involve actual confirmed bugs (data accepted that shouldn't be, a required field with
no indication, and a dead-end UI instruction pointing at a control that was never built) and are
probably worth prioritizing over the pure UI/layout items.

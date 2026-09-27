// Canonical action identifiers usable inside any feature's accessGrants
// entry, checked via canPerformAction(). Deliberately separate from the
// feature grant's own top-level `view` boolean (that's Feature Access,
// checked via canAccessFeature() - a different pipeline stage). Not every
// feature uses every action - which actions are actually meaningful for
// a given feature is defined once, centrally, in module-actions.ts (the
// canonical per-module action catalog); this flat list is just the full
// set of valid action ids that catalog is allowed to draw from.
//
// manage_users/manage_scope/manage_sensitive/view_audit/manage_overrides
// are Administration-specific actions - deliberately granular rather
// than reusing the generic "manage" for everything, so a future role
// could be granted (for example) read access to the audit trail without
// also being able to change anyone's role.
//
// Step 5B.1: extended with real, module-specific actions (rather than
// reusing the same generic create/edit/approve/export everywhere) so the
// Administration access-matrix UI can show each module's own meaningful
// permissions instead of one repeated, mostly-inapplicable list. Not
// every one of these is enforced by a real business-module route yet
// (most modules are still UI-skeleton only) - the catalog is
// deliberately built ahead of that, the same way the original
// create/edit/export actions already were.
export const ACTIONS = [
  "create",
  "edit",
  "approve",
  "export",
  "manage",
  "manage_users",
  "manage_scope",
  "manage_sensitive",
  "manage_overrides",
  "view_audit",
  // Discovery
  "convert_lead",
  "manage_research",
  "manage_review",
  "manage_outreach",
  "manage_commercial",
  "manage_asset_decision",
  "manage_manager_assignment",
  "manage_kyc",
  "transition_lifecycle",
  // Partners / Vendors
  "manage_relationships",
  // Step 7A: Partners' own granular actions, deliberately distinct from
  // the shared manage_relationships placeholder Vendors still uses (kept
  // as-is - Vendors is out of scope here) - same "granular rather than
  // one generic 'manage'" discipline as Discovery's own action list.
  "manage_partner_accounts",
  "manage_partner_ownership",
  "manage_partner_governance",
  "manage_partner_restricted_identity",
  // Step 8A: Vendors' own granular actions, same "granular rather than
  // one generic 'manage'" discipline as Partners' - deliberately its own
  // ids (not reused from Partners) since a role's Vendor and Partner
  // permissions are meant to be grantable independently. archive/restore
  // are split into two distinct actions (unlike Partners' single
  // manage_partner_governance) per Step 8A's own explicit action list.
  "manage_vendor_ownership",
  "manage_vendor_partner_relationships",
  "transition_vendor_lifecycle",
  "archive_vendor",
  "restore_vendor",
  "manage_vendor_restricted_identity",
  // Step 9A: Campaigns' own granular actions, same "granular rather than
  // one generic 'manage'" discipline as Partners'/Vendors' - replaces the
  // earlier UI-skeleton-era "manage_campaign_work" placeholder (never
  // enforced by a real service, so nothing accepted depends on it).
  "manage_campaign_ownership",
  "transition_campaign_lifecycle",
  "cancel_campaign",
  "archive_campaign",
  "manage_campaign_resources",
  // Step 10A: Assignments' own granular actions, beyond the shared
  // generic create/edit already used for ordinary create/edit-draft-brief
  // (see module-actions.ts) - same "one generic ordinary-transition
  // action plus separate reasoned/consequential ones" shape as Campaigns'
  // own transition_campaign_lifecycle/cancel_campaign split.
  "transition_assignment_lifecycle",
  "cancel_assignment",
  "manage_assignment_external_submission",
  // Step 11A.1: Content's own granular actions, drastically simplified
  // by the business-process correction retiring the two-policy
  // production/pre-publication-review/publication/completion model.
  // manage_content_production/submit_content_for_review/
  // manage_content_publication/complete_content are retired entirely -
  // submission only ever happens via the public page now, and approval
  // IS closing (no separate Complete Content step anywhere). review_content
  // remains its own distinct action (never folded into a generic
  // "manage") so a role can hold Content create/cancel permissions
  // without also being trusted to approve/request revision.
  "review_content",
  "cancel_content",
  // Analytics
  "explore",
  "manage_analytics_data",
  // Partner Reviews - "create" (shared, generic) gates generate Draft /
  // refresh evidence / create revision; the two ids below are the review
  // workflow's own distinct steps (see module-actions.ts).
  "submit_partner_review",
  "finalize_approve",
  // Finance
  "manage_agreements",
  // Step 14A: the governance-weight Agreement lifecycle actions (activate,
  // revise, suspend, resume, end) - deliberately its own id, never folded
  // into manage_agreements, so Manager can prepare/confirm an Agreement
  // without being trusted to make it operational.
  "activate_agreements",
  "manage_payables",
  "approve_payables",
  // Step 15A: the two governance-weight Payable actions, deliberately their own ids rather than
  // folded into manage_payables/approve_payables - same "granular rather than one generic manage"
  // discipline as the Agreement lifecycle's own activate_agreements split. A Manager may prepare a
  // draft Payable (manage_payables) without being trusted to change its money by hand
  // (adjust_payables) or to void it (void_payables).
  "adjust_payables",
  "void_payables",
  "manage_invoices",
  // Step 16A: the Invoice governance-weight actions, deliberately their own ids rather than folded
  // into manage_invoices - same "granular rather than one generic manage" discipline as Payables'
  // own approve_payables/adjust_payables/void_payables split. A Manager may prepare/submit an
  // Invoice draft (manage_invoices) without being trusted to approve/reject it (approve_invoices),
  // void it (void_invoices), or accept a legitimate Invoice/Payable amount mismatch on it
  // (override_invoice_mismatch - the narrowest of the three, Partnership Head/Super Admin only).
  "approve_invoices",
  "void_invoices",
  "override_invoice_mismatch",
  // Step 16C: resolving a payee identity mismatch/review on an Invoice - its own narrow action,
  // deliberately never folded into override_invoice_mismatch (a distinct decision - see
  // finance-invoices-gate.ts's own comment).
  "resolve_invoice_payee_mismatch",
  "record_payments",
  // Step 17A: Finance Payments' own granular actions, deliberately their own ids rather than
  // folded into a single "manage" - same "granular rather than one generic manage" discipline as
  // Invoices' own manage_invoices/approve_invoices/void_invoices/override_invoice_mismatch split.
  // A Payment records actual money movement against an approved Invoice, so day-to-day authoring
  // (manage_payments: create/revise a Draft, record a transfer) is separated from the two
  // governance-weight actions that make a transfer count toward settlement or retire it
  // (confirm_payments, void_payments), and from the narrowest of the four - accepting an
  // overpayment past the expected net payment with a mandatory reason
  // (override_payment_overage), Head/Super-Admin-only, mirroring override_invoice_mismatch's own
  // narrow shape. The pre-existing `record_payments` id above stays a catalog-only placeholder
  // (Step 14A) - Payments now has its own real actions instead of that placeholder.
  "manage_payments",
  "confirm_payments",
  "void_payments",
  "override_payment_overage",
  // Operations
  // Step 18A: Operations' own granular actions, same "granular rather than one generic manage"
  // discipline as every other Finance-era module. Tasks split day-to-day authoring (manage_tasks:
  // create/revise) from reassignment (assign_tasks) and from the lifecycle-closing transitions
  // (complete_tasks: start/block/unblock/complete/reopen/cancel) - deliberately their own ids so a
  // role can hold one without the others, mirroring Payments' own manage/confirm/void split.
  // view_approval_queue gates the Approval Queue surface itself; there is deliberately no
  // act_on_approval_queue in this step (see approval-queue-service.ts) - Step 18A's Approval Queue
  // is read-only, so no routed-action permission exists to grant. "Viewing Operations at all" is
  // the feature's own top-level `view` boolean (the same FeatureAccess stage every other module's
  // plain view already uses) - there is deliberately no separate "view_operations" action id.
  "manage_tasks",
  "assign_tasks",
  "complete_tasks",
  "view_approval_queue",
  "manage_reminders",
  // Reports
  "run_reports",
  // Reports Final-Master: the publication lifecycle's own granular actions, same "day-to-day vs
  // governance-weight" discipline as every other module's own split (Partner Reviews'
  // submit_partner_review/finalize_approve, Finance's manage_agreements/activate_agreements). Editing
  // narrative and submitting a draft for review are day-to-day authoring; finalizing a version and
  // opening a correction/superseding version are governance-weight (Head/Super Admin only - see
  // seed-access-data.ts). download_artifact is its own id, deliberately distinct from run_reports,
  // so artifact access can be reasoned about and tested as its own boundary (spec section 23).
  "edit_narrative",
  "submit_for_review",
  "finalize_report",
  "create_superseding_version",
  "download_artifact",
  // Import / Export Center
  "manage_imports",
  "create_exports",
  // Notes / Meetings / MoM - deliberately its own granular ids rather than reusing an owning module's
  // own create/edit, since Notes/Meetings authorizes in TWO stages (the owning entity's own
  // FeatureAccess via that module's own gated getter, composed exactly like target-display.ts, PLUS
  // this module-level ActionPermission) - see notes-meetings-gate.ts. manage_notes and manage_meetings
  // are deliberately separate (a role could be trusted with Notes but not Meetings, or vice versa).
  // promote_action_item is its own id (not folded into manage_meetings) because it is the one
  // consequential, cross-module action in this subsystem - it creates a real Operations Task - so a
  // role can hold ordinary Meeting/action-item authoring without being trusted to promote.
  "manage_notes",
  "manage_meetings",
  "promote_action_item",
] as const;

export type ActionId = (typeof ACTIONS)[number];

export function isActionId(value: unknown): value is ActionId {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

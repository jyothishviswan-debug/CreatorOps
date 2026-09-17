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
  // Content
  "submit_review",
  "approve_publish",
  // Analytics
  "explore",
  "manage_analytics_data",
  // Partner Reviews
  "finalize_approve",
  // Finance
  "manage_agreements",
  "manage_payables",
  "approve_payables",
  "manage_invoices",
  "record_payments",
  // Operations
  "manage_tasks",
  "manage_approvals",
  "manage_reminders",
  // Reports
  "run_reports",
  // Import / Export Center
  "manage_imports",
  "create_exports",
] as const;

export type ActionId = (typeof ACTIONS)[number];

export function isActionId(value: unknown): value is ActionId {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

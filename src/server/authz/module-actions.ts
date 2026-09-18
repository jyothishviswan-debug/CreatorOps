// The canonical, central catalog of which actions are actually meaningful
// for each module (feature) - the single source of truth the
// Administration access-matrix UI renders from and mutations validate
// against, so a module never shows (or accepts) an action that makes no
// sense for it. A module's own "View module" permission is NOT listed
// here - it's the feature grant's top-level `view` boolean, resolved and
// edited separately from its actions (see capabilities.ts, types.ts).
//
// Intentionally NOT exhaustive workflow permissions for modules that
// don't have real CRUD yet - just the meaningful distinctions the
// product model already supports. Extending a module's list here is
// always safe: it only ever adds a new optional tri-state control, it
// never changes what an existing override means.
import type { ActionId } from "./actions";
import type { FeatureId } from "./features";

export type ModuleActionDef = { id: ActionId; label: string };

export const MODULE_ACTIONS: Record<FeatureId, ModuleActionDef[]> = {
  dashboard: [],
  discovery: [
    { id: "create", label: "Create lead" },
    { id: "edit", label: "Edit lead" },
    { id: "manage_research", label: "Save research" },
    { id: "manage_review", label: "Record review/shortlist" },
    { id: "manage_outreach", label: "Record outreach/response" },
    { id: "manage_commercial", label: "Save negotiation/agreement evidence" },
    { id: "manage_asset_decision", label: "Save asset decision" },
    { id: "manage_manager_assignment", label: "Assign manager" },
    { id: "manage_kyc", label: "Manage restricted KYC" },
    { id: "transition_lifecycle", label: "Transition lifecycle (watchlist/reject/archive/restore)" },
    { id: "convert_lead", label: "Convert lead" },
    { id: "export", label: "Export" },
  ],
  partners: [
    { id: "create", label: "Create Partner" },
    { id: "edit", label: "Edit Partner" },
    { id: "manage_partner_accounts", label: "Manage Partner Accounts" },
    { id: "manage_partner_ownership", label: "Manage owner/team" },
    { id: "manage_partner_governance", label: "Blacklist/archive/restore" },
    { id: "manage_partner_restricted_identity", label: "Manage restricted financial identity" },
    { id: "manage_relationships", label: "Manage accounts/relationships" },
    { id: "export", label: "Export" },
  ],
  vendors: [
    { id: "create", label: "Create Vendor" },
    { id: "edit", label: "Edit Vendor" },
    { id: "manage_vendor_ownership", label: "Manage owner/team" },
    { id: "manage_vendor_partner_relationships", label: "Manage Partner relationships" },
    { id: "transition_vendor_lifecycle", label: "Activate/inactivate" },
    { id: "archive_vendor", label: "Archive" },
    { id: "restore_vendor", label: "Restore" },
    { id: "manage_vendor_restricted_identity", label: "Manage restricted financial identity" },
    { id: "export", label: "Export" },
  ],
  campaigns: [
    { id: "create", label: "Create Campaign" },
    { id: "edit", label: "Edit Campaign" },
    { id: "manage_campaign_ownership", label: "Manage owner/team" },
    { id: "transition_campaign_lifecycle", label: "Transition lifecycle (plan/activate/pause/complete)" },
    { id: "cancel_campaign", label: "Cancel" },
    { id: "archive_campaign", label: "Archive" },
    { id: "manage_campaign_resources", label: "Manage resources" },
    { id: "export", label: "Export" },
  ],
  // Step 10A: extends the earlier UI-skeleton-era stub (create/edit/
  // export only) with Assignment's real granular actions, same pattern
  // Campaigns' own stub->real extension used.
  assignments: [
    { id: "create", label: "Create Assignment" },
    { id: "edit", label: "Edit draft brief" },
    { id: "transition_assignment_lifecycle", label: "Transition lifecycle (assign/accept/start/complete)" },
    { id: "cancel_assignment", label: "Cancel" },
    { id: "manage_assignment_external_submission", label: "Manage external submission links" },
    { id: "export", label: "Export" },
  ],
  // Step 11A.1: retires manage_content_production/submit_content_for_review/
  // manage_content_publication/complete_content - the simplified
  // post-link-review model has no staff-side production/submission/
  // publication-evidence/complete steps left. `create` now gates the
  // automatic resolveOrCreateContentThread get-or-create (there is no
  // manual "Plan Content" action anymore).
  content: [
    { id: "create", label: "Create submission thread" },
    { id: "review_content", label: "Review (approve/request revision)" },
    { id: "cancel_content", label: "Cancel" },
    { id: "export", label: "Export" },
  ],
  analytics: [
    { id: "explore", label: "Explore" },
    { id: "manage_analytics_data", label: "Import/manage analytics data" },
    { id: "export", label: "Export" },
  ],
  partner_reviews: [
    { id: "create", label: "Create/Edit" },
    { id: "finalize_approve", label: "Finalize/Approve" },
    { id: "export", label: "Export" },
  ],
  finance: [
    { id: "manage_agreements", label: "Manage agreements" },
    { id: "manage_payables", label: "Manage payables" },
    { id: "approve_payables", label: "Approve payables" },
    { id: "manage_invoices", label: "Manage invoices" },
    { id: "record_payments", label: "Record/manage payments" },
    { id: "export", label: "Export finance data" },
  ],
  operations: [
    { id: "manage_tasks", label: "Manage tasks" },
    { id: "manage_approvals", label: "Manage approvals" },
    { id: "manage_reminders", label: "Manage reminders" },
  ],
  reports: [
    { id: "run_reports", label: "Run reports" },
    { id: "export", label: "Export reports" },
  ],
  imports: [{ id: "manage_imports", label: "Run/manage imports" }],
  exports: [{ id: "create_exports", label: "Create/run exports" }],
  administration: [
    { id: "manage_users", label: "Manage users (view, provision, edit, activate/deactivate, assign base role)" },
    { id: "manage_overrides", label: "Manage user feature/action overrides" },
    { id: "manage_scope", label: "Manage scopes" },
    { id: "manage_sensitive", label: "Manage sensitive access" },
    { id: "view_audit", label: "View audit" },
  ],
};

export function isValidModuleAction(feature: FeatureId, actionId: string): actionId is ActionId {
  return MODULE_ACTIONS[feature]?.some((action) => action.id === actionId) ?? false;
}

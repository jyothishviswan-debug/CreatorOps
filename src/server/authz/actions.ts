// Canonical action identifiers usable inside any feature's accessGrants
// entry, checked via canPerformAction(). Deliberately separate from the
// feature grant's own top-level `view` boolean (that's Feature Access,
// checked via canAccessFeature() - a different pipeline stage). Not every
// feature uses every action - a feature's grant only needs to list the
// actions meaningful for it (see seed-access-data.ts).
//
// manage_users/manage_scope/manage_sensitive/view_audit are Step 5A's
// Administration-specific actions - deliberately granular rather than
// reusing the generic "manage" for everything, so a future role could be
// granted (for example) read access to the audit trail without also
// being able to change anyone's role.
export const ACTIONS = [
  "create",
  "edit",
  "approve",
  "export",
  "manage",
  "manage_users",
  "manage_scope",
  "manage_sensitive",
  "view_audit",
] as const;

export type ActionId = (typeof ACTIONS)[number];

export function isActionId(value: unknown): value is ActionId {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

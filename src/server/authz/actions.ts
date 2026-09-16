// Canonical action identifiers usable inside any feature's accessGrants
// entry, checked via canPerformAction(). Deliberately separate from the
// feature grant's own top-level `view` boolean (that's Feature Access,
// checked via canAccessFeature() - a different pipeline stage). Not every
// feature uses every action - a feature's grant only needs to list the
// actions meaningful for it (see seed-access-data.ts).
export const ACTIONS = ["create", "edit", "approve", "export", "manage"] as const;

export type ActionId = (typeof ACTIONS)[number];

export function isActionId(value: unknown): value is ActionId {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

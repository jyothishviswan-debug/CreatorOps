// The five canonical roles. This is a closed set of identifiers only -
// deliberately NOT an ordered list. Nothing in this codebase may compare
// roles by position/index/rank to decide access; every grant must be
// looked up explicitly per role from accessGrants (see capabilities.ts).
export const ROLES = ["viewer", "analyst", "partnership_manager", "partnership_head", "super_admin"] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  viewer: "Viewer",
  analyst: "Analyst",
  partnership_manager: "Partnership Manager",
  partnership_head: "Partnership Head",
  super_admin: "Super Admin",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

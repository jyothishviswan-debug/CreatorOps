// Ported from the golden master's OV_DATA.administration and
// workspaceRows() 'administration' case (docs/reference/
// CreatorOps_UI_Golden_Master.html). The module intent calls for Users,
// Access and Audit sub-areas; the source only defines a single Users
// record shape, so Access and Audit segment the same person set by kind,
// same technique used for Finance's and Operations's sub-areas.
import type { ModuleOverview, ModuleWorkspace, RecordRow } from "@/features/shared/types";
import { initialsOf } from "@/features/shared/types";

export const administrationOverview: ModuleOverview = {
  eyebrow: "SYSTEM GOVERNANCE",
  title: "Administration",
  description: "Understand access, scope integrity and system capability.",
  summary: "Administration governance cockpit",
  kpis: [
    { icon: "users", label: "Total users", value: "25", hint: "registered accounts" },
    { icon: "check", label: "Active users", value: "22", hint: "admitted users" },
    { icon: "shield", label: "Configured roles", value: "5", hint: "non-monotonic access" },
    { icon: "alert", label: "Security attention", value: "2", hint: "requires review" },
    { icon: "flag", label: "Scope issues", value: "1", hint: "incomplete profile" },
    { icon: "layers", label: "Admin SDK", value: "Configured", hint: "illustrative status" },
  ],
  topPanels: [
    {
      kind: "donut",
      icon: "users",
      title: "Users by Role",
      note: "25 users · five canonical roles",
      foot: "Access combines capability, scope and field sensitivity.",
      span: 3,
      total: 25,
      totalLabel: "Users",
      segments: [
        { label: "Super Admin", value: 2 },
        { label: "Partnership Head", value: 3 },
        { label: "Partnership Manager", value: 12 },
        { label: "Analyst", value: 5 },
        { label: "Viewer", value: 3 },
      ],
    },
    {
      kind: "donut",
      icon: "check",
      title: "User Status",
      note: "25 directory profiles",
      foot: "88% of users are active in this sample.",
      span: 3,
      total: 25,
      totalLabel: "Accounts",
      segments: [
        { label: "Active", value: 22 },
        { label: "Disabled", value: 2 },
        { label: "Pending", value: 1 },
      ],
    },
    {
      kind: "checks",
      icon: "shield",
      title: "Access Governance",
      note: "Account and scope safeguards",
      foot: "Roles are non-monotonic; access is never UI-only.",
      span: 3,
      rows: [
        { label: "Admin resilience", detail: "2 admins", badge: "Review" },
        { label: "Scope completeness", detail: "1 gap", badge: "Action" },
        { label: "Identity linkage", detail: "25 linked", badge: "Complete" },
        { label: "Active admission", detail: "22 users", badge: "Active" },
        { label: "Protected admin", detail: "Guarded", badge: "Required" },
      ],
    },
    {
      kind: "checks",
      icon: "layers",
      title: "System Readiness",
      note: "Illustrative capability status",
      foot: "Live readiness must be independently certified.",
      span: 3,
      rows: [
        { label: "Administration UI", detail: "Available", badge: "Demo" },
        { label: "Role & scope model", detail: "5 roles", badge: "Demo" },
        { label: "Provisioning", detail: "Available", badge: "Demo" },
        { label: "Admin SDK", detail: "Configured", badge: "Demo" },
        { label: "Rules deployment", detail: "Unverified", badge: "Check" },
      ],
    },
  ],
  bottomPanels: [
    {
      kind: "activity",
      icon: "clock",
      title: "Recent Activity",
      note: "Latest meaningful changes",
      foot: "Full history stays in the workspace.",
      span: 3,
      rows: [
        { title: "User invitation created", detail: "Directory administration · 12 min ago", href: "/administration/users" },
        { title: "Role assignment updated", detail: "User access review · 2 hours ago", href: "/administration/access" },
        { title: "Account access revoked", detail: "Directory administration · 5 hours ago", href: "/administration/users" },
        { title: "Profile sync completed", detail: "Directory updates · 1 day ago", href: "/administration/audit" },
      ],
    },
    {
      kind: "attention",
      icon: "alert",
      title: "Pending Actions",
      note: "Actionable directory queues",
      foot: "No account changes are performed by this preview.",
      span: 3,
      rows: [
        { title: "Security review", detail: "Review", count: "2" },
        { title: "Incomplete scope", detail: "Fix", count: "1" },
        { title: "Pending admission", detail: "Review", count: "1" },
        { title: "Disabled accounts", detail: "Inspect", count: "2" },
      ],
    },
    {
      kind: "checks",
      icon: "shield",
      title: "Access Principles",
      note: "Canonical authorization principles",
      foot: "Inspect authorized audit history for supporting evidence.",
      span: 3,
      rows: [
        { label: "Least privilege", detail: "Required", badge: "Policy" },
        { label: "Scope boundary", detail: "Required", badge: "Policy" },
        { label: "Protected admin", detail: "Required", badge: "Policy" },
        { label: "Sensitive fields", detail: "Restricted", badge: "Policy" },
      ],
    },
    {
      kind: "actions",
      icon: "grid",
      title: "Quick Actions",
      note: "Continue from insight to action",
      foot: "Actions preview the destination; no records are changed.",
      span: 3,
      rows: [
        { label: "User workspace", icon: "users" },
        { label: "Scope review", icon: "shield" },
        { label: "Audit history", icon: "clock" },
        { label: "Open workspace", icon: "grid" },
      ],
    },
  ],
};

type Kind = "users" | "access" | "audit";

const NAMES = ["Ananya Rao", "Arjun Nair", "Kavya Iyer", "Meera Das", "Rohan Shah", "Tara Menon"];
const EMAILS = ["manager", "head", "analyst", "admin", "viewer", "manager"].map((r) => `${r}@creatorops.com`);
const ROLES = ["Partnership Manager", "Partnership Head", "Analyst", "Super Admin", "Viewer", "Partnership Manager"];
const REGIONS = ["Kerala", "Kerala", "Tamil Nadu", "Maharashtra", "Maharashtra", "Karnataka"];
const OWNERS = ["Meera Das", "Meera Das", "Arjun Nair", "Ananya Rao", "Ananya Rao", "Arjun Nair"];

const STATUS_BY_KIND: Record<Kind, string[]> = {
  users: ["Active", "Active", "Active", "Active", "Disabled", "Active"],
  access: ["Scope complete", "Scope complete", "Review needed", "Scope complete", "Scope complete", "Gap found"],
  audit: ["Logged", "Logged", "Logged", "Logged", "Flagged", "Logged"],
};
const TYPE_BY_KIND: Record<Kind, string[]> = {
  users: ROLES,
  access: ["Standard scope", "Elevated scope", "Standard scope", "Full scope", "Read-only scope", "Standard scope"],
  audit: ["Sign-in event", "Role change", "Export event", "Sign-in event", "Access denied", "Profile update"],
};
const SUB_BY_KIND: Record<Kind, string[]> = {
  users: EMAILS,
  access: EMAILS.map((e) => `${e} · Scope review`),
  audit: EMAILS.map((e) => `${e} · Audit trail`),
};

function slug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

function buildRows(kind: Kind): RecordRow[] {
  return NAMES.map((name, i) => ({
    id: `${slug(name)}-${kind}`,
    name,
    sub: SUB_BY_KIND[kind][i],
    status: STATUS_BY_KIND[kind][i],
    type: TYPE_BY_KIND[kind][i],
    region: REGIONS[i],
    owner: OWNERS[i],
    initials: initialsOf(name),
  }));
}

const WORKSPACES: Record<Kind, ModuleWorkspace> = {
  users: {
    recordLabel: "User",
    columns: { record: "User", status: "Status", context: "Role", region: "Region", owner: "Owner" },
    rows: buildRows("users"),
  },
  access: {
    recordLabel: "Access record",
    columns: { record: "User", status: "Status", context: "Scope", region: "Region", owner: "Owner" },
    rows: buildRows("access"),
  },
  audit: {
    recordLabel: "Audit entry",
    columns: { record: "User", status: "Status", context: "Event", region: "Region", owner: "Owner" },
    rows: buildRows("audit"),
  },
};

export function getAdministrationWorkspace(kind: Kind): ModuleWorkspace {
  return WORKSPACES[kind];
}

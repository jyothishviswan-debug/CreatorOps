// Ported from the golden master's OV_DATA.creators (old "Creators" module
// maps to our canonical "Partners") and workspaceRows() default case
// (docs/reference/CreatorOps_UI_Golden_Master.html). Sample copy normalized
// to canonical terminology (creator -> partner).
import type { ModuleOverview, ModuleWorkspace, RecordDetail, RecordRow } from "@/features/shared/types";
import { initialsOf } from "@/features/shared/types";

export const partnersOverview: ModuleOverview = {
  eyebrow: "FIND & ONBOARD",
  title: "Partners",
  description: "Understand roster health, account coverage and readiness.",
  summary: "Partner portfolio intelligence",
  kpis: [
    { icon: "users", label: "Total partners", value: "142", hint: "canonical identities" },
    { icon: "check", label: "Active partners", value: "126", hint: "88.7% of roster" },
    { icon: "brief", label: "Platform accounts", value: "214", hint: "linked channels" },
    { icon: "flag", label: "Campaign active", value: "61", hint: "current period" },
    { icon: "alert", label: "Needs attention", value: "12", hint: "unique partners" },
  ],
  topPanels: [
    {
      kind: "donut",
      icon: "users",
      title: "Partner Status",
      note: "142 canonical partners",
      foot: "88.7% of the roster is active.",
      span: 3,
      total: 142,
      totalLabel: "Partners",
      segments: [
        { label: "Active", value: 126 },
        { label: "Inactive", value: 13 },
        { label: "Blacklisted", value: 3 },
      ],
    },
    {
      kind: "donut",
      icon: "brief",
      title: "Platform Footprint",
      note: "Partners by account coverage",
      foot: "133 partners have accounts · 214 linked accounts.",
      span: 3,
      total: 142,
      totalLabel: "Partners",
      segments: [
        { label: "Multi-platform", value: 81 },
        { label: "Single platform", value: 52 },
        { label: "No account", value: 9 },
      ],
    },
    {
      kind: "columns",
      icon: "chart",
      title: "Account Distribution",
      note: "214 linked platform accounts",
      foot: "Counts represent accounts, not unique partners.",
      span: 3,
      rows: [
        { label: "Instagram", value: 119 },
        { label: "YouTube", value: 95 },
      ],
    },
    {
      kind: "checks",
      icon: "check",
      title: "Partner Health",
      note: "Independent readiness dimensions",
      foot: "Check readiness without exposing restricted identity data.",
      span: 3,
      rows: [
        { label: "Manager assigned", detail: "138 / 142", badge: "Coverage" },
        { label: "Profile complete", detail: "129 / 142", badge: "Coverage" },
        { label: "Platform linked", detail: "133 / 142", badge: "Coverage" },
        { label: "Campaign active", detail: "61 / 142", badge: "Current" },
      ],
    },
  ],
  bottomPanels: [
    {
      kind: "rank",
      icon: "search",
      title: "Top Regions",
      note: "Partners by assigned region",
      foot: "142 partners across the sample portfolio.",
      span: 3,
      rows: [
        { name: "Karnataka", value: "58", initials: initialsOf("Karnataka") },
        { name: "Kerala", value: "47", initials: initialsOf("Kerala") },
        { name: "Tamil Nadu", value: "37", initials: initialsOf("Tamil Nadu") },
      ],
    },
    {
      kind: "attention",
      icon: "alert",
      title: "Exceptions",
      note: "Groups can overlap",
      foot: "Sensitive details remain in authorized record views.",
      span: 3,
      rows: [
        { title: "No platform account", detail: "Link", count: "9" },
        { title: "Incomplete profile", detail: "Review", count: "13" },
        { title: "No manager assigned", detail: "Assign", count: "4" },
        { title: "Blacklisted partners", detail: "Inspect", count: "3" },
      ],
    },
    {
      kind: "activity",
      icon: "clock",
      title: "Recent Activity",
      note: "Latest meaningful changes",
      foot: "Full history stays in the workspace.",
      span: 3,
      rows: [
        { title: "Partner activated", detail: "Ananya Rao · 2 min ago", href: "/partners/ananya-rao" },
        { title: "YouTube account linked", detail: "Arjun Nair · 17 min ago", href: "/partners/arjun-nair" },
        { title: "Profile information updated", detail: "Kavya Iyer · 1 hour ago", href: "/partners/kavya-iyer" },
        { title: "Region assignment changed", detail: "Meera Das · 3 hours ago", href: "/partners/meera-das" },
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
        { label: "Partner workspace", icon: "users" },
        { label: "Review profiles", icon: "search" },
        { label: "Linked accounts", icon: "brief" },
        { label: "Add partner", icon: "flag" },
      ],
    },
  ],
};

const PEOPLE: [string, string, string, string, string][] = [
  ["Ananya Rao", "Culture & society", "Kerala", "Meera Das", "Active"],
  ["Arjun Nair", "Regional storytelling", "Kerala", "Meera Das", "Active"],
  ["Kavya Iyer", "Travel & culture", "Tamil Nadu", "Arjun Nair", "Pending"],
  ["Meera Das", "Community & education", "Maharashtra", "Ananya Rao", "Active"],
  ["Rohan Shah", "History & heritage", "Maharashtra", "Ananya Rao", "Inactive"],
  ["Tara Menon", "Everyday stories", "Karnataka", "Arjun Nair", "Active"],
];

function slug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

const PARTNERS: RecordRow[] = PEOPLE.map(([name, sub, region, owner, status]) => ({
  id: slug(name),
  name,
  sub,
  status,
  type: "Partner profile",
  region,
  owner,
  initials: initialsOf(name),
}));

export const partnersWorkspace: ModuleWorkspace = {
  recordLabel: "Record",
  columns: { record: "Record", status: "Status", context: "Context", region: "Region", owner: "Owner" },
  rows: PARTNERS,
};

export function getPartner(id: string): RecordRow | undefined {
  return PARTNERS.find((partner) => partner.id === id);
}

export function getPartnerDetail(id: string): RecordDetail | undefined {
  const record = getPartner(id);
  if (!record) return undefined;
  return {
    record,
    lastUpdated: "14 Sep 2026 · 10:24",
    contextCopy:
      "A single operational record with connected ownership, source context, and relationship history. Additional information stays organized in focused sections.",
    kv: [
      { label: "Record type", value: record.type },
      { label: "Owner", value: record.owner },
      { label: "Region", value: record.region },
      { label: "Reporting period", value: "September 2026" },
    ],
    linked: { title: "Community Stories", detail: "Campaign · active", tone: "green", badge: "Active" },
    note: {
      body: "Brief confirmed with the partner. Review the first draft before scheduling publication.",
      author: "Meera Das",
      date: "14 Sep, 09:40",
    },
  };
}

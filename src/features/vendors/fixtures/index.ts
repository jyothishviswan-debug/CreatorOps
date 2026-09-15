// Ported from the golden master's OV_DATA.partners (old polymorphic
// "Partners" module maps to our canonical "Vendors") and workspaceRows()
// 'partners' case (docs/reference/CreatorOps_UI_Golden_Master.html). Sample
// copy normalized to canonical terminology (creator -> partner).
import type { ModuleOverview, ModuleWorkspace, RecordDetail, RecordRow } from "@/features/shared/types";
import { initialsOf } from "@/features/shared/types";

export const vendorsOverview: ModuleOverview = {
  eyebrow: "FIND & ONBOARD",
  title: "Vendors",
  description: "Relationship coverage, ownership and business readiness.",
  summary: "Vendor relationship cockpit",
  kpis: [
    { icon: "brief", label: "Total vendors", value: "58", hint: "relationship records" },
    { icon: "check", label: "Active vendors", value: "51", hint: "87.9% of vendors" },
    { icon: "users", label: "Linked partners", value: "96", hint: "distinct partners" },
    { icon: "flag", label: "Campaign engaged", value: "23", hint: "current period" },
  ],
  topPanels: [
    {
      kind: "donut",
      icon: "brief",
      title: "Vendor Status",
      note: "58 vendor records",
      foot: "87.9% of vendor relationships are active.",
      span: 3,
      total: 58,
      totalLabel: "Vendors",
      segments: [
        { label: "Active", value: 51 },
        { label: "Pending", value: 4 },
        { label: "Inactive", value: 3 },
      ],
    },
    {
      kind: "donut",
      icon: "users",
      title: "Vendor Type",
      note: "Exclusive sample categories",
      foot: "Representation and partner identity stay separate.",
      span: 3,
      total: 58,
      totalLabel: "Vendors",
      segments: [
        { label: "Agency", value: 21 },
        { label: "Manager", value: 18 },
        { label: "Payee", value: 11 },
        { label: "Other", value: 8 },
      ],
    },
    {
      kind: "donut",
      icon: "grid",
      title: "Business Structure",
      note: "58 vendor records",
      foot: "Each relationship retains its own business context.",
      span: 3,
      total: 58,
      totalLabel: "Vendors",
      segments: [
        { label: "Organization", value: 39 },
        { label: "Individual", value: 19 },
      ],
    },
    {
      kind: "checks",
      icon: "check",
      title: "Relationship Health",
      note: "Ownership and relationship coverage",
      foot: "Linked partners are distinct across the portfolio.",
      span: 3,
      rows: [
        { label: "Owner assigned", detail: "55 / 58", badge: "Coverage" },
        { label: "Contact complete", detail: "52 / 58", badge: "Coverage" },
        { label: "Campaign engaged", detail: "23 / 58", badge: "Current" },
        { label: "Partners linked", detail: "96", badge: "Distinct" },
      ],
    },
  ],
  bottomPanels: [
    {
      kind: "rank",
      icon: "search",
      title: "Regional Coverage",
      note: "Vendors by assigned region",
      foot: "All 58 vendor records included.",
      span: 3,
      rows: [
        { name: "Karnataka", value: "25", initials: initialsOf("Karnataka") },
        { name: "Kerala", value: "19", initials: initialsOf("Kerala") },
        { name: "Tamil Nadu", value: "14", initials: initialsOf("Tamil Nadu") },
      ],
    },
    {
      kind: "attention",
      icon: "alert",
      title: "Needs Attention",
      note: "Review queues · may overlap",
      foot: "Resolve ownership before expanding a relationship.",
      span: 3,
      rows: [
        { title: "Contact missing", detail: "Update", count: "6" },
        { title: "Owner unassigned", detail: "Assign", count: "3" },
        { title: "Concentration review", detail: "Review", count: "2" },
        { title: "Pending relationship", detail: "Review", count: "4" },
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
        { title: "Partner linked", detail: "Creator House · 15 min ago", href: "/vendors/creator-house" },
        { title: "Contact information updated", detail: "South Creators · 1 hour ago", href: "/vendors/south-creators" },
        { title: "Vendor activated", detail: "Regional Media · 4 hours ago", href: "/vendors/regional-media" },
        { title: "Campaign relationship linked", detail: "Varahe Network · 1 day ago", href: "/vendors/varahe-network" },
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
        { label: "Vendor workspace", icon: "brief" },
        { label: "Review relationships", icon: "search" },
        { label: "Contact gaps", icon: "alert" },
        { label: "Add vendor", icon: "flag" },
      ],
    },
  ],
};

const VENDORS_BASE: [string, string, string, string, string][] = [
  ["Creator House", "Talent management agency", "Kerala", "Meera Das", "Active"],
  ["South Creators", "Regional talent collective", "Kerala", "Meera Das", "Active"],
  ["Regional Media", "Content production house", "Tamil Nadu", "Arjun Nair", "Pending"],
  ["Varahe Network", "Multi-channel network", "Maharashtra", "Ananya Rao", "Active"],
  ["Civic Voices", "Independent representation", "Maharashtra", "Ananya Rao", "Inactive"],
  ["Local Decode", "Talent management agency", "Karnataka", "Arjun Nair", "Active"],
];

function slug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

const VENDORS: RecordRow[] = VENDORS_BASE.map(([name, sub, region, owner, status]) => ({
  id: slug(name),
  name,
  sub,
  status,
  type: "Vendor relationship",
  region,
  owner,
  initials: initialsOf(name),
}));

export const vendorsWorkspace: ModuleWorkspace = {
  recordLabel: "Record",
  columns: { record: "Record", status: "Status", context: "Context", region: "Region", owner: "Owner" },
  rows: VENDORS,
};

export function getVendor(id: string): RecordRow | undefined {
  return VENDORS.find((vendor) => vendor.id === id);
}

export function getVendorDetail(id: string): RecordDetail | undefined {
  const record = getVendor(id);
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
      body: "Brief confirmed with the vendor. Review the first draft before scheduling publication.",
      author: "Meera Das",
      date: "14 Sep, 09:40",
    },
  };
}

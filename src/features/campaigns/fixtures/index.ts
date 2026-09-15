// Ported from the golden master's OV_DATA.campaigns and workspaceRows()
// 'campaigns' case (docs/reference/CreatorOps_UI_Golden_Master.html).
// Sample copy normalized to canonical terminology (creator -> partner).
import type { ModuleOverview, ModuleWorkspace, RecordDetail, RecordRow } from "@/features/shared/types";
import { initialsOf } from "@/features/shared/types";

export const campaignsOverview: ModuleOverview = {
  eyebrow: "PLAN & DELIVER",
  title: "Campaigns",
  description: "Staff campaigns, keep delivery moving and resolve exceptions.",
  summary: "Campaign execution cockpit",
  kpis: [
    { icon: "flag", label: "Active campaigns", value: "18", hint: "current period" },
    { icon: "users", label: "Partners staffed", value: "91", hint: "distinct partners" },
    { icon: "check", label: "Content completed", value: "128", hint: "of 164 required" },
    { icon: "alert", label: "Overdue content", value: "8", hint: "needs action" },
  ],
  topPanels: [
    {
      kind: "campaignboard",
      icon: "flag",
      title: "Campaign Execution",
      note: "Completed / required deliverables",
      foot: "128 / 164 completed across these four sample campaigns.",
      span: 6,
      rows: [
        { name: "Civic Voices", completed: 32, required: 40 },
        { name: "Youth Pulse", completed: 28, required: 36 },
        { name: "Regional First", completed: 38, required: 48 },
        { name: "Education Drive", completed: 30, required: 40 },
      ],
    },
    {
      kind: "donut",
      icon: "check",
      title: "Delivery State",
      note: "164 required deliverables",
      foot: "Overdue is a separate date condition, not a lifecycle state.",
      span: 3,
      total: 164,
      totalLabel: "Total",
      healthPalette: true,
      segments: [
        { label: "Completed", value: 128 },
        { label: "In progress", value: 20 },
        { label: "Not started", value: 16 },
      ],
    },
    {
      kind: "donut",
      icon: "users",
      title: "Staffing Readiness",
      note: "18 active campaigns",
      foot: "5 campaigns still need staffing decisions.",
      span: 3,
      total: 18,
      totalLabel: "Campaigns",
      segments: [
        { label: "Fully staffed", value: 13 },
        { label: "Partially staffed", value: 4 },
        { label: "Unstaffed", value: 1 },
      ],
    },
  ],
  bottomPanels: [
    {
      kind: "checks",
      icon: "check",
      title: "Tracking Readiness",
      note: "Campaign readiness dimensions",
      foot: "Analytics and Finance retain their own data ownership.",
      span: 3,
      rows: [
        { label: "Tracking configured", detail: "15 / 18", badge: "Coverage" },
        { label: "Source links complete", detail: "14 / 18", badge: "Coverage" },
        { label: "Reporting eligible", detail: "12 / 18", badge: "Coverage" },
        { label: "Campaigns unstaffed", detail: "1", badge: "Action" },
      ],
    },
    {
      kind: "attention",
      icon: "alert",
      title: "Execution Exceptions",
      note: "Attention across active campaigns",
      foot: "Open the campaign for exact owners and due dates.",
      span: 3,
      rows: [
        { title: "Overdue deliverables", detail: "Review", count: "8" },
        { title: "Missing source links", detail: "Resolve", count: "5" },
        { title: "Partially staffed", detail: "Assign", count: "4" },
        { title: "Unstaffed campaign", detail: "Assign", count: "1" },
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
        { title: "Content published", detail: "Civic Voices · 12 min ago", href: "/campaigns/civic-voices" },
        { title: "Partner assigned", detail: "Youth Pulse · 45 min ago", href: "/campaigns/youth-pulse" },
        { title: "Brief updated", detail: "Regional First · 2 hours ago", href: "/campaigns/regional-first" },
        { title: "Deliverable approved", detail: "Education Drive · 3 hours ago", href: "/campaigns/education-drive" },
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
        { label: "Campaign workspace", icon: "flag" },
        { label: "Due deliverables", icon: "clock" },
        { label: "Staffing gaps", icon: "users" },
        { label: "Add campaign", icon: "check" },
      ],
    },
  ],
};

// [personName, region, owner] per base people[] row - the campaign's "owner"
// sub-label uses the person's own name, while the table Owner column uses
// the base people[] owner field (a different person), exactly as the source.
const PEOPLE: [string, string, string][] = [
  ["Ananya Rao", "Kerala", "Meera Das"],
  ["Arjun Nair", "Kerala", "Meera Das"],
  ["Kavya Iyer", "Tamil Nadu", "Arjun Nair"],
  ["Meera Das", "Maharashtra", "Ananya Rao"],
  ["Rohan Shah", "Maharashtra", "Ananya Rao"],
  ["Tara Menon", "Karnataka", "Arjun Nair"],
];

const CAMPAIGN_NAMES = ["Civic Voices", "Youth Pulse", "Regional First", "Education Drive", "Local Lens", "City Stories"];
const STATUSES = ["Active", "Active", "Draft", "Active", "Completed", "Draft"];

function slug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

const CAMPAIGNS: RecordRow[] = CAMPAIGN_NAMES.map((name, i) => ({
  id: slug(name),
  name,
  sub: `${PEOPLE[i][0]} · Campaign owner`,
  status: STATUSES[i],
  type: "Campaign",
  region: PEOPLE[i][1],
  owner: PEOPLE[i][2],
  initials: initialsOf(name),
}));

export const campaignsWorkspace: ModuleWorkspace = {
  recordLabel: "Record",
  columns: { record: "Record", status: "Status", context: "Context", region: "Region", owner: "Owner" },
  rows: CAMPAIGNS,
};

export function getCampaign(id: string): RecordRow | undefined {
  return CAMPAIGNS.find((campaign) => campaign.id === id);
}

export function getCampaignDetail(id: string): RecordDetail | undefined {
  const record = getCampaign(id);
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
      body: "Brief confirmed with the team. Review the first draft before scheduling publication.",
      author: "Meera Das",
      date: "14 Sep, 09:40",
    },
  };
}

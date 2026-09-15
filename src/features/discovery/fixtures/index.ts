// Ported from the golden master's OV_DATA.discovery, workspaceRows() (module
// 'discovery'), and the generic detailPage() pattern
// (docs/reference/CreatorOps_UI_Golden_Master.html). Sample copy normalized
// to canonical terminology (creator -> partner).
import type { ModuleOverview, ModuleWorkspace, RecordDetail, RecordRow } from "@/features/shared/types";
import { initialsOf } from "@/features/shared/types";

export const discoveryOverview: ModuleOverview = {
  eyebrow: "FIND & ONBOARD",
  title: "Discovery",
  description: "Move the right prospects from first contact to partner.",
  summary: "Discovery pipeline intelligence",
  kpis: [
    { icon: "search", label: "Total leads", value: "68", hint: "current scope" },
    { icon: "flag", label: "New this week", value: "12", hint: "newly identified" },
    { icon: "check", label: "Shortlisted", value: "24", hint: "current stage" },
    { icon: "users", label: "Converted", value: "7", hint: "linked to partners" },
    { icon: "alert", label: "Needs attention", value: "10", hint: "unique leads" },
  ],
  topPanels: [
    {
      kind: "funnel",
      icon: "layers",
      title: "Discovery Pipeline",
      note: "Cumulative stage reach · current scope",
      foot: "7 / 68 converted · 10.3% conversion · stages are cumulative.",
      span: 6,
      rows: [
        { label: "Identified", value: 68 },
        { label: "Shortlisted", value: 42 },
        { label: "Outreach sent", value: 31 },
        { label: "In conversation", value: 17 },
        { label: "Converted", value: 7 },
      ],
    },
    {
      kind: "donut",
      icon: "search",
      title: "Outreach State",
      note: "68 leads · current contact state",
      foot: "10 leads have responded; open the contact queue.",
      span: 3,
      total: 68,
      totalLabel: "Leads",
      segments: [
        { label: "Not contacted", value: 31 },
        { label: "Contacted", value: 22 },
        { label: "Responded", value: 10 },
        { label: "No response", value: 5 },
      ],
    },
    {
      kind: "columns",
      icon: "chart",
      title: "Sourcing Performance",
      note: "Lead count by recorded source",
      foot: "Research contributes 47.1% of this lead sample.",
      span: 3,
      rows: [
        { label: "Research", value: 32 },
        { label: "Referral", value: 21 },
        { label: "Inbound", value: 15 },
      ],
    },
  ],
  bottomPanels: [
    {
      kind: "checks",
      icon: "check",
      title: "Conversion Readiness",
      note: "Independent requirements",
      foot: "Open a lead to inspect all transition requirements.",
      span: 3,
      rows: [
        { label: "Profile complete", detail: "52 / 68", badge: "Coverage" },
        { label: "Platform verified", detail: "47 / 68", badge: "Coverage" },
        { label: "Evidence reviewed", detail: "31 / 68", badge: "Coverage" },
        { label: "Ready to convert", detail: "7", badge: "Ready" },
      ],
    },
    {
      kind: "attention",
      icon: "alert",
      title: "Needs Attention",
      note: "Groups can overlap",
      foot: "Overview summarizes queues; it does not skip stages.",
      span: 3,
      rows: [
        { title: "Overdue follow-ups", detail: "Contact", count: "3" },
        { title: "No outreach logged", detail: "Review", count: "5" },
        { title: "Awaiting evaluation", detail: "Evaluate", count: "2" },
        { title: "Awaiting research", detail: "Research", count: "4" },
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
        { title: "Lead shortlisted", detail: "Nila Talks · 18 min ago" },
        { title: "Contact response received", detail: "Local Decode · 1 hour ago" },
        { title: "Partner conversion completed", detail: "South Lens · 3 hours ago" },
        { title: "Research evidence added", detail: "Civic Voice · 1 day ago" },
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
        { label: "Research queue", icon: "search" },
        { label: "Contact due", icon: "clock" },
        { label: "Conversion-ready leads", icon: "check" },
        { label: "Open workspace", icon: "grid" },
      ],
    },
  ],
};

const PEOPLE: [string, string, string, string][] = [
  ["Ananya Rao", "Culture & society", "Kerala", "Meera Das"],
  ["Arjun Nair", "Regional storytelling", "Kerala", "Meera Das"],
  ["Kavya Iyer", "Travel & culture", "Tamil Nadu", "Arjun Nair"],
  ["Meera Das", "Community & education", "Maharashtra", "Ananya Rao"],
  ["Rohan Shah", "History & heritage", "Maharashtra", "Ananya Rao"],
  ["Tara Menon", "Everyday stories", "Karnataka", "Arjun Nair"],
];

const STATUSES = ["Researching", "Contacted", "Under review", "Ready for conversion", "Watch list", "Negotiation"];

function slug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

const LEADS: RecordRow[] = PEOPLE.map(([name, sub, region, owner], i) => ({
  id: slug(name),
  name,
  sub,
  status: STATUSES[i],
  type: "Instagram lead",
  region,
  owner,
  initials: initialsOf(name),
}));

export const discoveryWorkspace: ModuleWorkspace = {
  recordLabel: "Record",
  columns: { record: "Record", status: "Status", context: "Context", region: "Region", owner: "Owner" },
  rows: LEADS,
};

export function getDiscoveryLead(id: string): RecordRow | undefined {
  return LEADS.find((lead) => lead.id === id);
}

export function getDiscoveryLeadDetail(id: string): RecordDetail | undefined {
  const record = getDiscoveryLead(id);
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

// Ported from the golden master's OV_DATA.reports and workspaceRows()
// 'reports' case (docs/reference/CreatorOps_UI_Golden_Master.html). Sample
// copy normalized to canonical terminology (creator -> partner).
import type { ModuleOverview, ModuleWorkspace, RecordDetail, RecordRow } from "@/features/shared/types";
import { initialsOf } from "@/features/shared/types";

export const reportsOverview: ModuleOverview = {
  eyebrow: "ACT & REPORT",
  title: "Reports",
  description: "Find governed report families and review saved outputs.",
  summary: "Reporting governance",
  kpis: [
    { icon: "layers", label: "Report families", value: "4", hint: "available in this preview" },
    { icon: "file", label: "Saved reports", value: "37", hint: "current scope" },
    { icon: "check", label: "Finalized", value: "23", hint: "versioned snapshots" },
    { icon: "download", label: "Ready artifacts", value: "27", hint: "generated files" },
  ],
  topPanels: [
    {
      kind: "catalog",
      icon: "layers",
      title: "Report Catalog",
      note: "Four report families in this design preview",
      foot: "Choose a report family; inspect verified metrics before finalization.",
      span: 6,
      rows: [
        { title: "Monthly Partner", detail: "Production, compliance and performance" },
        { title: "Campaign / Event", detail: "Delivery and native platform outcomes" },
        { title: "Cross-platform", detail: "Comparable metrics, separate native measures" },
        { title: "Long-period", detail: "Verified period-by-period evidence" },
      ],
    },
    {
      kind: "donut",
      icon: "file",
      title: "Report Lifecycle",
      note: "37 saved report records",
      foot: "Finalized reports retain versioned metric snapshots.",
      span: 3,
      total: 37,
      totalLabel: "Reports",
      segments: [
        { label: "Draft", value: 8 },
        { label: "In review", value: 4 },
        { label: "Finalized", value: 23 },
        { label: "Failed", value: 2 },
      ],
    },
    {
      kind: "donut",
      icon: "download",
      title: "Ready Artifacts",
      note: "27 generated output files",
      foot: "An artifact is an output file, not a separate report.",
      span: 3,
      total: 27,
      totalLabel: "Files",
      segments: [
        { label: "PDF", value: 18 },
        { label: "XLSX", value: 6 },
        { label: "CSV", value: 3 },
      ],
    },
  ],
  bottomPanels: [
    {
      kind: "attention",
      icon: "alert",
      title: "Quality & Review",
      note: "Source and generation exceptions",
      foot: "Corrections create a new reviewed snapshot.",
      span: 3,
      rows: [
        { title: "Awaiting review", detail: "Review", count: "4" },
        { title: "Generation failed", detail: "Inspect", count: "2" },
        { title: "Source updates", detail: "Compare", count: "3" },
        { title: "Draft reports", detail: "Continue", count: "8" },
      ],
    },
    {
      kind: "checks",
      icon: "shield",
      title: "Report Governance",
      note: "Design contract · not a live system audit",
      foot: "Narrative interprets metrics; it never invents them.",
      span: 3,
      rows: [
        { label: "Metric provenance", detail: "Source-linked", badge: "Required" },
        { label: "Final snapshots", detail: "Versioned", badge: "Required" },
        { label: "Narrative", detail: "Reviewable", badge: "Required" },
        { label: "Export access", detail: "Scoped", badge: "Required" },
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
        { title: "Partner review finalized", detail: "August summary · 25 min ago", href: "/reports/monthly-partner-review" },
        { title: "Campaign draft saved", detail: "Civic Voices · 2 hours ago", href: "/reports/campaign-completion-report" },
        { title: "PDF generated", detail: "Regional report · 4 hours ago", href: "/reports/regional-programme-review" },
        { title: "Source revision detected", detail: "Monthly review · 1 day ago", href: "/reports/monthly-partner-review" },
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
        { label: "Report catalog", icon: "layers" },
        { label: "Saved reports", icon: "file" },
        { label: "Artifact history", icon: "download" },
        { label: "Open workspace", icon: "grid" },
      ],
    },
  ],
};

const NAMES = [
  "Monthly Partner Review",
  "Community Stories Performance",
  "Cross-platform Overview",
  "Regional Programme Review",
  "Quarterly Partner Summary",
  "Campaign Completion Report",
];
const STATUSES = ["Finalized", "Draft", "In review", "Finalized", "Draft", "Finalized"];
const FORMATS = ["PDF", "XLSX", "PDF", "XLSX", "PDF", "XLSX"];
const OWNERS: [string, string][] = [
  ["Meera Das", "Kerala"],
  ["Ananya Rao", "Kerala"],
  ["Arjun Nair", "Tamil Nadu"],
  ["Meera Das", "Maharashtra"],
  ["Ananya Rao", "Maharashtra"],
  ["Arjun Nair", "Karnataka"],
];

function slug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

const REPORTS: RecordRow[] = NAMES.map((name, i) => ({
  id: slug(name),
  name,
  sub: "September 2026 · Saved report",
  status: STATUSES[i],
  type: FORMATS[i],
  region: OWNERS[i][1],
  owner: OWNERS[i][0],
  initials: initialsOf(name),
}));

export const reportsWorkspace: ModuleWorkspace = {
  recordLabel: "Report",
  columns: { record: "Report", status: "Status", context: "Format", region: "Region", owner: "Owner" },
  rows: REPORTS,
};

export function getReportRun(id: string): RecordRow | undefined {
  return REPORTS.find((r) => r.id === id);
}

export function getReportRunDetail(id: string): RecordDetail | undefined {
  const record = getReportRun(id);
  if (!record) return undefined;
  return {
    record,
    lastUpdated: "14 Sep 2026 · 10:24",
    contextCopy:
      "A single report run with connected provenance, review status, and generated artifacts. Additional information stays organized in focused sections.",
    kv: [
      { label: "Format", value: record.type },
      { label: "Owner", value: record.owner },
      { label: "Region", value: record.region },
      { label: "Reporting period", value: "September 2026" },
    ],
    linked: { title: "Community Stories", detail: "Campaign · active", tone: "green", badge: "Active" },
    note: {
      body: "Metric provenance verified against source snapshots before finalization.",
      author: "Meera Das",
      date: "14 Sep, 09:40",
    },
  };
}

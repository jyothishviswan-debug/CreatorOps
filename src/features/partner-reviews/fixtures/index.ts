// Ported from the golden master's OV_DATA["creator-reviews"] (old
// "Creator Reviews" module maps to our canonical "Partner Reviews")
// (docs/reference/CreatorOps_UI_Golden_Master.html). "distribution" panel
// kind rendered via the existing donut component (proportional segments +
// legend, same visual purpose, no separate stacked-bar component built for
// this one use). Sample copy normalized (creator -> partner, deliverable ->
// content). Module intent keeps Production / Compliance / Performance
// distinct, matching the source's three top panels here.
import type { ModuleOverview, ModuleWorkspace, RecordDetail, RecordRow } from "@/features/shared/types";
import { initialsOf } from "@/features/shared/types";

export const partnerReviewsOverview: ModuleOverview = {
  eyebrow: "MEASURE & REVIEW",
  title: "Partner Reviews",
  description: "Review production, compliance and performance independently.",
  summary: "Monthly review intelligence",
  kpis: [
    { icon: "file", label: "Monthly summaries", value: "94", hint: "August 2026" },
    { icon: "check", label: "Assignments received", value: "188", hint: "current period" },
    { icon: "flag", label: "Completed content", value: "128", hint: "of 164 required" },
    { icon: "shield", label: "Finalized reviews", value: "65", hint: "of 94 summaries" },
  ],
  topPanels: [
    {
      kind: "columns",
      icon: "file",
      title: "Production Summary",
      note: "Content · overlapping workflow stages",
      foot: "188 assignments received · 164 content items required.",
      span: 4,
      rows: [
        { label: "Required", value: 164 },
        { label: "Submitted", value: 148 },
        { label: "Approved", value: 136 },
        { label: "Completed", value: 128 },
      ],
    },
    {
      kind: "donut",
      icon: "clock",
      title: "Submission Timeliness",
      note: "148 submitted content items",
      foot: "89.2% submitted on time · compliance stays separate.",
      span: 4,
      total: 148,
      totalLabel: "Submitted",
      segments: [
        { label: "On time", value: 132 },
        { label: "Late", value: 16 },
      ],
    },
    {
      kind: "donut",
      icon: "chart",
      title: "Performance Evidence",
      note: "94 monthly partner summaries",
      foot: "Performance is evidence-based, never a composite score.",
      span: 4,
      total: 94,
      totalLabel: "Summaries",
      segments: [
        { label: "Available", value: 78 },
        { label: "Stale", value: 4 },
        { label: "Missing", value: 12 },
      ],
    },
  ],
  bottomPanels: [
    {
      kind: "donut",
      icon: "layers",
      title: "Review Lifecycle",
      note: "94 monthly summaries",
      foot: "65 finalized · 29 awaiting completion.",
      span: 3,
      total: 94,
      totalLabel: "Summaries",
      segments: [
        { label: "Needs review", value: 18 },
        { label: "Draft / in review", value: 11 },
        { label: "Finalized", value: 65 },
      ],
    },
    {
      kind: "attention",
      icon: "alert",
      title: "Needs Attention",
      note: "Separate review dimensions",
      foot: "Production, compliance and performance remain independent.",
      span: 3,
      rows: [
        { title: "Stale evidence", detail: "Refresh", count: "4" },
        { title: "Missing evidence", detail: "Check", count: "12" },
        { title: "Late submissions", detail: "Review", count: "16" },
        { title: "Draft reviews", detail: "Continue", count: "11" },
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
        { title: "Review finalized", detail: "Ananya Rao · 12 min ago", href: "/partner-reviews/ananya-rao" },
        { title: "Review finalized", detail: "Meera Das · 1 hour ago", href: "/partner-reviews/meera-das" },
        { title: "Evidence refreshed", detail: "Tara Menon · 2 hours ago", href: "/partner-reviews/tara-menon" },
        { title: "Review finalized", detail: "Arjun Nair · 3 hours ago", href: "/partner-reviews/arjun-nair" },
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
        { label: "Review queue", icon: "search" },
        { label: "Draft summaries", icon: "file" },
        { label: "Finalized history", icon: "check" },
        { label: "Open workspace", icon: "grid" },
      ],
    },
  ],
};

const PEOPLE: [string, string, string, string][] = [
  ["Ananya Rao", "Kerala", "Meera Das", "Finalized"],
  ["Arjun Nair", "Kerala", "Meera Das", "Draft"],
  ["Kavya Iyer", "Tamil Nadu", "Arjun Nair", "Needs review"],
  ["Meera Das", "Maharashtra", "Ananya Rao", "Finalized"],
  ["Rohan Shah", "Maharashtra", "Ananya Rao", "Draft"],
  ["Tara Menon", "Karnataka", "Arjun Nair", "Finalized"],
];

function slug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

const REVIEWS: RecordRow[] = PEOPLE.map(([name, region, owner, status]) => ({
  id: slug(name),
  name: `${name} · August review`,
  sub: "September 2026 · Monthly review",
  status,
  type: "Partner review",
  region,
  owner,
  initials: initialsOf(name),
}));

export const partnerReviewsWorkspace: ModuleWorkspace = {
  recordLabel: "Review",
  columns: { record: "Review", status: "Status", context: "Context", region: "Region", owner: "Owner" },
  rows: REVIEWS,
};

export function getPartnerReview(id: string): RecordRow | undefined {
  return REVIEWS.find((r) => r.id === id);
}

export function getPartnerReviewDetail(id: string): RecordDetail | undefined {
  const record = getPartnerReview(id);
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
      body: "Performance evidence reviewed against the campaign brief. Compliance remains a separate dimension.",
      author: "Meera Das",
      date: "14 Sep, 09:40",
    },
  };
}

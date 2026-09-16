// Ported from the golden master's OV_DATA.analytics
// (docs/reference/CreatorOps_UI_Golden_Master.html). Sample copy normalized
// to canonical terminology (creator -> partner).
import type { ModuleOverview } from "@/features/shared/types";

export const analyticsOverview: ModuleOverview = {
  eyebrow: "MEASURE & REVIEW",
  title: "Analytics",
  description: "Read native platform metrics with visible source quality.",
  summary: "Platform performance intelligence",
  kpis: [
    { icon: "chart", label: "Instagram reach", value: "18.4M", hint: "source-reported" },
    { icon: "chart", label: "YouTube views", value: "12.7M", hint: "source-reported" },
    { icon: "file", label: "Published content", value: "815", hint: "389 IG · 426 YT" },
    { icon: "flag", label: "Interactions", value: "1.62M", hint: "recorded actions" },
    { icon: "alert", label: "Ingestion exceptions", value: "13", hint: "needs review" },
  ],
  topPanels: [
    {
      kind: "trends",
      icon: "chart",
      title: "Native Platform Trends",
      note: "Millions · Apr–Aug 2026",
      foot: "Source-reported metrics; never substitute reach for views.",
      span: 6,
      series: [
        { label: "Instagram reach", color: "#2878fa", unit: "M", values: [12.1, 14.2, 13.6, 16.8, 18.4] },
        { label: "YouTube views", color: "#8b4aff", unit: "M", values: [8.2, 9.4, 10.1, 11.6, 12.7] },
      ],
    },
    {
      kind: "donut",
      icon: "file",
      title: "Published Content",
      note: "815 source content records",
      foot: "Content counts are comparable across the two platforms.",
      span: 3,
      total: 815,
      totalLabel: "Content",
      segments: [
        { label: "Instagram", value: 389 },
        { label: "YouTube", value: 426 },
      ],
    },
    {
      kind: "donut",
      icon: "flag",
      title: "Engagement Actions",
      note: "1.62M recorded interactions",
      foot: "Counts come from the explicit sample values.",
      span: 3,
      total: 1620000,
      totalLabel: "Actions",
      segments: [
        { label: "Likes & reactions", value: 1240000 },
        { label: "Shares", value: 230000 },
        { label: "Comments", value: 150000 },
      ],
    },
  ],
  bottomPanels: [
    {
      kind: "rank",
      icon: "users",
      title: "Top Partners",
      note: "Ranked by recorded interactions",
      foot: "No hidden blended performance score.",
      span: 3,
      rows: [
        { name: "Nila Talks", value: "94K", initials: "NT" },
        { name: "Local Decode", value: "82K", initials: "LD" },
        { name: "Public Pulse", value: "71K", initials: "PP" },
        { name: "South Lens", value: "65K", initials: "SL" },
      ],
    },
    {
      kind: "attention",
      icon: "alert",
      title: "Ingestion Exceptions",
      note: "13 sample ingestion exceptions",
      foot: "Unavailable values must not appear as zero.",
      span: 3,
      rows: [
        { title: "Unlinked content", detail: "Resolve", count: "7" },
        { title: "Unmatched partners", detail: "Match", count: "3" },
        { title: "Stale import batches", detail: "Refresh", count: "3" },
      ],
    },
    {
      kind: "checks",
      icon: "check",
      title: "Data Freshness",
      note: "Snapshot freshness · August sample",
      foot: "Metrics remain traceable to their source snapshot.",
      span: 3,
      rows: [
        { label: "Instagram source", detail: "31 Aug", badge: "Current" },
        { label: "YouTube source", detail: "31 Aug", badge: "Current" },
        { label: "Campaign linkage", detail: "Review", badge: "Partial" },
        { label: "Stale batches", detail: "3", badge: "Action" },
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
        { label: "Explore metrics", icon: "chart" },
        { label: "Import history", icon: "clock" },
        { label: "Compare partners", icon: "users" },
        { label: "Open explorer", icon: "search" },
      ],
    },
  ],
};

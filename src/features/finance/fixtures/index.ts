// Ported from the golden master's OV_DATA.finance and workspaceRows()
// 'finance' case (docs/reference/CreatorOps_UI_Golden_Master.html).
// "distribution" panel kind rendered via the existing donut component.
// Money values pre-formatted in Indian lakh notation matching the source's
// own KPI display, rather than adding a runtime currency formatter for one
// module. Sub-area records (agreements/payables/invoices/payments) reuse
// the same fixture rows, segmented by `area` - Finance has no separate
// workspaceRows shape per sub-area in the source.
import type { ModuleOverview, ModuleWorkspace, RecordDetail, RecordRow } from "@/features/shared/types";
import { initialsOf } from "@/features/shared/types";

export const financeOverview: ModuleOverview = {
  eyebrow: "FINANCE & SETTLE",
  title: "Finance",
  description: "Track payable workflow and reconcile settlement clearly.",
  summary: "Finance settlement cockpit",
  kpis: [
    { icon: "file", label: "Agreements", value: "48", hint: "active agreements" },
    { icon: "wallet", label: "Payables", value: "63", hint: "current period" },
    { icon: "alert", label: "Outstanding", value: "₹8.3L", hint: "gross unsettled" },
    { icon: "check", label: "Gross settled", value: "₹12.6L", hint: "recorded settlement" },
  ],
  topPanels: [
    {
      kind: "settlement",
      icon: "wallet",
      title: "Settlement Reconciliation",
      note: "Recorded settlement · INR",
      foot: "Net cash paid + TDS withheld = gross settled.",
      span: 4,
      heroLabel: "Gross settled",
      heroValue: "₹12,60,000",
      lines: [
        { label: "TDS withheld", value: "₹1,26,000" },
        { label: "Net cash paid", value: "₹11,34,000" },
      ],
    },
    {
      kind: "donut",
      icon: "check",
      title: "Payable Workflow",
      note: "63 payables · exclusive workflow states",
      foot: "Workflow state is distinct from payment evidence.",
      span: 4,
      total: 63,
      totalLabel: "Payables",
      segments: [
        { label: "Closed", value: 31 },
        { label: "Approved", value: 17 },
        { label: "Under review", value: 6 },
        { label: "Awaiting invoice", value: 9 },
      ],
    },
    {
      kind: "columns",
      icon: "clock",
      title: "Outstanding by Age",
      note: "Gross outstanding · INR",
      foot: "₹8.3L outstanding · ₹90,000 aged more than 30 days.",
      span: 4,
      rows: [
        { label: "0–7 days", value: 320000 },
        { label: "8–15 days", value: 240000 },
        { label: "16–30 days", value: 180000 },
        { label: "30+ days", value: 90000 },
      ],
    },
  ],
  bottomPanels: [
    {
      kind: "donut",
      icon: "file",
      title: "Invoice Health",
      note: "63 payable invoice states",
      foot: "Invoice status does not imply a payment was made.",
      span: 3,
      total: 63,
      totalLabel: "Invoices",
      segments: [
        { label: "Accepted", value: 44 },
        { label: "Submitted", value: 10 },
        { label: "Awaiting", value: 9 },
      ],
    },
    {
      kind: "attention",
      icon: "alert",
      title: "Financial Attention",
      note: "No payment execution in this preview",
      foot: "Payment remains subject to canonical approval rules.",
      span: 3,
      rows: [
        { title: "Approved for payment", detail: "Review", count: "17" },
        { title: "Under review", detail: "Review", count: "6" },
        { title: "Awaiting invoice", detail: "Follow up", count: "9" },
        { title: "Renewals approaching", detail: "Review", count: "6" },
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
        { title: "Payment recorded · ₹75,000", detail: "Creator House · 18 min ago", href: "/vendors/creator-house" },
        { title: "Payment recorded · ₹42,500", detail: "South Creators · 2 hours ago", href: "/vendors/south-creators" },
        { title: "Payment recorded · ₹1,20,000", detail: "Regional Media · 5 hours ago", href: "/vendors/regional-media" },
        { title: "Invoice received", detail: "Varahe Network · 1 day ago", href: "/vendors/varahe-network" },
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
        { label: "Payables", icon: "wallet" },
        { label: "Invoice queue", icon: "file" },
        { label: "Agreement renewals", icon: "check" },
        { label: "Payments", icon: "arrow" },
      ],
    },
  ],
};

type Area = "agreements" | "payables" | "invoices" | "payments";

const VENDORS: [string, string, string][] = [
  ["Creator House", "Kerala", "Meera Das"],
  ["South Creators", "Kerala", "Meera Das"],
  ["Regional Media", "Tamil Nadu", "Arjun Nair"],
  ["Varahe Network", "Maharashtra", "Ananya Rao"],
  ["Civic Voices", "Maharashtra", "Ananya Rao"],
  ["Local Decode", "Karnataka", "Arjun Nair"],
];

const AMOUNTS = ["35,000", "28,000", "42,000", "30,000", "25,000", "38,000"];
const STATUSES_BY_AREA: Record<Area, string[]> = {
  agreements: ["Active", "Active", "Renewal due", "Active", "Draft", "Active"],
  payables: ["Approved", "Paid", "In review", "Approved", "Pending", "Paid"],
  invoices: ["Accepted", "Accepted", "Submitted", "Accepted", "Awaiting", "Accepted"],
  payments: ["Recorded", "Recorded", "Scheduled", "Recorded", "Pending", "Recorded"],
};
const AREA_LABELS: Record<Area, string> = {
  agreements: "Service agreement",
  payables: "Monthly payable",
  invoices: "Invoice",
  payments: "Payment",
};

function slug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

function buildRows(area: Area): RecordRow[] {
  return VENDORS.map(([name, region, owner], i) => ({
    id: `${slug(name)}-${area}`,
    name: `${name} · September`,
    sub: `${AREA_LABELS[area]} · ₹${AMOUNTS[i]}`,
    status: STATUSES_BY_AREA[area][i],
    type: AREA_LABELS[area],
    region,
    owner,
    initials: initialsOf(name),
  }));
}

const WORKSPACES: Record<Area, ModuleWorkspace> = {
  agreements: {
    recordLabel: "Agreement",
    columns: { record: "Agreement", status: "Status", context: "Context", region: "Region", owner: "Owner" },
    rows: buildRows("agreements"),
  },
  payables: {
    recordLabel: "Payable",
    columns: { record: "Payable", status: "Status", context: "Context", region: "Region", owner: "Owner" },
    rows: buildRows("payables"),
  },
  invoices: {
    recordLabel: "Invoice",
    columns: { record: "Invoice", status: "Status", context: "Context", region: "Region", owner: "Owner" },
    rows: buildRows("invoices"),
  },
  payments: {
    recordLabel: "Payment",
    columns: { record: "Payment", status: "Status", context: "Context", region: "Region", owner: "Owner" },
    rows: buildRows("payments"),
  },
};

export function getFinanceWorkspace(area: Area): ModuleWorkspace {
  return WORKSPACES[area];
}

export function getFinanceRecordDetail(area: Area, id: string): RecordDetail | undefined {
  const record = WORKSPACES[area].rows.find((r) => r.id === id);
  if (!record) return undefined;
  return {
    record,
    lastUpdated: "14 Sep 2026 · 10:24",
    contextCopy: "A single financial record with connected ownership and settlement history.",
    kv: [
      { label: "Record type", value: record.type },
      { label: "Owner", value: record.owner },
      { label: "Region", value: record.region },
      { label: "Reporting period", value: "September 2026" },
    ],
    linked: { title: "Community Stories", detail: "Campaign · active", tone: "green", badge: "Active" },
    note: {
      body: "Payment remains subject to canonical approval rules; this preview does not execute payments.",
      author: "Meera Das",
      date: "14 Sep, 09:40",
    },
  };
}

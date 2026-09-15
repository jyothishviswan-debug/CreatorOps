// Ported from the golden master's OV_DATA.operations and workspaceRows()
// 'operations' case (docs/reference/CreatorOps_UI_Golden_Master.html). The
// module intent calls for "one Work Center for Tasks / Approvals /
// Reminders" - the three sub-areas segment the same task-record shape by
// kind, same technique used for Finance's four sub-areas.
import type { ModuleOverview, ModuleWorkspace, RecordRow } from "@/features/shared/types";
import { initialsOf } from "@/features/shared/types";

export const operationsOverview: ModuleOverview = {
  eyebrow: "ACT & REPORT",
  title: "Operations",
  description: "One work center for tasks, approvals and upcoming commitments.",
  summary: "Operational work center",
  kpis: [
    { icon: "check", label: "Open tasks", value: "24", hint: "includes blocked work" },
    { icon: "clock", label: "Due today", value: "5", hint: "scheduled tasks" },
    { icon: "alert", label: "Overdue", value: "6", hint: "subset of open tasks" },
    { icon: "shield", label: "Pending approvals", value: "7", hint: "waiting on you" },
  ],
  topPanels: [
    {
      kind: "attention",
      icon: "alert",
      title: "Priority Work",
      note: "Derived queues · groups may overlap",
      foot: "Next actions come from source records, not parallel workflow state.",
      span: 4,
      rows: [
        { title: "Overdue follow-ups", detail: "Open work", count: "6" },
        { title: "Blocked dependencies", detail: "Resolve", count: "4" },
        { title: "Approvals waiting", detail: "Review", count: "7" },
        { title: "Reminders due today", detail: "Open", count: "5" },
      ],
    },
    {
      kind: "donut",
      icon: "check",
      title: "Task Status",
      note: "65 tasks · 24 remain open or blocked",
      foot: "Overdue is a date condition and may overlap these states.",
      span: 4,
      total: 65,
      totalLabel: "Tasks",
      segments: [
        { label: "Open", value: 20 },
        { label: "Blocked", value: 4 },
        { label: "Done", value: 41 },
      ],
    },
    {
      kind: "donut",
      icon: "flag",
      title: "Open Task Priority",
      note: "24 open or blocked tasks",
      foot: "Use priority and due context together when planning work.",
      span: 4,
      total: 24,
      totalLabel: "Tasks",
      segments: [
        { label: "High", value: 8 },
        { label: "Medium", value: 11 },
        { label: "Low", value: 5 },
      ],
    },
  ],
  bottomPanels: [
    {
      kind: "rank",
      icon: "users",
      title: "Workload by Assignee",
      note: "24 open tasks within scope",
      foot: "View the workspace for dependencies and due dates.",
      span: 3,
      rows: [
        { name: "Ananya Rao", value: "9", initials: "AR" },
        { name: "Arjun Nair", value: "8", initials: "AN" },
        { name: "Meera Das", value: "7", initials: "MD" },
      ],
    },
    {
      kind: "checks",
      icon: "clock",
      title: "Upcoming Reminders",
      note: "Recipient-scoped reminder queues",
      foot: "18 upcoming reminders; overdue items shown separately.",
      span: 3,
      rows: [
        { label: "Due today", detail: "Due", badge: "5" },
        { label: "Tomorrow", detail: "Upcoming", badge: "4" },
        { label: "Later this week", detail: "Scheduled", badge: "9" },
        { label: "Overdue", detail: "Action", badge: "6" },
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
        { title: "Approval completed", detail: "Civic Voices · 8 min ago", href: "/operations/approvals" },
        { title: "Task reassigned", detail: "Partner onboarding · 32 min ago", href: "/operations/tasks" },
        { title: "Reminder closed", detail: "Invoice review · 1 hour ago", href: "/operations/reminders" },
        { title: "Dependency cleared", detail: "Regional First · 3 hours ago", href: "/operations/tasks" },
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
        { label: "My work", icon: "check" },
        { label: "Approvals", icon: "shield" },
        { label: "Reminders", icon: "clock" },
        { label: "All work", icon: "grid" },
      ],
    },
  ],
};

type Kind = "tasks" | "approvals" | "reminders";

const TASK_NAMES = [
  "Review content submission",
  "Confirm partner briefing",
  "Resolve invoice exception",
  "Complete profile details",
  "Review access scope",
  "Schedule campaign follow-up",
];
const OWNERS: [string, string][] = [
  ["Ananya Rao", "Kerala"],
  ["Arjun Nair", "Kerala"],
  ["Kavya Iyer", "Tamil Nadu"],
  ["Meera Das", "Maharashtra"],
  ["Rohan Shah", "Maharashtra"],
  ["Tara Menon", "Karnataka"],
];
const STATUS_BY_KIND: Record<Kind, string[]> = {
  tasks: ["Open", "Open", "Blocked", "Done", "Open", "Open"],
  approvals: ["Waiting", "Waiting", "Approved", "Approved", "Waiting", "Rejected"],
  reminders: ["Due today", "Tomorrow", "Later this week", "Due today", "Overdue", "Later this week"],
};

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function buildRows(kind: Kind): RecordRow[] {
  return TASK_NAMES.map((name, i) => ({
    id: `${slug(name)}-${kind}`,
    name,
    sub: `${OWNERS[i][0]} · Assigned owner`,
    status: STATUS_BY_KIND[kind][i],
    type: `Due ${15 + i} Sep`,
    region: OWNERS[i][1],
    owner: OWNERS[i][0],
    initials: initialsOf(OWNERS[i][0]),
  }));
}

const WORKSPACES: Record<Kind, ModuleWorkspace> = {
  tasks: {
    recordLabel: "Task",
    columns: { record: "Task", status: "Status", context: "Due", region: "Region", owner: "Owner" },
    rows: buildRows("tasks"),
  },
  approvals: {
    recordLabel: "Approval",
    columns: { record: "Approval", status: "Status", context: "Due", region: "Region", owner: "Owner" },
    rows: buildRows("approvals"),
  },
  reminders: {
    recordLabel: "Reminder",
    columns: { record: "Reminder", status: "Status", context: "Due", region: "Region", owner: "Owner" },
    rows: buildRows("reminders"),
  },
};

export function getOperationsWorkspace(kind: Kind): ModuleWorkspace {
  return WORKSPACES[kind];
}

// Ported from workspaceRows() 'assignments' case
// (docs/reference/CreatorOps_UI_Golden_Master.html). This module has no
// OV_DATA entry - the source itself defaults it straight to the workspace
// tab (navigate(): assignments/deliverables skip 'overview'), so there's no
// Overview page here either. Sample copy normalized (creator -> partner).
import type { ModuleWorkspace, RecordDetail, RecordRow } from "@/features/shared/types";
import { initialsOf } from "@/features/shared/types";

const NAMES = [
  "Community story · Reel 01",
  "Regional voices · Short 02",
  "Culture feature · Video 01",
  "Local perspective · Reel 03",
  "City story · Post 01",
  "Heritage feature · Reel 02",
];
const STATUSES = ["In progress", "Submitted", "Assigned", "Completed", "Revision requested", "Accepted"];
const PEOPLE: [string, string, string][] = [
  ["Ananya Rao", "Kerala", "Meera Das"],
  ["Arjun Nair", "Kerala", "Meera Das"],
  ["Kavya Iyer", "Tamil Nadu", "Arjun Nair"],
  ["Meera Das", "Maharashtra", "Ananya Rao"],
  ["Rohan Shah", "Maharashtra", "Ananya Rao"],
  ["Tara Menon", "Karnataka", "Arjun Nair"],
];

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

const ASSIGNMENTS: RecordRow[] = NAMES.map((name, i) => ({
  id: slug(name),
  name,
  sub: `${PEOPLE[i][0]} · Community Stories`,
  status: STATUSES[i],
  type: "Partner assignment",
  region: PEOPLE[i][1],
  owner: PEOPLE[i][2],
  initials: initialsOf(PEOPLE[i][0]),
}));

export const assignmentsWorkspace: ModuleWorkspace = {
  recordLabel: "Assignment",
  columns: { record: "Assignment", status: "Status", context: "Context", region: "Region", owner: "Owner" },
  rows: ASSIGNMENTS,
};

export function getAssignment(id: string): RecordRow | undefined {
  return ASSIGNMENTS.find((a) => a.id === id);
}

const WORKFLOW_STEPS: { label: string; state: "done" | "current" | "upcoming" }[] = [
  { label: "Assigned", state: "done" },
  { label: "Accepted", state: "done" },
  { label: "In progress", state: "done" },
  { label: "Submitted", state: "current" },
  { label: "Approved", state: "upcoming" },
  { label: "Completed", state: "upcoming" },
];

export function getAssignmentDetail(id: string): RecordDetail | undefined {
  const record = getAssignment(id);
  if (!record) return undefined;
  return {
    record,
    lastUpdated: "14 Sep 2026 · 10:24",
    contextCopy:
      "Create a regional story that brings local people and places into focus. Follow the campaign brief, submit content for review, and attach published evidence when available.",
    kv: [
      { label: "Record type", value: record.type },
      { label: "Owner", value: record.owner },
      { label: "Region", value: record.region },
      { label: "Reporting period", value: "September 2026" },
    ],
    workflow: WORKFLOW_STEPS,
    linked: { title: "Regional story · Reel 01", detail: "Instagram Reel · due 18 Sep", tone: "orange", badge: "Submitted" },
    note: {
      body: "Brief confirmed with the partner. Review the first draft before scheduling publication.",
      author: "Meera Das",
      date: "14 Sep, 09:40",
    },
  };
}

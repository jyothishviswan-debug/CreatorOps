// Ported from workspaceRows() 'deliverables' case (old "Deliverables" module
// maps to our canonical "Content") (docs/reference/CreatorOps_UI_Golden_Master.html).
// Like Assignments, this module has no OV_DATA entry and defaults straight
// to its workspace. The source applies the same workflow-stepper detail
// treatment to deliverables as assignments - kept here too.
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
const STATUSES = ["Submitted", "Planned", "Approved", "Completed", "Needs changes", "Posted"];
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

const CONTENT: RecordRow[] = NAMES.map((name, i) => ({
  id: slug(name),
  name,
  sub: `${PEOPLE[i][0]} · Community Stories`,
  status: STATUSES[i],
  type: "Content item",
  region: PEOPLE[i][1],
  owner: PEOPLE[i][2],
  initials: initialsOf(PEOPLE[i][0]),
}));

export const contentWorkspace: ModuleWorkspace = {
  recordLabel: "Content",
  columns: { record: "Content", status: "Status", context: "Context", region: "Region", owner: "Owner" },
  rows: CONTENT,
};

export function getContentItem(id: string): RecordRow | undefined {
  return CONTENT.find((c) => c.id === id);
}

const WORKFLOW_STEPS: { label: string; state: "done" | "current" | "upcoming" }[] = [
  { label: "Assigned", state: "done" },
  { label: "Accepted", state: "done" },
  { label: "In progress", state: "done" },
  { label: "Submitted", state: "current" },
  { label: "Approved", state: "upcoming" },
  { label: "Completed", state: "upcoming" },
];

export function getContentDetail(id: string): RecordDetail | undefined {
  const record = getContentItem(id);
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

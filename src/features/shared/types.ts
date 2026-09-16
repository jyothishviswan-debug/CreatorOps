// Shared view-model types every module's fixtures conform to. Screens consume
// these types only — swapping a fixture provider for a real service later
// requires no change to the page components.
import type { IconName } from "@/ui/icons";

export type Tone = "green" | "orange" | "blue" | "purple" | "red" | "gray";

export type KpiDatum = {
  label: string;
  value: string;
  hint: string;
  icon: IconName;
};

export type DonutSegment = { label: string; value: number };

export type FunnelRow = { label: string; value: number };

export type ColumnRow = { label: string; value: number };

export type ListRow = { title: string; detail: string; count: string };

export type ActivityRow = { title: string; detail: string; href?: string };

export type CheckRow = { label: string; detail: string; badge: string };

// `href` is optional so existing fixture-driven "actions" panels (which
// have no real destination) keep rendering as inert preview buttons
// unchanged - only a panel that supplies it becomes a real navigable link.
export type ActionRow = { label: string; icon: IconName; href?: string };

type PanelBase = { icon: IconName; title: string; note?: string; foot: string; span: number };

export type OverviewPanelData = PanelBase &
  (
    | { kind: "funnel"; rows: FunnelRow[] }
    | { kind: "donut"; total: number; totalLabel: string; segments: DonutSegment[]; healthPalette?: boolean }
    | { kind: "columns"; rows: ColumnRow[] }
    | { kind: "trends"; series: { label: string; color: string; unit: string; values: number[] }[] }
    | { kind: "stages"; rows: FunnelRow[] }
    | { kind: "checks"; rows: CheckRow[] }
    | { kind: "attention"; rows: ListRow[] }
    | { kind: "activity"; rows: ActivityRow[] }
    | { kind: "rank"; rows: { name: string; value: string; initials: string }[] }
    | { kind: "campaignboard"; rows: { name: string; completed: number; required: number }[] }
    | { kind: "catalog"; rows: { title: string; detail: string }[] }
    | { kind: "settlement"; heroLabel: string; heroValue: string; lines: { label: string; value: string }[] }
    | { kind: "actions"; rows: ActionRow[] }
  );

export type ModuleOverview = {
  eyebrow: string;
  title: string;
  description: string;
  summary: string;
  kpis: KpiDatum[];
  topPanels: OverviewPanelData[];
  bottomPanels: OverviewPanelData[];
};

export type RecordRow = {
  id: string;
  name: string;
  sub: string;
  status: string;
  type: string;
  region: string;
  owner: string;
  initials: string;
};

export type ModuleWorkspace = {
  recordLabel: string;
  columns: { record: string; status: string; context: string; region: string; owner: string };
  rows: RecordRow[];
};

export type RecordDetail = {
  record: RecordRow;
  lastUpdated: string;
  contextCopy: string;
  kv: { label: string; value: string }[];
  workflow?: { label: string; state: "done" | "current" | "upcoming" }[];
  linked: { title: string; detail: string; tone: Tone; badge: string };
  note: { body: string; author: string; date: string };
};

export function statusTone(status: string): Tone {
  if (/pending|review|submitted|ready|negotiation|draft/i.test(status)) return "orange";
  if (/blocked|denied|disabled|error/i.test(status)) return "red";
  if (/progress|contacted|assigned/i.test(status)) return "blue";
  return "green";
}

export function initialsOf(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

// Compact K/M display for large plain counts (views, interactions, reach).
// Numbers below 1,000 pass through unchanged, so this is safe to apply
// wherever a count is displayed - it only kicks in where it's applicable.
export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

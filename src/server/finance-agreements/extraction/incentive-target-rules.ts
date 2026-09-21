import type { ExtractedIncentiveSlab, ExtractedPerformanceTarget } from "./extraction-types";
import { findAmounts } from "./parsers";
import { emit, warn, type RuleContext } from "./rule-context";
import { isHeadingLine } from "./term-rules";
import { cleanValueText, labelLines, type DocLine, type DocText } from "./text-utils";

// Step 14A: incentive slabs and warning-only performance targets.
//   - A slab is RECORDED data (band + amount); nothing here evaluates it.
//   - A performance target only ever warns: affectsPayment is the literal false.

// --- Metric numbers ("50,000", "50k", "1.5 lakh", "2 million") -------------------------

const SUFFIX_FACTOR: Record<string, number> = { k: 1_000, m: 1_000_000, million: 1_000_000, lakh: 100_000, lakhs: 100_000, lac: 100_000, lacs: 100_000, crore: 10_000_000, crores: 10_000_000 };

function parseMetricNumber(numberText: string, suffix?: string): number | null {
  const cleaned = numberText.replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned) * (suffix ? (SUFFIX_FACTOR[suffix.toLowerCase()] ?? 1) : 1);
  return Number.isFinite(value) && value >= 0 && value <= 1e12 ? Math.round(value * 1000) / 1000 : null;
}

const NUM = String.raw`(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?`;
const SUF = String.raw`(?:\s*(k|m|million|lakhs?|lacs?|crores?)\b)?`;

// Unit noun -> metric id. Content-count nouns map to the quantity of qualifying
// content; anything unrecognised is skipped rather than guessed.
function metricForUnit(noun: string): string | null {
  const n = noun.toLowerCase();
  if (/^views?$/.test(n)) return "views";
  if (/^(?:reach|impressions?)$/.test(n)) return "reach";
  if (/^likes?$/.test(n)) return "likes";
  if (/^comments?$/.test(n)) return "comments";
  if (/^engagement$/.test(n)) return "engagement";
  if (/^followers?$/.test(n)) return "followerGrowth";
  if (/^(?:reels?|posts?|videos?|shorts?|stories|story|carousels?|content|uploads?)$/.test(n)) return "qualifyingContentCount";
  return null;
}

// --- Incentive ---------------------------------------------------------------------------

const RANGE_SLAB = new RegExp(String.raw`^[\s\-•*·]*${NUM}${SUF}\s*(?:-|–|to)\s*${NUM}${SUF}\s*(?<unit>[A-Za-z]+)?\s*(?:[:=\-–>]+\s*)?(?<rest>.*)$`, "i");
const OPEN_SLAB = new RegExp(String.raw`^[\s\-•*·]*(?:above|more\s+than|over|beyond|at\s+least|minimum\s+of|>=?)\s*${NUM}${SUF}\s*(?<unit>[A-Za-z]+)?\s*(?:[:=\-–>]+\s*)?(?<rest>.*)$`, "i");

type ParsedSlab = { metricId: string; lowerBound: number; upperBound: number | null; unit: string; amountMinor: number; description: string };

function parseSlabLine(text: string): ParsedSlab | null {
  const range = RANGE_SLAB.exec(text);
  const open = range ? null : OPEN_SLAB.exec(text);
  const m = range ?? open;
  if (!m) return null;
  const unit = m.groups?.unit ?? "";
  const metricId = metricForUnit(unit);
  if (!metricId) return null;
  const amount = findAmounts(m.groups?.rest ?? "")[0];
  if (!amount) return null;
  const lower = parseMetricNumber(`${m[1]}${m[2] ? `.${m[2]}` : ""}`, m[3]);
  if (lower === null) return null;
  let upper: number | null = null;
  if (range) {
    upper = parseMetricNumber(`${m[4]}${m[5] ? `.${m[5]}` : ""}`, m[6]);
    if (upper === null || upper <= lower) return null;
  }
  return { metricId, lowerBound: lower, upperBound: upper, unit: unit.toLowerCase(), amountMinor: amount.amountMinor, description: cleanValueText(text).slice(0, 500) };
}

const INCENTIVE_LABEL = String.raw`(?:performance\s+)?incentives?(?:\s+slabs?)?|additional\s+(?:payment|payout|incentive)s?|bonus`;

function slabsAfter(doc: DocText, start: DocLine, tail: string): ExtractedIncentiveSlab[] {
  const parsed: ParsedSlab[] = [];
  const tailSlab = tail ? parseSlabLine(tail) : null;
  if (tailSlab) parsed.push(tailSlab);
  let misses = 0;
  for (let i = start.lineIndex + 1; i < doc.lines.length && parsed.length < 30 && i < start.lineIndex + 14; i++) {
    const next = doc.lines[i]!;
    if (next.page !== start.page || !next.text) break;
    const slab = parseSlabLine(next.text);
    if (slab) {
      parsed.push(slab);
      misses = 0;
      continue;
    }
    if (isHeadingLine(next.text) || ++misses > 2) break;
  }
  return parsed.map((slab, index) => ({ slabRef: `slab_${index + 1}`, metricId: slab.metricId, lowerBound: slab.lowerBound, upperBound: slab.upperBound, unit: slab.unit, amountMinor: slab.amountMinor, description: slab.description }));
}

export function extractIncentive(ctx: RuleContext): void {
  const rows = labelLines(ctx.doc, INCENTIVE_LABEL, { requireSeparator: false, allowEmptyTail: true });
  let unparsedPage: number | null = null;
  for (const row of rows) {
    const hit = { page: row.line.page, index: row.line.start, length: row.line.text.length };
    if (/^(?:nil|n\/?a|na|none|no\b|not\s+applicable)/i.test(row.tail)) {
      emit(ctx, "incentive", { applicable: false, slabs: [] }, hit, "MEDIUM");
      return;
    }
    const slabs = slabsAfter(ctx.doc, row.line, row.tail);
    if (slabs.length > 0) {
      emit(ctx, "incentive", { applicable: true, slabs }, hit, "MEDIUM", ["slab_boundaries_need_confirmation"]);
      return;
    }
    unparsedPage ??= row.line.page;
  }
  // An incentive clause exists but no slab could be read unambiguously: the
  // registry needs at least one slab for an applicable incentive, so nothing is
  // proposed - the reviewer is told to enter it.
  if (unparsedPage !== null) warn(ctx, "incentive_slabs_not_parsed", "incentive", unparsedPage);
}

// --- Warning-only performance targets --------------------------------------------------------

const TARGET_ANCHOR_STRONG = /\b(?:targets?|kpis?|benchmarks?|goals?)\b/i;
const TARGET_ANCHOR_WEAK = /\b(?:expected|minimum|at\s+least|not\s+less\s+than|should\s+(?:achieve|reach|get|gain))\b/i;
const UPPER_BOUND_WORDS = /\b(?:maximum|max\.?|at\s+most|up\s+to|not\s+more\s+than|not\s+exceed\w*)\b/i;

const METRIC_WORDS = String.raw`follower\s+growth|growth\s+in\s+followers|new\s+followers|followers\s+(?:gain|added)|reach|impressions?|views?|engagement(?:\s+rate)?|likes?|comments?`;
const NUMBER_FIRST = new RegExp(String.raw`${NUM}${SUF}\s*(%|percent|per\s*cent)?\s*(?:\+\s*)?(?<metric>${METRIC_WORDS})\b`, "gi");
const METRIC_FIRST = new RegExp(String.raw`(?<metric>${METRIC_WORDS})\b(?:\s+target)?\s*(?:of|:|=|-|at|is|should\s+be)?\s*(?:at\s+least|minimum(?:\s+of)?|not\s+less\s+than|>=|≥)?\s*${NUM}${SUF}\s*(%|percent|per\s*cent)?`, "gi");

function metricIdFor(metricWord: string): { metricId: string; baseUnit: string } {
  const w = metricWord.toLowerCase().replace(/\s+/g, " ");
  if (/follower|followers/.test(w)) return { metricId: "followerGrowth", baseUnit: "followers" };
  if (/reach|impression/.test(w)) return { metricId: "reach", baseUnit: "reach" };
  if (/view/.test(w)) return { metricId: "views", baseUnit: "views" };
  if (/engagement/.test(w)) return { metricId: "engagement", baseUnit: "count" };
  if (/like/.test(w)) return { metricId: "likes", baseUnit: "likes" };
  return { metricId: "comments", baseUnit: "comments" };
}

type RawTarget = { metricId: string; targetValue: number; unit: string; index: number; length: number; page: number; strong: boolean };

function targetsIn(line: DocLine): RawTarget[] {
  const text = line.text;
  const strong = TARGET_ANCHOR_STRONG.test(text);
  if (!strong && !TARGET_ANCHOR_WEAK.test(text)) return [];
  if (findAmounts(text).some((amount) => amount.currencyMarker)) return []; // money on the line = pay/incentive wording, not a target
  const found: RawTarget[] = [];
  const consider = (m: RegExpMatchArray, numIndex: number, sufIndex: number, pctIndex: number) => {
    const before = text.slice(Math.max(0, m.index! - 25), m.index!);
    if (UPPER_BOUND_WORDS.test(before)) return;
    const value = parseMetricNumber(`${m[numIndex]}${m[numIndex + 1] ? `.${m[numIndex + 1]}` : ""}`, m[sufIndex]);
    if (value === null) return;
    const { metricId, baseUnit } = metricIdFor(m.groups!.metric!);
    const percent = Boolean(m[pctIndex]);
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 25);
    const per = /^\s*(?:per|each|\/)\s*(reel|post|video|month|story|short|content)\b/i.exec(after);
    const unit = `${percent ? "percent" : baseUnit}${per ? ` per ${per[1]!.toLowerCase()}` : ""}`;
    found.push({ metricId, targetValue: value, unit, index: line.start + m.index!, length: m[0].length, page: line.page, strong });
  };
  for (const m of text.matchAll(NUMBER_FIRST)) consider(m, 1, 3, 4);
  for (const m of text.matchAll(METRIC_FIRST)) consider(m, 2, 4, 5);
  return found;
}

export function extractPerformanceTargets(ctx: RuleContext): void {
  const seen = new Set<string>();
  const targets: RawTarget[] = [];
  for (const line of ctx.doc.lines) {
    for (const target of targetsIn(line)) {
      const key = `${target.metricId}|${target.targetValue}|${target.unit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(target);
    }
  }
  if (targets.length === 0) return;
  const MAX_TARGETS = 12;
  const kept = targets.slice(0, MAX_TARGETS);
  const value: ExtractedPerformanceTarget[] = kept.map((t, i) => ({ targetRef: `target_${i + 1}`, metricId: t.metricId, targetValue: t.targetValue, unit: t.unit, comparison: "at_least", affectsPayment: false }));
  const confidence = kept.every((t) => t.strong) ? "MEDIUM" : "LOW";
  const warnings = ["warning_only_target_never_affects_payment", ...(targets.length > MAX_TARGETS ? ["targets_truncated"] : [])];
  emit(ctx, "performanceTargets", value, kept[0]!, confidence, warnings);
}

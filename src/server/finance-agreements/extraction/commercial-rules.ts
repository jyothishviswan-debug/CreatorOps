import type { ExtractedFieldValueMap, ExtractedPaymentCycle } from "./extraction-types";
import { findAmounts } from "./parsers";
import { emit, pickAndEmit, warn, type RuleContext } from "./rule-context";
import { SERVICES_HEADING, clauseBlocks, emitClause } from "./term-rules";
import { cleanValueText, finderCandidates, isPlaceholder, labelLines, type Candidate, type DocText } from "./text-utils";

// Step 14A: commercial (payment-affecting) rules. Everything here only PROPOSES
// values for a human to confirm; there is no money calculation anywhere.

const NEGATIVE = /^(?:nil|n\/?a|na|none|no\b|not\s+applicable|not\s+payable|not\s+required|waived)/i;

// --- Currency --------------------------------------------------------------------------

const INR_MARKER = /(?:\bINR\b|\bRs\b\.?|₹|\bRupees?\b)/i;
const FOREIGN_MARKER = /(?:\b(?:USD|EUR|GBP|AED|SGD)\b|[$€£])/;

export function extractCurrency(ctx: RuleContext): void {
  for (const row of labelLines(ctx.doc, "currency")) {
    if (INR_MARKER.test(row.tail) && !FOREIGN_MARKER.test(row.tail)) {
      emit(ctx, "currency", "INR", { page: row.line.page, index: row.line.start, length: row.line.text.length }, "HIGH");
      return;
    }
  }
  let firstInr: { page: number; index: number; length: number } | null = null;
  let foreign = false;
  for (const line of ctx.doc.lines) {
    const inr = INR_MARKER.exec(line.text);
    if (inr && !firstInr && findAmounts(line.text).length > 0) firstInr = { page: line.page, index: line.start + inr.index, length: inr[0].length };
    if (FOREIGN_MARKER.test(line.text)) foreign = true;
  }
  if (firstInr) emit(ctx, "currency", "INR", firstInr, foreign ? "LOW" : "MEDIUM", foreign ? ["multiple_currencies_mentioned"] : ["no_label_found"]);
  else if (foreign) warn(ctx, "non_inr_currency_detected", "currency");
}

// --- Payment cycle -----------------------------------------------------------------------

const CYCLE_PATTERNS: ReadonlyArray<readonly [ExtractedPaymentCycle, RegExp]> = [
  ["FORTNIGHTLY", /\b(?:fortnightly|bi-?weekly|every\s+two\s+weeks)\b/i],
  ["WEEKLY", /\b(?:weekly|every\s+week|per\s+week)\b/i],
  ["MONTHLY", /\b(?:monthly|every\s+month|per\s+month|each\s+month|once\s+a\s+month)\b/i],
  ["QUARTERLY", /\b(?:quarterly|every\s+quarter|per\s+quarter)\b/i],
  ["ONE_TIME", /\b(?:one[-\s]?time|lump\s*sum|single\s+payment)\b/i],
  ["OTHER", /\b(?:half[-\s]?yearly|semi[-\s]?annual\w*|annual\w*|yearly|bi-?monthly)\b/i],
];

function cyclesIn(text: string): ExtractedPaymentCycle[] {
  return CYCLE_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([cycle]) => cycle);
}

export function extractPaymentCycle(ctx: RuleContext): void {
  const candidates: Candidate<ExtractedPaymentCycle>[] = [];
  for (const row of labelLines(ctx.doc, String.raw`payment\s+(?:cycle|frequency|schedule)|billing\s+(?:cycle|frequency)|payout\s+(?:cycle|frequency)|frequency\s+of\s+payment`)) {
    const cycles = cyclesIn(row.tail);
    const [first] = cycles;
    if (!first) continue;
    candidates.push({ value: first, key: first, page: row.line.page, index: row.line.start, length: row.line.text.length, labeled: true, ...(cycles.length > 1 ? { warnings: ["multiple_cycles_named"], cap: "LOW" as const } : {}), ...(first === "OTHER" ? { warnings: ["cycle_mapped_to_other"] } : {}) });
  }
  const phrase = /\b(?:paid|payable|payments?\s+(?:shall\s+be|will\s+be|to\s+be)\s+made|payouts?\s+(?:shall\s+be|will\s+be|is|are))\s+(?:on\s+a\s+)?(monthly|weekly|quarterly|fortnightly|bi-?weekly)\b/gi;
  const unlabeled = finderCandidates(ctx.doc, (region) => {
    const out: Array<{ value: ExtractedPaymentCycle; key: string; index: number; length: number }> = [];
    for (const m of region.matchAll(phrase)) {
      const [cycle] = cyclesIn(m[1]!);
      if (cycle) out.push({ value: cycle, key: cycle, index: m.index!, length: m[0].length });
    }
    return out;
  });
  pickAndEmit(ctx, "paymentCycle", [...candidates, ...unlabeled], { labeledConfidence: "HIGH", unlabeledConfidence: "MEDIUM" });
}

// --- Amount rows (fixed fee / transfer fee / advance) -------------------------------------

type AmountRow = { page: number; index: number; length: number; tail: string; negative: boolean; amounts: number[] };

function amountRows(doc: DocText, labelSource: string): AmountRow[] {
  return labelLines(doc, labelSource, { requireSeparator: false }).map((row) => ({
    page: row.line.page,
    index: row.line.start,
    length: row.line.text.length,
    tail: row.tail,
    negative: NEGATIVE.test(row.tail),
    amounts: findAmounts(row.tail).map((amount) => amount.amountMinor),
  }));
}

function amountWarnings(row: AmountRow): { warnings: string[]; cap?: "LOW" | "MEDIUM" } {
  const warnings: string[] = [];
  let cap: "LOW" | "MEDIUM" | undefined;
  if (new Set(row.amounts).size > 1) {
    warnings.push("multiple_amounts_on_line");
    cap = "MEDIUM";
  }
  if (row.amounts[0] === 0) {
    warnings.push("zero_amount");
    cap = "LOW";
  }
  return { warnings, ...(cap ? { cap } : {}) };
}

const FIXED_LABEL = String.raw`fixed\s+(?:component|fee|amount|payment|payout|remuneration|compensation|rate|monthly(?:\s+(?:fee|payout|retainer|payment|amount))?)|monthly\s+(?:retainer|fee|payout|remuneration|fixed\s+fee|fixed\s+amount)|retainer(?:\s+fee)?`;

export function extractFixedComponent(ctx: RuleContext): void {
  const candidates: Candidate<ExtractedFieldValueMap["fixedComponent"]>[] = [];
  for (const row of amountRows(ctx.doc, FIXED_LABEL)) {
    const base = { page: row.page, index: row.index, length: row.length, labeled: true };
    if (row.negative) candidates.push({ ...base, value: { applicable: false, amountMinor: null }, key: "na" });
    else if (row.amounts.length > 0) {
      const extra = amountWarnings(row);
      candidates.push({ ...base, value: { applicable: true, amountMinor: row.amounts[0]! }, key: `amt:${row.amounts[0]}`, warnings: extra.warnings, cap: extra.cap });
    }
  }
  pickAndEmit(ctx, "fixedComponent", candidates, { labeledConfidence: "HIGH", unlabeledConfidence: null });
}

export function extractAccountTransferFee(ctx: RuleContext): void {
  const candidates: Candidate<ExtractedFieldValueMap["accountTransferFee"]>[] = [];
  for (const row of amountRows(ctx.doc, String.raw`(?:account|page)\s+transfer\s+(?:fee|charges?)|transfer\s+(?:fee|charges?)`)) {
    const base = { page: row.page, index: row.index, length: row.length, labeled: true };
    if (row.negative) candidates.push({ ...base, value: { applicable: false, amountMinor: null, details: null }, key: "na" });
    else if (row.amounts.length > 0) {
      const extra = amountWarnings(row);
      candidates.push({ ...base, value: { applicable: true, amountMinor: row.amounts[0]!, details: null }, key: `amt:${row.amounts[0]}`, warnings: extra.warnings, cap: extra.cap });
    }
  }
  pickAndEmit(ctx, "accountTransferFee", candidates, { labeledConfidence: "HIGH", unlabeledConfidence: null });
}

export function extractAdvancePayment(ctx: RuleContext): void {
  const candidates: Candidate<ExtractedFieldValueMap["advancePayment"]>[] = [];
  for (const row of amountRows(ctx.doc, String.raw`advance\s+(?:payment|amount|fee)|advance(?=\s*[:\-])`)) {
    const base = { page: row.page, index: row.index, length: row.length, labeled: true };
    if (row.negative) candidates.push({ ...base, value: { applicable: false, details: null, amountMinor: null }, key: "na" });
    else if (row.amounts.length > 0) {
      const extra = amountWarnings(row);
      candidates.push({ ...base, value: { applicable: true, details: null, amountMinor: row.amounts[0]! }, key: `amt:${row.amounts[0]}`, warnings: extra.warnings, cap: extra.cap });
    } else {
      const details = cleanValueText(row.tail).slice(0, 300);
      if (details.length >= 3 && !isPlaceholder(details)) candidates.push({ ...base, value: { applicable: true, details, amountMinor: null }, key: `txt:${details.toLowerCase()}`, warnings: ["no_amount_found"], cap: "LOW" });
    }
  }
  pickAndEmit(ctx, "advancePayment", candidates, { labeledConfidence: "HIGH", unlabeledConfidence: null });
}

// --- Required qualifying content count + unit ---------------------------------------------

const COUNT_LABEL = String.raw`fixed\s+deliverables?(?:\s+units?)?|deliverable\s+units?|(?:monthly|minimum)\s+(?:required\s+)?(?:deliverables?|content(?:\s+(?:count|commitment|requirement))?|posts?|reels?|videos?|uploads?)|required\s+content(?:\s+(?:per|each)\s+month)?|content\s+commitment`;
const UNIT_NOUNS = "reels?|posts?|videos?|shorts?|stories|story|carousels?|articles?|tweets?|units?|pieces?(?:\\s+of\\s+content)?|content\\s+pieces?|integrations?|deliverables?";

function singularUnit(noun: string): string {
  const lower = noun.toLowerCase().replace(/\s+/g, " ").trim();
  if (lower === "stories") return "story";
  if (/^pieces of content$/.test(lower)) return "piece of content";
  if (/^content pieces$/.test(lower)) return "content piece";
  return lower.replace(/s$/, "");
}

type CountHit = { count: number; unit: string | null; page: number; index: number; length: number; labeled: boolean };

function countHits(doc: DocText): CountHit[] {
  const hits: CountHit[] = [];
  const valueRegex = new RegExp(String.raw`^(?:minimum\s+of\s+|at\s+least\s+|min\.?\s+)?(\d{1,6})\b\s*(?:x\s*)?(${UNIT_NOUNS})?`, "i");
  for (const row of labelLines(doc, COUNT_LABEL)) {
    const m = valueRegex.exec(row.tail);
    if (!m) continue;
    const count = Number(m[1]);
    if (!Number.isSafeInteger(count) || count > 100_000) continue;
    hits.push({ count, unit: m[2] ? singularUnit(m[2]) : null, page: row.line.page, index: row.line.start, length: row.line.text.length, labeled: true });
  }
  const phrase = new RegExp(String.raw`\b(?:deliver|post|publish|upload|create|produce)\s+(?:a\s+minimum\s+of\s+|at\s+least\s+|minimum\s+)?(\d{1,3})\s+(${UNIT_NOUNS})\b[^.]{0,40}\b(?:per|each|every|a)\s+month\b`, "gi");
  for (const line of doc.lines) {
    for (const m of line.text.matchAll(phrase)) hits.push({ count: Number(m[1]), unit: singularUnit(m[2]!), page: line.page, index: line.start + m.index!, length: m[0].length, labeled: false });
  }
  return hits;
}

export function extractRequiredContent(ctx: RuleContext): void {
  const hits = countHits(ctx.doc);
  const counts: Candidate<number>[] = hits.map((h) => ({ value: h.count, key: `${h.count}`, page: h.page, index: h.index, length: h.length, labeled: h.labeled, ...(h.unit ? {} : { warnings: ["qualifying_unit_missing"], cap: "MEDIUM" as const }) }));
  const chosen = pickAndEmit(ctx, "monthlyRequiredQualifyingContentCount", counts, { labeledConfidence: "HIGH", unlabeledConfidence: "MEDIUM" });
  if (!chosen) return;
  const source = hits.find((h) => h.page === chosen.page && h.index === chosen.index);
  if (source?.unit) {
    emit(ctx, "qualifyingUnit", source.unit, source, "MEDIUM", ["unit_requires_mapping_to_supported_qualifying_unit"]);
  }
}

// --- Invoice terms -------------------------------------------------------------------------------

export function extractInvoiceRequired(ctx: RuleContext): void {
  const candidates: Candidate<boolean>[] = [];
  for (const row of labelLines(ctx.doc, String.raw`invoices?\s+(?:required|mandatory|compulsory|needed)|invoicing\s+required`)) {
    const yes = /^(?:yes|y|required|mandatory|compulsory|applicable)\b/i.test(row.tail);
    const no = /^(?:no|n|not\s+required|not\s+applicable|nil|n\/?a)\b/i.test(row.tail);
    if (yes !== no) candidates.push({ value: yes, key: String(yes), page: row.line.page, index: row.line.start, length: row.line.text.length, labeled: true });
  }
  const positive = /\b(?:shall|must|will|needs?\s+to|is\s+required\s+to|are\s+required\s+to)\s+(?:raise|submit|send|share|issue|provide|generate)\s+(?:an?\s+|the\s+|a\s+valid\s+|monthly\s+|tax\s+)?invoices?\b|\binvoices?\s+(?:is|are|shall\s+be)\s+(?:required|mandatory)\b/gi;
  const negative = /\bno\s+invoices?\b|\binvoices?\s+(?:is\s+|are\s+|shall\s+be\s+)?not\s+(?:required|needed|mandatory)\b/gi;
  const phrase: Candidate<boolean>[] = [];
  for (const line of ctx.doc.lines) {
    for (const m of line.text.matchAll(positive)) phrase.push({ value: true, key: "true", page: line.page, index: line.start + m.index!, length: m[0].length, labeled: false });
    for (const m of line.text.matchAll(negative)) phrase.push({ value: false, key: "false", page: line.page, index: line.start + m.index!, length: m[0].length, labeled: false });
  }
  if (candidates.length === 0 && new Set(phrase.map((p) => p.key)).size > 1) {
    warn(ctx, "conflicting_invoice_statements", "invoiceRequired", phrase[0]!.page);
    return;
  }
  pickAndEmit(ctx, "invoiceRequired", [...candidates, ...phrase], { labeledConfidence: "HIGH", unlabeledConfidence: "MEDIUM" });
}

const DAYS_PHRASE = /\b(?:within|in|not\s+later\s+than|no\s+later\s+than)\s+\d{1,3}(?:\s*\(\s*\w[\w -]{0,20}\s*\))?\s*(?:calendar\s+|working\s+|business\s+)?days\b|\bnet\s*\d{1,3}\b|\b\d{1,3}\s*(?:calendar\s+|working\s+|business\s+)?days\b/i;
const INVOICE_SUBMIT = /\b(?:raise|submit|send|share|issue|generate)\b[^.]{0,60}\binvoices?\b|\binvoices?\b[^.]{0,40}\b(?:raised|submitted|sent|shared|issued)\b/i;
const PAYMENT_WORD = /\b(?:payment|payments|pay|paid|payable|payout|payouts|remit\w*)\b/i;

export function extractDueTerms(ctx: RuleContext): void {
  const paymentLabeled: Candidate<string>[] = [];
  const invoiceLabeled: Candidate<string>[] = [];
  const labeledLines = new Set<string>();
  const collect = (out: Candidate<string>[], label: string) => {
    for (const row of labelLines(ctx.doc, label)) {
      if (!DAYS_PHRASE.test(row.tail)) continue;
      labeledLines.add(`${row.line.page}:${row.line.start}`);
      const text = cleanValueText(row.tail).slice(0, 500);
      out.push({ value: text, key: text.toLowerCase(), page: row.line.page, index: row.line.start, length: row.line.text.length, labeled: true });
    }
  };
  collect(paymentLabeled, String.raw`payment\s+terms|payment\s+due|due\s+date|credit\s+period|payment\s+timeline`);
  collect(invoiceLabeled, String.raw`invoice\s+(?:due|submission|timeline|deadline|terms)`);

  const paymentSentences: Candidate<string>[] = [];
  const invoiceSentences: Candidate<string>[] = [];
  const both: Candidate<string>[] = [];
  for (const line of ctx.doc.lines) {
    if (labeledLines.has(`${line.page}:${line.start}`)) continue; // already read as a labeled row
    for (const sentence of line.text.split(/(?<=[.;])\s+/)) {
      if (!DAYS_PHRASE.test(sentence)) continue;
      const isInvoice = INVOICE_SUBMIT.test(sentence);
      const isPayment = PAYMENT_WORD.test(sentence);
      if (!isInvoice && !isPayment) continue;
      const text = cleanValueText(sentence).slice(0, 500);
      const candidate: Candidate<string> = { value: text, key: text.toLowerCase(), page: line.page, index: line.start + Math.max(0, line.text.indexOf(sentence)), length: sentence.length, labeled: false, warnings: ["sentence_level_match"] };
      if (isInvoice && isPayment) both.push(candidate);
      else if (isInvoice) invoiceSentences.push(candidate);
      else paymentSentences.push(candidate);
    }
  }
  pickAndEmit(ctx, "paymentDueTerms", [...paymentLabeled, ...paymentSentences], { labeledConfidence: "HIGH", unlabeledConfidence: "MEDIUM" });
  pickAndEmit(ctx, "invoiceDueTerms", [...invoiceLabeled, ...invoiceSentences], { labeledConfidence: "HIGH", unlabeledConfidence: "MEDIUM" });
  if (!ctx.fields.some((f) => f.fieldKey === "paymentDueTerms" || f.fieldKey === "invoiceDueTerms") && both.length > 0) warn(ctx, "due_terms_sentence_mentions_invoice_and_payment", undefined, both[0]!.page);
}

// --- Services mandated -------------------------------------------------------------------------------

export function extractServicesMandated(ctx: RuleContext): void {
  emitClause(ctx, "servicesMandated", clauseBlocks(ctx.doc, SERVICES_HEADING));
}

// --- LFC / SFC (ONLY when the text names the formats explicitly) -------------------------------------

const LFC_SFC_LINE = /\(?\b(LFC|SFC)\b\)?\s*(?:\([^)]{0,60}\))?\s*(?:[:=\-–]|\b(?:includes?|means|refers\s+to|comprises|consists\s+of|shall\s+mean)\b)\s*(.+)$/i;

export function extractLfcSfc(ctx: RuleContext): void {
  const byFormat = new Map<string, "LFC" | "SFC">();
  const conflicts = new Set<string>();
  let first: { page: number; index: number; length: number } | null = null;
  for (const line of ctx.doc.lines) {
    const m = LFC_SFC_LINE.exec(line.text);
    if (!m) continue;
    const klass = m[1]!.toUpperCase() as "LFC" | "SFC";
    for (const rawItem of m[2]!.split(/,|;|\band\b|\/|&/i)) {
      const item = cleanValueText(rawItem.replace(/[.)]+$/, ""));
      if (item.length < 2 || item.length > 60 || item.split(/\s+/).length > 5 || isPlaceholder(item)) continue;
      const key = item.toLowerCase();
      const existing = byFormat.get(key);
      if (existing && existing !== klass) conflicts.add(key);
      else byFormat.set(key, klass);
      first ??= { page: line.page, index: line.start, length: line.text.length };
    }
  }
  for (const key of conflicts) byFormat.delete(key);
  if (byFormat.size === 0 || !first) return;
  const value: Record<string, "LFC" | "SFC"> = {};
  for (const [format, klass] of [...byFormat.entries()].sort(([a], [b]) => a.localeCompare(b))) value[format] = klass;
  emit(ctx, "lfcSfc", { byFormat: value }, first, "MEDIUM", ["formats_must_match_assignment_brief_format_values", ...(conflicts.size > 0 ? ["lfc_sfc_format_conflict_dropped"] : [])]);
}

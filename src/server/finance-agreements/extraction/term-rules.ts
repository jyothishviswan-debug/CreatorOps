import { findDates } from "./parsers";
import { addFieldWarning, emit, findProposal, pickAndEmit, type RuleContext } from "./rule-context";
import type { ExtractedFieldKey } from "./extraction-types";
import { cleanValueText, finderCandidates, isPlaceholder, labelLines, labeledFinder, regexFinder, type Candidate, type DocLine, type DocText } from "./text-utils";

// Step 14A: platform/page, agreement number, dates and clause-text rules.
// Agreement STATUS and TYPE are never read from text (CreatorOps derives them).

// --- Platform page link / name ---------------------------------------------------------

const PLATFORM_HOSTS = String.raw`(?:instagram\.com|youtube\.com|youtu\.be|facebook\.com|fb\.com|twitter\.com|x\.com|threads\.net|linkedin\.com|snapchat\.com|pinterest\.com|t\.me|tiktok\.com|sharechat\.com)`;
const PAGE_URL = new RegExp(String.raw`(?<![A-Za-z0-9@.])(?:https?:\/\/)?(?:www\.|m\.)?${PLATFORM_HOSTS}\/[^\s<>"'()\[\]]{1,200}`, "gi");

export function normalizePageLink(raw: string): string | null {
  let url = raw.replace(/[.,;:!?]+$/, "");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/^http:\/\//i, "https://");
  const cut = url.search(/[?#]/);
  if (cut >= 0) url = url.slice(0, cut);
  url = url.replace(/\/+$/, "");
  const m = /^https:\/\/((?:www\.|m\.)?[^/]+)(\/.*)$/i.exec(url);
  if (!m) return null;
  const path = m[2]!;
  if (path.length < 2 || path.length > 200) return null;
  const host = m[1]!.toLowerCase().replace(/^(?:www\.|m\.)/, "");
  return `https://${host}${path}`;
}

const PAGE_LINK_FINDER = regexFinder(PAGE_URL, (m) => {
  const value = normalizePageLink(m[0]);
  return value ? { value, key: value.toLowerCase() } : null;
});

export function extractPageLinkAndName(ctx: RuleContext): void {
  const label = String.raw`(?:page|profile|channel|collaborator(?:'s)?\s+page)\s*(?:link|url)|(?:instagram|youtube|facebook|twitter|threads|social\s+media)(?:\s*(?:page|profile|channel|handle|account))?(?:\s*(?:link|url|id))?|collaborator\s+page`;
  const labeled = labeledFinder(ctx.doc, label, PAGE_LINK_FINDER, { window: 120, nextLine: true });
  pickAndEmit(ctx, "collaboratorPageLink", [...labeled, ...finderCandidates(ctx.doc, PAGE_LINK_FINDER)], { labeledConfidence: "HIGH", unlabeledConfidence: "LOW", extraWarnings: ["verify_party_attribution"] });

  const names: Candidate<string>[] = [];
  for (const row of labelLines(ctx.doc, String.raw`(?:page|channel|profile|account)\s+name|name\s+of\s+(?:the\s+)?(?:page|channel|profile|account)`)) {
    const text = cleanValueText(row.tail.split(/\s{2,}/)[0]!);
    if (text.length >= 2 && text.length <= 200 && !isPlaceholder(text) && /[A-Za-z0-9]{2,}/.test(text) && (!text.includes("@") || text.startsWith("@"))) {
      names.push({ value: text, key: text.toLowerCase(), page: row.line.page, index: row.line.start, length: row.line.text.length, labeled: true });
    }
  }
  pickAndEmit(ctx, "collaboratorPageName", names, { labeledConfidence: "MEDIUM", unlabeledConfidence: null, cap: "MEDIUM" });
}

// --- Agreement number --------------------------------------------------------------------

const AGREEMENT_NUMBER_FINDER = regexFinder(/(?<![A-Za-z0-9/._-])(?=[A-Za-z0-9/._-]*\d)[A-Za-z0-9][A-Za-z0-9/._-]{2,39}(?![A-Za-z0-9/._-])/g, (m) => {
  const value = m[0].replace(/[.\-_/]+$/, "");
  return value.length >= 3 && /\d/.test(value) ? { value, key: value.toUpperCase() } : null;
});

export function extractAgreementNumber(ctx: RuleContext): void {
  const label = String.raw`agreement\s*(?:no|number|ref(?:erence)?(?:\s*(?:no|number))?|id)|contract\s*(?:no|number|ref(?:erence)?|id)|reference\s*(?:no|number)`;
  const labeled = labeledFinder(ctx.doc, label, AGREEMENT_NUMBER_FINDER, { window: 60, nextLine: true });
  pickAndEmit(ctx, "agreementNumber", labeled, { labeledConfidence: "HIGH", unlabeledConfidence: null });
}

// --- Dates ---------------------------------------------------------------------------------

const dateFinder = (region: string) =>
  findDates(region).map((d) => ({
    value: d.iso,
    key: d.iso,
    index: d.index,
    length: d.length,
    ...(d.dayMonthOrderAssumed ? { warnings: ["day_month_order_assumed_dd_mm"], cap: "MEDIUM" as const } : {}),
  }));

const SIGNED_LABEL = String.raw`date\s+of\s+(?:agreement|execution|signing|signature)|agreement\s+date|execution\s+date|signing\s+date|signed\s+on|executed\s+on|dated|(?:made|entered\s+into|executed|signed)\s+(?:on|as\s+of)|made\s+and\s+entered\s+into\s+on`;
const EFFECTIVE_LABEL = String.raw`effective\s+date|date\s+of\s+commencement|commencement\s+date|(?:agreement\s+)?start\s+date|effective\s+from|with\s+effect\s+from|w\.e\.f|term\s+(?:shall\s+)?commence[sd]?(?:\s+on)?|commencing\s+(?:on|from)`;
const TERMINATION_LABEL = String.raw`termination\s+date|(?:agreement\s+)?end\s+date|expiry\s+date|date\s+of\s+(?:expiry|termination)|expires?\s+on|valid\s+(?:till|until|upto|up\s+to)|validity\s+(?:till|until|upto)|(?:agreement\s+)?ends?\s+on`;

function extractDate(ctx: RuleContext, fieldKey: "signedDate" | "effectiveDate" | "terminationDate", label: string): void {
  const candidates = labeledFinder(ctx.doc, label, dateFinder, { window: 60, nextLine: true });
  pickAndEmit(ctx, fieldKey, candidates, { labeledConfidence: "HIGH", unlabeledConfidence: null });
}

export function extractDates(ctx: RuleContext): void {
  extractDate(ctx, "signedDate", SIGNED_LABEL);
  extractDate(ctx, "effectiveDate", EFFECTIVE_LABEL);
  extractDate(ctx, "terminationDate", TERMINATION_LABEL);
  const effective = findProposal(ctx, "effectiveDate");
  const end = findProposal(ctx, "terminationDate");
  if (effective && end && end.normalizedValue < effective.normalizedValue) {
    addFieldWarning(ctx, "effectiveDate", "end_before_effective");
    addFieldWarning(ctx, "terminationDate", "end_before_effective");
  }
}

// --- Clause text -------------------------------------------------------------------------------

export const MAX_CLAUSE_CHARS = 2000;
const MAX_CLAUSE_LINES = 40;

const RENEWAL_HEADING = String.raw`(?:term\s+(?:and|&)\s+)?renewal(?:\s+(?:terms?|clause|of\s+(?:this\s+)?agreement))?|auto[-\s]?renewal`;
const TERMINATION_HEADING = String.raw`termination(?:\s+(?:of\s+(?:this\s+)?agreement|clause|terms?))?|early\s+termination`;
const NOTICE_HEADING = String.raw`notice\s+period`;
export const SERVICES_HEADING = String.raw`scope\s+of\s+(?:services|work)|services?(?:\s+mandated)?|mandated\s+services|services\s+to\s+be\s+(?:provided|rendered)|deliverables`;

const ALL_HEADINGS = [RENEWAL_HEADING, TERMINATION_HEADING, NOTICE_HEADING, SERVICES_HEADING, String.raw`payment(?:\s+terms)?|fees?|compensation|confidentiality|governing\s+law|jurisdiction|indemnity|liability|term|definitions|general|miscellaneous|intellectual\s+property|exclusivity|representations|warranties|dispute\s+resolution|arbitration|force\s+majeure|incentives?|invoic\w+`].join("|");
const ANY_HEADING_LINE = new RegExp(String.raw`^\s*(?:\d{1,2}(?:\.\d{1,2})*[.)]?\s+)?(?:${ALL_HEADINGS})\s*(?:[:.\-–—]\s*$|$)`, "i");

export function isHeadingLine(text: string): boolean {
  if (ANY_HEADING_LINE.test(text)) return true;
  if (/^\d{1,2}[.)]\s+[A-Z][^.]{0,70}$/.test(text)) return true; // "12. Confidentiality"
  const letters = text.replace(/[^A-Za-z]/g, "");
  return letters.length >= 4 && text.length < 80 && text === text.toUpperCase();
}

function isDotLeader(rest: string): boolean {
  return /^[.\s_·-]{2,}\d{0,3}$/.test(rest);
}

export type ClauseBlock = { text: string; page: number; index: number; length: number; truncated: boolean; spillsToNextPage: boolean };

// Heading-anchored clause blocks: a heading line ("12. Termination", "RENEWAL:",
// "Termination. Either party ...") followed by body lines up to the next heading,
// the page end, or the size bounds.
export function clauseBlocks(doc: DocText, headingSource: string): ClauseBlock[] {
  const heading = new RegExp(String.raw`^\s*(?:\d{1,2}(?:\.\d{1,2})*[.)]?\s+)?(?:${headingSource})\s*(?:[:.\-–—]\s*|$)(?<rest>.*)$`, "i");
  const blocks: ClauseBlock[] = [];
  for (const line of doc.lines) {
    const m = heading.exec(line.text);
    if (!m) continue;
    const rest = (m.groups?.rest ?? "").trim();
    if (isDotLeader(rest)) continue; // table-of-contents entry
    const parts: string[] = rest ? [rest] : [];
    let last: DocLine = line;
    let spills = false;
    let cutByBound = false;
    for (let i = line.lineIndex + 1; i < doc.lines.length; i++) {
      if (parts.length >= MAX_CLAUSE_LINES) {
        // Bound reached while more body text follows (same page, not a heading): truncated.
        const more = doc.lines[i]!;
        cutByBound = more.page === line.page && Boolean(more.text) && !isHeadingLine(more.text);
        break;
      }
      const next = doc.lines[i]!;
      if (next.page !== line.page) {
        spills = parts.length > 0 || Boolean(rest);
        break;
      }
      if (!next.text) {
        if (parts.length > 0) break;
        continue;
      }
      if (isHeadingLine(next.text)) break;
      parts.push(next.text);
      last = next;
      if (parts.join(" ").length > MAX_CLAUSE_CHARS) break;
    }
    let text = cleanValueText(parts.join(" "));
    if (text.length < 8 || isPlaceholder(text)) continue;
    let truncated = cutByBound;
    if (text.length > MAX_CLAUSE_CHARS) {
      text = text.slice(0, MAX_CLAUSE_CHARS).replace(/\s+\S*$/, "");
      truncated = true;
    }
    blocks.push({ text, page: line.page, index: line.start, length: last.start + last.text.length - line.start, truncated, spillsToNextPage: spills });
  }
  return blocks;
}

// Emits the longest heading-anchored clause for a field (several headings of the
// same kind - a table of contents entry and the body, say - are ambiguous, so
// LOW confidence + a warning).
export function emitClause(ctx: RuleContext, fieldKey: Extract<ExtractedFieldKey, "renewalTerms" | "terminationTerms" | "noticeTerms" | "servicesMandated">, blocks: ClauseBlock[]): boolean {
  if (blocks.length === 0) return false;
  const distinct = new Map<string, ClauseBlock>();
  for (const block of blocks) if (!distinct.has(block.text.toLowerCase())) distinct.set(block.text.toLowerCase(), block);
  const ordered = [...distinct.values()].sort((a, b) => b.text.length - a.text.length);
  const chosen = ordered[0]!;
  const warnings: string[] = [];
  if (ordered.length > 1) warnings.push("multiple_distinct_values_found");
  if (chosen.truncated) warnings.push("clause_truncated");
  if (chosen.spillsToNextPage) warnings.push("clause_may_continue_on_next_page");
  emit(ctx, fieldKey, chosen.text, chosen, ordered.length > 1 ? "LOW" : "MEDIUM", warnings);
  return true;
}

const DURATION = /\b\d{1,3}\s*(?:\(\s*\w[\w -]{0,20}\s*\)\s*)?(?:calendar\s+|working\s+|business\s+|clear\s+)?(?:days?|months?)\b/i;

function noticeSentences(doc: DocText): Candidate<string>[] {
  const out: Candidate<string>[] = [];
  for (const line of doc.lines) {
    if (!/\bnotice\b/i.test(line.text)) continue;
    for (const sentence of line.text.split(/(?<=[.;])\s+/)) {
      if (!/\bnotice\b/i.test(sentence) || !DURATION.test(sentence)) continue;
      const text = cleanValueText(sentence).slice(0, 600);
      if (text.length < 15) continue;
      out.push({ value: text, key: text.toLowerCase(), page: line.page, index: line.start + Math.max(0, line.text.indexOf(sentence)), length: sentence.length, labeled: false });
    }
  }
  return out;
}

export function extractClauses(ctx: RuleContext): void {
  emitClause(ctx, "renewalTerms", clauseBlocks(ctx.doc, RENEWAL_HEADING));
  emitClause(ctx, "terminationTerms", clauseBlocks(ctx.doc, TERMINATION_HEADING));
  // Notice: an explicit "Notice Period" clause, else a single notice-with-duration sentence.
  if (!emitClause(ctx, "noticeTerms", clauseBlocks(ctx.doc, NOTICE_HEADING))) {
    pickAndEmit(ctx, "noticeTerms", noticeSentences(ctx.doc), { labeledConfidence: "MEDIUM", unlabeledConfidence: "LOW", extraWarnings: ["sentence_level_match"] });
  }
}

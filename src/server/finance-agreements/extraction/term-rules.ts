import { dateFromParenthetical, findDates } from "./parsers";
import { addFieldWarning, emit, findProposal, pickAndEmit, type RuleContext } from "./rule-context";
import type { ExtractedFieldKey } from "./extraction-types";
import { cleanValueText, finderCandidates, isPlaceholder, labelLines, labeledFinder, regexFinder, sentenceHit, sentencesOf, type Candidate, type DocLine, type DocText, type Sentence } from "./text-utils";

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

  // "Account Name" is ambiguous with a BANK account's "Account Name:" line (see clause 5.2-style bank details); it is
  // only read as a page name when nothing nearby (a couple of lines either side, same page) is bank-details context.
  const BANK_CONTEXT = /\b(?:ifsc|bank\s+name|account\s+(?:no\.?|number)|branch)\b/i;
  const BANK_CONTEXT_WINDOW = 3;
  const isBankDetailsBlock = (line: DocLine): boolean => {
    for (let i = Math.max(0, line.lineIndex - BANK_CONTEXT_WINDOW); i <= Math.min(ctx.doc.lines.length - 1, line.lineIndex + BANK_CONTEXT_WINDOW); i++) {
      const other = ctx.doc.lines[i]!;
      if (other.page === line.page && other.lineIndex !== line.lineIndex && BANK_CONTEXT.test(other.text)) return true;
    }
    return false;
  };

  const names: Candidate<string>[] = [];
  for (const row of labelLines(ctx.doc, String.raw`(?:page|channel|profile|account)\s+name|name\s+of\s+(?:the\s+)?(?:page|channel|profile|account)`)) {
    if (/\baccount\s+name\b/i.test(row.line.text) && isBankDetailsBlock(row.line)) continue;
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

// A date is routinely followed by the SAME date written in words, in parentheses - "10.09.2026 (Tenth September, Two
// Thousand Twenty Six)" - which cross-checks the DD/MM-vs-MM/DD reading. `context` (same line) covers the common case;
// definedDateCandidates below also reads it sentence-wise (line-wrap tolerant) since the words routinely wrap.
const PAREN_AFTER = /^\s*\(([^)]{2,80})\)/;

function wordsCrossCheck(iso: string, after: string): { confirmed: boolean; conflicted: boolean; consumedChars: number } {
  const m = PAREN_AFTER.exec(after);
  if (!m) return { confirmed: false, conflicted: false, consumedChars: 0 };
  const wordsIso = dateFromParenthetical(m[1]!);
  if (wordsIso === null) return { confirmed: false, conflicted: false, consumedChars: 0 };
  return { confirmed: wordsIso === iso, conflicted: wordsIso !== iso, consumedChars: m[0].length };
}

function dateExtras(dayMonthOrderAssumed: boolean, confirmed: boolean, conflicted: boolean): { warnings?: string[]; cap?: "MEDIUM" } {
  const warnings: string[] = [];
  if (dayMonthOrderAssumed && !confirmed) warnings.push("day_month_order_assumed_dd_mm");
  if (conflicted) warnings.push("date_words_mismatch");
  const needsCap = (dayMonthOrderAssumed && !confirmed) || conflicted;
  return { ...(warnings.length > 0 ? { warnings } : {}), ...(needsCap ? { cap: "MEDIUM" as const } : {}) };
}

const dateFinder = (region: string) =>
  findDates(region).map((d) => {
    const cross = wordsCrossCheck(d.iso, region.slice(d.index + d.length));
    return { value: d.iso, key: d.iso, index: d.index, length: d.length, ...dateExtras(d.dayMonthOrderAssumed, cross.confirmed, cross.conflicted) };
  });

const SIGNED_LABEL = String.raw`date\s+of\s+(?:agreement|execution|signing|signature)|agreement\s+date|execution\s+date|signing\s+date|signed\s+on|executed\s+on|dated|(?:made|entered\s+into|executed|signed)\s+(?:on|as\s+of)|made\s+and\s+entered\s+into\s+on`;
const EFFECTIVE_LABEL = String.raw`effective\s+date|date\s+of\s+commencement|commencement\s+date|(?:agreement\s+)?start\s+date|effective\s+from|with\s+effect\s+from|w\.e\.f|term\s+(?:shall\s+)?commence[sd]?(?:\s+on)?|commencing\s+(?:on|from)`;
const TERMINATION_LABEL = String.raw`termination\s+date|(?:agreement\s+)?end\s+date|expiry\s+date|date\s+of\s+(?:expiry|termination)|expires?\s+on|valid\s+(?:till|until|upto|up\s+to)|validity\s+(?:till|until|upto)|(?:agreement\s+)?ends?\s+on`;

// A date whose OWN defining parenthetical follows it - "... as of 10.09.2026 (Tenth September, Two Thousand Twenty
// Six), (hereinafter referred to as "Execution Date")" - names its field from the DEFINITION after the date, rather
// than from a label before it (common in recitals, where the preamble sentence bundles several such definitions).
// Read sentence-wise: the words-in-parentheses AND the definition routinely wrap across PDF lines.
const DEFINING_TERM_TO_FIELD: Readonly<Record<string, "signedDate" | "effectiveDate" | "terminationDate">> = {
  "execution date": "signedDate",
  "effective date": "effectiveDate",
  "closure date": "terminationDate",
};
const DEFINING_PHRASE = /^[\s,]{0,10}\(?\s*(?:hereinafter\s+)?(?:referred\s+to\s+as\s+)?["“”']?\s*(execution date|effective date|closure date)\s*["“”']?\s*\)?/i;

function definedDateCandidates(doc: DocText): Record<"signedDate" | "effectiveDate" | "terminationDate", Candidate<string>[]> {
  const byField: Record<"signedDate" | "effectiveDate" | "terminationDate", Candidate<string>[]> = { signedDate: [], effectiveDate: [], terminationDate: [] };
  for (const sentence of sentencesOf(doc)) {
    for (const d of findDates(sentence.flat)) {
      const after = sentence.flat.slice(d.index + d.length);
      const cross = wordsCrossCheck(d.iso, after);
      const m = DEFINING_PHRASE.exec(after.slice(cross.consumedChars, cross.consumedChars + 120));
      if (!m) continue;
      const field = DEFINING_TERM_TO_FIELD[m[1]!.toLowerCase()];
      if (!field) continue;
      const hit = sentenceHit(sentence, d.index, d.length);
      byField[field].push({ value: d.iso, key: d.iso, page: hit.page, index: hit.index, length: hit.length, labeled: true, ...dateExtras(d.dayMonthOrderAssumed, cross.confirmed, cross.conflicted) });
    }
  }
  return byField;
}

function extractDate(ctx: RuleContext, fieldKey: "signedDate" | "effectiveDate" | "terminationDate", label: string, defined: Candidate<string>[]): void {
  // `defined` (the higher-quality, definition-anchored reading) is tried first so it wins a same-value dedup tie.
  const candidates = [...defined, ...labeledFinder(ctx.doc, label, dateFinder, { window: 60, nextLine: true, context: 90 })];
  pickAndEmit(ctx, fieldKey, candidates, { labeledConfidence: "HIGH", unlabeledConfidence: null });
}

export function extractDates(ctx: RuleContext): void {
  const defined = definedDateCandidates(ctx.doc);
  extractDate(ctx, "signedDate", SIGNED_LABEL, defined.signedDate);
  extractDate(ctx, "effectiveDate", EFFECTIVE_LABEL, defined.effectiveDate);
  extractDate(ctx, "terminationDate", TERMINATION_LABEL, defined.terminationDate);
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
// "Termination for Convenience:" / "Termination for Default:" / "Termination for Cause:" are standard legal
// drafting - not an edge case - yet the heading match requires whatever follows "Termination" to be immediately
// followed by punctuation (clauseBlocks' own heading regex: "(?:headingSource)\s*(?:[:.-]|$)"), so without this
// explicit "for <reason>" branch every one of these real, common headings silently fails to match and the whole
// Section 7-style termination clause is dropped - confirmed empirically against a real contract using exactly
// this pattern ("7.2. Termination for Convenience:", "7.3. Termination for Default:"), where terminationTerms
// came back entirely missing despite the clause being right there.
const TERMINATION_HEADING = String.raw`termination(?:\s+(?:of\s+(?:this\s+)?agreement|clause|terms?|for\s+(?:convenience|default|cause|breach|non[-\s]?payment|non[-\s]?performance)))?|early\s+termination`;
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

// A numbered SUB-clause body ("2.1. Social Media Management: ..."), stopping at the next numbered clause marker of
// ANY level (its sibling "2.2.", or the next top-level "3.") rather than only at an ALL_HEADINGS word - so a services
// clause that itself subdivides into "2.1 Management" / "2.2 Timelines" yields ONLY 2.1's own text, never 2.2's.
export const SUB_SERVICES_HEADING = String.raw`social\s+media\s+management|content\s+(?:creation|management)|management\s+and\s+administration|scope\s+of\s+(?:services|work)|services?(?:\s+mandated)?|mandated\s+services`;
const NUMBERED_MARKER_LINE = /^\s*\d{1,2}(?:\.\d{1,3}){0,3}\.?\s+\S/;

export function numberedSubClauseBlocks(doc: DocText, labelSource: string): ClauseBlock[] {
  const heading = new RegExp(String.raw`^\s*\d{1,2}(?:\.\d{1,3}){1,3}\.?\s+(?:${labelSource})\s*(?:[:.\-–—]\s*|$)(?<rest>.*)$`, "i");
  const blocks: ClauseBlock[] = [];
  for (const line of doc.lines) {
    const m = heading.exec(line.text);
    if (!m) continue;
    const rest = (m.groups?.rest ?? "").trim();
    if (isDotLeader(rest)) continue;
    const parts: string[] = rest ? [rest] : [];
    let last: DocLine = line;
    let spills = false;
    let cutByBound = false;
    for (let i = line.lineIndex + 1; i < doc.lines.length; i++) {
      if (parts.length >= MAX_CLAUSE_LINES) {
        const more = doc.lines[i]!;
        cutByBound = more.page === line.page && Boolean(more.text) && !NUMBERED_MARKER_LINE.test(more.text) && !isHeadingLine(more.text);
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
      if (NUMBERED_MARKER_LINE.test(next.text) || isHeadingLine(next.text)) break;
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

// A notice+duration mention routinely sits at the END of a long run-on "sentence" (a numbered list of conditions
// culminating in "... the Client shall terminate ... and may notify the Service Provider ... 30 days ... prior to the
// termination"). Reading sentence-wise (line-wrap tolerant) finds it at all; trimming to the nearest preceding
// "<Subject> shall/may/will/must" clause start keeps the excerpt to the finite clause that actually carries it,
// instead of the whole run-on sentence or a line-wrap fragment.
const CLAUSE_START = /\b(?:the|either|both|any)\s+(?:parties|party|client|company|service\s+provider|vendor|collaborator|partner|consultant|contractor)\b(?:[^,.;]{0,40})?\b(?:shall|may|will|must)\b/gi;

const NOTICE_PERIOD_TERM = /\bnotice\s+period\b/i;

function buildNoticeCandidate(sentence: Sentence, duration: RegExpExecArray): Candidate<string> | null {
  let start = 0;
  for (const m of sentence.flat.matchAll(CLAUSE_START)) {
    if (m.index! > duration.index!) break;
    start = m.index!;
  }
  const text = cleanValueText(sentence.flat.slice(start)).slice(0, 600);
  if (text.length < 15) return null;
  const hit = sentenceHit(sentence, start, Math.min(sentence.flat.length - start, 600));
  return { value: text, key: text.toLowerCase(), page: hit.page, index: hit.index, length: hit.length, labeled: false };
}

function noticeSentences(doc: DocText): Candidate<string>[] {
  const out: Candidate<string>[] = [];
  const strong: Candidate<string>[] = [];
  for (const sentence of sentencesOf(doc)) {
    if (!/\bnotice\b/i.test(sentence.flat)) continue;
    const duration = DURATION.exec(sentence.flat);
    if (!duration) continue;
    const candidate = buildNoticeCandidate(sentence, duration);
    if (!candidate) continue;
    out.push(candidate);
    if (NOTICE_PERIOD_TERM.test(sentence.flat)) strong.push(candidate);
  }
  // A defined "Notice Period" TERM is far stronger evidence than a bare co-occurrence of "notice" and a duration
  // elsewhere in the document (a defect's notice, a Force Majeure notice, ...) - prefer it exclusively when present,
  // so an unrelated incidental mention never creates a false ambiguity.
  return strong.length > 0 ? strong : out;
}

export function extractClauses(ctx: RuleContext): void {
  emitClause(ctx, "renewalTerms", clauseBlocks(ctx.doc, RENEWAL_HEADING));
  emitClause(ctx, "terminationTerms", clauseBlocks(ctx.doc, TERMINATION_HEADING));
  // Notice: an explicit "Notice Period" clause, else a single notice-with-duration sentence.
  if (!emitClause(ctx, "noticeTerms", clauseBlocks(ctx.doc, NOTICE_HEADING))) {
    pickAndEmit(ctx, "noticeTerms", noticeSentences(ctx.doc), { labeledConfidence: "MEDIUM", unlabeledConfidence: "LOW", extraWarnings: ["sentence_level_match"] });
  }
}

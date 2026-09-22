import type { ExtractionConfidence } from "./extraction-types";

// Step 14A: PURE line/label scanning helpers for the field extractors. All
// scanning is line-based and regexes are written to be linear-time; overlong
// lines are chunked first so no single regex ever sees an unbounded input.

export const MAX_LINE_CHARS = 1500;
export const MAX_SNIPPET_CHARS = 300;

export type DocLine = { page: number; text: string; start: number; lineIndex: number };
export type DocText = { pages: string[]; lines: DocLine[] };

export function buildDoc(pages: string[]): DocText {
  const lines: DocLine[] = [];
  pages.forEach((pageText, pageIndex) => {
    let offset = 0;
    for (const rawLine of pageText.split("\n")) {
      // Chunk overlong lines at sentence boundaries where possible, else hard.
      let remaining = rawLine;
      let chunkStart = offset;
      while (remaining.length > MAX_LINE_CHARS) {
        const window = remaining.slice(0, MAX_LINE_CHARS);
        const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "));
        const size = cut > MAX_LINE_CHARS / 3 ? cut + 2 : MAX_LINE_CHARS;
        lines.push({ page: pageIndex + 1, text: remaining.slice(0, size).trim(), start: chunkStart, lineIndex: lines.length });
        remaining = remaining.slice(size);
        chunkStart += size;
      }
      lines.push({ page: pageIndex + 1, text: remaining.trim(), start: chunkStart, lineIndex: lines.length });
      offset += rawLine.length + 1;
    }
  });
  return { pages, lines };
}

// <= 300 chars of the page text around a match, whitespace-collapsed.
export function snippetAt(doc: DocText, page: number, index: number, length: number): string {
  const text = doc.pages[page - 1] ?? "";
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, Math.max(index + length + 120, start + 1));
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (slice.length <= MAX_SNIPPET_CHARS) return slice;
  // Keep the match inside the window: re-centre on the match start.
  const from = Math.max(0, index - start - 60);
  return slice.slice(from, from + MAX_SNIPPET_CHARS).trim();
}

export type Candidate<V> = {
  value: V;
  // Dedupe key (normalized value).
  key: string;
  page: number;
  index: number; // absolute index within the page text
  length: number;
  labeled: boolean;
  // Per-candidate extras carried through to the proposal if it is chosen.
  warnings?: string[];
  cap?: ExtractionConfidence;
};

const NUMBERING = String.raw`(?:\(?\d{1,2}(?:\.\d{1,2})*[.)]\s*|\(?[a-z][.)]\s+)?`;
const LINE_LEAD = String.raw`^[\s\-•*·]*` + NUMBERING;

export type LabelLine = { line: DocLine; tail: string; fromNextLine: boolean; hadSeparator: boolean };

// Lines that BEGIN with `labelSource` (a regex source, case-insensitive), then an
// optional parenthetical, then a separator (":" "=" "-" ...) and the value tail.
// `requireSeparator: false` also accepts "Label value" (used only with strict
// format value regexes). When the tail is empty and `nextLine` is set, the next
// non-empty line of the same page is used as the tail (`line` is then that
// next line, so page/snippet point at the value).
export function labelLines(doc: DocText, labelSource: string, options: { requireSeparator?: boolean; nextLine?: boolean; allowEmptyTail?: boolean } = {}): LabelLine[] {
  const requireSeparator = options.requireSeparator ?? true;
  const regex = new RegExp(`${LINE_LEAD}(?:${labelSource})\\b\\s*(?:\\([^)]{0,40}\\))?\\s*(?<sep>[:\\uFF1A=\\-\\u2013\\u2014])?\\s*(?<tail>.*)$`, "i");
  const out: LabelLine[] = [];
  for (const line of doc.lines) {
    const m = regex.exec(line.text);
    if (!m) continue;
    const hadSeparator = Boolean(m.groups?.sep);
    if (requireSeparator && !hadSeparator) continue;
    const tail = (m.groups?.tail ?? "").trim();
    if (tail) {
      out.push({ line, tail, fromNextLine: false, hadSeparator });
      continue;
    }
    if (options.allowEmptyTail) {
      out.push({ line, tail: "", fromNextLine: false, hadSeparator });
      continue;
    }
    if (!options.nextLine) continue;
    for (let i = line.lineIndex + 1; i < Math.min(doc.lines.length, line.lineIndex + 3); i++) {
      const next = doc.lines[i]!;
      if (next.page !== line.page) break;
      if (next.text) {
        out.push({ line: next, tail: next.text, fromNextLine: true, hadSeparator });
        break;
      }
    }
  }
  return out;
}

// A finder scans a text region and returns value matches (index/length are
// relative to that region).
export type FoundValue<V> = { value: V; key: string; index: number; length: number; warnings?: string[]; cap?: ExtractionConfidence };
export type Finder<V> = (region: string) => FoundValue<V>[];

export function regexFinder<V>(valueRegex: RegExp, build: (match: RegExpExecArray) => { value: V; key: string } | null): Finder<V> {
  const flags = valueRegex.flags.includes("g") ? valueRegex.flags : valueRegex.flags + "g";
  return (region) => {
    const out: FoundValue<V>[] = [];
    const scan = new RegExp(valueRegex.source, flags);
    for (const match of region.matchAll(scan)) {
      const built = build(match as RegExpExecArray);
      if (built) out.push({ value: built.value, key: built.key, index: match.index!, length: match[0].length });
    }
    return out;
  };
}

// The FIRST value found in a bounded window after a label that appears ANYWHERE
// in a line (not only at line start). The window stops one label's search from
// swallowing another label's value. `nextLine` lets a label that ends its line
// take the value from the following line.
//
// `context` (default 0) lets the finder SEE that many extra characters beyond the window - used to read a
// "(date in words)" parenthetical that follows a value - but a value only counts when it lies inside the window.
export function labeledFinder<V>(doc: DocText, labelSource: string, finder: Finder<V>, options: { window?: number; nextLine?: boolean; context?: number } = {}): Candidate<V>[] {
  const window = options.window ?? 70;
  const context = options.context ?? 0;
  const inWindow = (found: FoundValue<V>) => found.index + found.length <= window;
  const labelRegex = new RegExp(`(?:^|[\\s,;|(])(?:${labelSource})\\b\\s*(?:\\([^)]{0,40}\\))?\\s*[:\\uFF1A=\\-\\u2013\\u2014]?\\s*`, "gi");
  const out: Candidate<V>[] = [];
  for (const line of doc.lines) {
    for (const label of line.text.matchAll(labelRegex)) {
      const from = label.index! + label[0].length;
      let found = finder(line.text.slice(from, from + window + context)).find(inWindow);
      let base = { line, offset: from };
      if (!found && options.nextLine && from >= line.text.length) {
        const next = doc.lines[line.lineIndex + 1];
        if (next && next.page === line.page && next.text) {
          found = finder(next.text.slice(0, window + context)).find(inWindow);
          base = { line: next, offset: 0 };
        }
      }
      if (!found) continue;
      out.push({ value: found.value, key: found.key, page: base.line.page, index: base.line.start + base.offset + found.index, length: found.length, labeled: true, warnings: found.warnings, cap: found.cap });
    }
  }
  return out;
}

// Values found anywhere in the document, no label.
export function finderCandidates<V>(doc: DocText, finder: Finder<V>): Candidate<V>[] {
  const out: Candidate<V>[] = [];
  for (const line of doc.lines) {
    for (const found of finder(line.text)) {
      out.push({ value: found.value, key: found.key, page: line.page, index: line.start + found.index, length: found.length, labeled: false, warnings: found.warnings, cap: found.cap });
    }
  }
  return out;
}

const CONFIDENCE_ORDER: ExtractionConfidence[] = ["UNKNOWN", "LOW", "MEDIUM", "HIGH"];

export function capConfidence(confidence: ExtractionConfidence, cap: ExtractionConfidence): ExtractionConfidence {
  return CONFIDENCE_ORDER.indexOf(confidence) <= CONFIDENCE_ORDER.indexOf(cap) ? confidence : cap;
}

export function uniqueByKey<V>(candidates: Candidate<V>[]): Candidate<V>[] {
  const seen = new Set<string>();
  const out: Candidate<V>[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    out.push(candidate);
  }
  return out;
}

// Document order (page, then position).
export function byPosition<V>(a: Candidate<V>, b: Candidate<V>): number {
  return a.page - b.page || a.index - b.index;
}

export function cleanValueText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/^[\s:;,.\-–—]+|[\s:;,\-–—]+$/g, "").trim();
}

// Blank templates, placeholders and "not applicable" markers are never values.
const PLACEHOLDER = /^(?:n\/?a|nil|none|not applicable|not available|na|tbd|to be (?:decided|confirmed|filled|mentioned)|\[.*\]|_+|\.+|x+|-+|\?+)$/i;
export function isPlaceholder(text: string): boolean {
  const cleaned = text.replace(/[\s_.*]+/g, (run) => (run.replace(/\s/g, "").length ? run : " ")).trim();
  return cleaned.length === 0 || PLACEHOLDER.test(cleaned) || /^[_.\s]{3,}$/.test(text);
}

// --- Sentences (page-level, line-wrap tolerant) -------------------------------------------------------------------

// A contract sentence routinely wraps over several PDF lines, so a rule that must read a whole clause ("The Fee shall be
// contingent upon <wrap> the submission of ...") cannot work line by line. A Sentence is a run of one page's text between
// sentence boundaries; `flat` is its whitespace-collapsed text and `map[i]` the offset of flat[i] in the RAW page text, so
// a hit found in `flat` still points at the right place for the page number and the snippet.
export type Sentence = { page: number; index: number; length: number; flat: string; map: Int32Array };

const MAX_SENTENCE_CHARS = 1600;
const ABBREVIATION_BEFORE = /(?:\b(?:Rs|No|Nos|Pvt|Ltd|Inc|Co|Mr|Ms|Mrs|Dr|St|Sr|Jr|Vs|Viz|Approx|Dept|Ref)|\bi\.e|\be\.g)\.$/i;
// A boundary is ". "/"; " before a capital/quote/digit, a blank line, or a numbered clause marker at a line start.
const SENTENCE_BOUNDARY = /(?<=[.;])[ \t\r\n]+(?=[A-Z(“"‘\d])|\n[ \t\r]*\n|\n(?=[ \t]*\d{1,2}(?:\.\d{1,3})+\.?[ \t]+[A-Z])/g;

function buildSentence(page: number, pageText: string, start: number, end: number): Sentence | null {
  const raw = pageText.slice(start, end);
  const chars: string[] = [];
  const map: number[] = [];
  let lastWasSpace = true;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        chars.push(" ");
        map.push(start + i);
      }
      lastWasSpace = true;
    } else {
      chars.push(ch);
      map.push(start + i);
      lastWasSpace = false;
    }
  }
  while (chars.length > 0 && chars[chars.length - 1] === " ") {
    chars.pop();
    map.pop();
  }
  if (chars.length < 4) return null;
  return { page, index: map[0]!, length: map[map.length - 1]! - map[0]! + 1, flat: chars.join(""), map: Int32Array.from(map) };
}

const SENTENCE_CACHE = new WeakMap<DocText, Sentence[]>();

export function sentencesOf(doc: DocText): Sentence[] {
  const cached = SENTENCE_CACHE.get(doc);
  if (cached) return cached;
  const out: Sentence[] = [];
  doc.pages.forEach((pageText, pageIndex) => {
    let start = 0;
    const push = (end: number) => {
      // Hard cap: an unpunctuated wall of text is cut, never scanned as one unbounded sentence.
      for (let from = start; from < end; from += MAX_SENTENCE_CHARS) {
        const sentence = buildSentence(pageIndex + 1, pageText, from, Math.min(end, from + MAX_SENTENCE_CHARS));
        if (sentence) out.push(sentence);
      }
    };
    for (const boundary of pageText.matchAll(SENTENCE_BOUNDARY)) {
      const at = boundary.index!;
      if (ABBREVIATION_BEFORE.test(pageText.slice(Math.max(0, at - 8), at))) continue;
      push(at);
      start = at + boundary[0].length;
    }
    push(pageText.length);
  });
  SENTENCE_CACHE.set(doc, out);
  return out;
}

// The RAW-page location of flat[flatIndex .. flatIndex + flatLength).
export function sentenceHit(sentence: Sentence, flatIndex: number, flatLength: number): { page: number; index: number; length: number } {
  const from = sentence.map[Math.min(flatIndex, sentence.map.length - 1)]!;
  const last = sentence.map[Math.min(flatIndex + Math.max(flatLength, 1) - 1, sentence.map.length - 1)]!;
  return { page: sentence.page, index: from, length: Math.max(1, last - from + 1) };
}

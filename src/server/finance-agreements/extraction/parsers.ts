import { REGION_ZONES } from "@/server/discovery/types";

// Step 14A: small PURE value parsers used by the field extractors. Every parser
// is conservative: an input it cannot interpret unambiguously yields null - it
// never guesses.

// --- Money ---------------------------------------------------------------------------

// 100 crore rupees, in paise. Anything above is not a plausible per-agreement
// amount in this product; treat it as unparseable rather than trusting it.
export const MAX_AMOUNT_MINOR = 1_000_000_000 * 100;

const MULTIPLIERS: Record<string, number> = { lakh: 100_000, lakhs: 100_000, lac: 100_000, lacs: 100_000, crore: 10_000_000, crores: 10_000_000 };

// Accepts western grouping (25,000 / 1,250,000) and Indian grouping (2,50,000 /
// 1,25,00,000) and no grouping. Rejects malformed grouping (25,00,0 / 2,5000).
function hasValidGrouping(integerPart: string): boolean {
  if (!integerPart.includes(",")) return /^\d+$/.test(integerPart);
  const groups = integerPart.split(",");
  const [first, ...rest] = groups;
  if (!first || !/^\d{1,3}$/.test(first)) return false;
  if (rest.some((group) => !/^\d+$/.test(group))) return false;
  const last = rest[rest.length - 1]!;
  if (last.length !== 3) return false;
  const middle = rest.slice(0, -1);
  const western = middle.every((group) => group.length === 3);
  const indian = middle.every((group) => group.length === 2);
  return western || indian;
}

// numberText like "25,000", "2.5", "1,20,000.50"; multiplier "lakh" | "crore" | undefined.
// Returns integer minor units (paise) or null when it is not exactly representable.
export function parseAmountToMinor(numberText: string, multiplier?: string): number | null {
  const [integerPart, fractionPart = ""] = numberText.split(".");
  if (!integerPart || !hasValidGrouping(integerPart)) return null;
  const mult = multiplier ? MULTIPLIERS[multiplier.toLowerCase()] : 1;
  if (mult === undefined) return null;
  if (!multiplier && fractionPart.length > 2) return null; // paise precision only
  if (fractionPart.length > 4) return null;
  const digits = Number(integerPart.replace(/,/g, "") + fractionPart);
  const scale = 10 ** fractionPart.length;
  // Every intermediate stays below 2^53, so this arithmetic is exact.
  const scaled = digits * mult * 100;
  if (!Number.isSafeInteger(digits) || !Number.isSafeInteger(scaled)) return null;
  if (scaled % scale !== 0) return null;
  const minor = scaled / scale;
  if (minor > MAX_AMOUNT_MINOR) return null;
  return minor;
}

// currencyMarker: an explicit currency prefix / "/-" / "rupees" suffix was present
// (false when only a lakh/crore multiplier marked it as money).
export type FoundAmount = { amountMinor: number; index: number; length: number; currencyMarker: boolean };

// An amount is only recognised when it carries an explicit money marker: a
// currency prefix (Rs., INR, rupee sign), a "/-" or "rupees" suffix, or a
// lakh/crore multiplier. A bare number (or a percentage) is never an amount.
const AMOUNT_PATTERN =
  "(?<![\\d,.])(?:(?<cur>INR|Rs\\.?|\\u20B9|Rupees?)\\s*)?(?<num>(?:\\d{1,3}(?:,\\d{2,3})+|\\d+)(?:\\.\\d+)?)(?!\\d|,\\d)(?:\\s*(?<mult>lakhs?|lacs?|crores?)\\b)?(?:\\s*(?<suf>\\/-|only\\b|rupees?\\b|INR\\b))?(?!\\s*%)";

export function findAmounts(text: string): FoundAmount[] {
  const found: FoundAmount[] = [];
  const pattern = new RegExp(AMOUNT_PATTERN, "gi");
  for (const match of text.matchAll(pattern)) {
    const groups = match.groups ?? {};
    if (!groups.cur && !groups.mult && !groups.suf) continue;
    const amountMinor = parseAmountToMinor(groups.num!, groups.mult);
    if (amountMinor === null) continue;
    found.push({ amountMinor, index: match.index!, length: match[0].length, currencyMarker: Boolean(groups.cur || groups.suf) });
  }
  return found;
}

// --- Dates ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH_NAMES = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec";

export type FoundDate = {
  iso: string; // YYYY-MM-DD
  index: number;
  length: number;
  // True for DD/MM/YYYY where day and month are both <= 12: read as DD/MM (the
  // Indian convention) but flagged, since MM/DD is possible.
  dayMonthOrderAssumed: boolean;
};

function toIso(year: number, month: number, day: number): string | null {
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function findDates(text: string): FoundDate[] {
  const found: FoundDate[] = [];
  const push = (index: number, length: number, iso: string | null, dayMonthOrderAssumed = false) => {
    if (iso) found.push({ iso, index, length, dayMonthOrderAssumed });
  };

  for (const m of text.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) push(m.index!, m[0].length, toIso(+m[1]!, +m[2]!, +m[3]!));

  for (const m of text.matchAll(/(?<![\d/.-])(\d{1,2})([/.-])(\d{1,2})\2(\d{4})(?!\d)/g)) {
    const day = +m[1]!;
    const month = +m[3]!;
    // Read as DD/MM. If the second number cannot be a month, the string is not DD/MM.
    if (month > 12) continue;
    push(m.index!, m[0].length, toIso(+m[4]!, month, day), day <= 12 && day !== month);
  }

  const dayFirst = new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+day)?(?:\\s+of)?[\\s,-]+(${MONTH_NAMES})\\b\\.?,?[\\s,-]+(\\d{4})(?!\\d)`, "gi");
  for (const m of text.matchAll(dayFirst)) push(m.index!, m[0].length, toIso(+m[3]!, MONTHS[m[2]!.toLowerCase()]!, +m[1]!));

  const monthFirst = new RegExp(`\\b(${MONTH_NAMES})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`, "gi");
  for (const m of text.matchAll(monthFirst)) push(m.index!, m[0].length, toIso(+m[3]!, MONTHS[m[1]!.toLowerCase()]!, +m[2]!));

  found.sort((a, b) => a.index - b.index);
  // Drop overlaps (keep the earliest/longest starting match).
  const kept: FoundDate[] = [];
  for (const date of found) {
    const previous = kept[kept.length - 1];
    if (previous && date.index < previous.index + previous.length) continue;
    kept.push(date);
  }
  return kept;
}

// --- Indian mobile numbers -----------------------------------------------------------

// 10 digits starting 6-9, optional +91 / 91 / 0 prefix, optional space/hyphen
// separators. `prefixed` is true when an explicit country prefix was present.
const MOBILE_PATTERN = /(?<!\d)((?:\+|00)?91[\s-]?|0)?([6-9]\d{4}[\s-]?\d{5}|[6-9]\d{2}[\s-]?\d{3}[\s-]?\d{4})(?!\d)/g;

export type FoundMobile = { e164: string; index: number; length: number; prefixed: boolean };

export function findIndianMobiles(text: string): FoundMobile[] {
  const found: FoundMobile[] = [];
  for (const m of text.matchAll(MOBILE_PATTERN)) {
    const digits = m[2]!.replace(/[\s-]/g, "");
    found.push({ e164: `+91${digits}`, index: m.index!, length: m[0].length, prefixed: Boolean(m[1] && /91/.test(m[1])) });
  }
  return found;
}

// --- Aadhaar Verhoeff checksum --------------------------------------------------------

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeffIsValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const reversed = digits.split("").reverse();
  for (let i = 0; i < reversed.length; i++) c = VERHOEFF_D[c]![VERHOEFF_P[i % 8]![+reversed[i]!]!]!;
  return c === 0;
}

// --- Indian states / UTs (canonical REGION_ZONES names) --------------------------------

const CANONICAL_STATES: readonly string[] = Object.values(REGION_ZONES).flat();

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function statePattern(name: string): string {
  return name.split(" & ").map(escapeRegex).join("\\s*(?:&|and)\\s*").replace(/ /g, "\\s+");
}

// Extra spellings only where the mapping to a canonical name is unambiguous.
const STATE_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["J\\s*&\\s*K", "Jammu & Kashmir"],
  ["Pondicherry", "Puducherry"],
  ["Orissa", "Odisha"],
  ["Uttaranchal", "Uttarakhand"],
  ["Andaman\\s*(?:&|and)\\s*Nicobar\\s+Islands", "Andaman & Nicobar"],
];

const STATE_MATCHERS: ReadonlyArray<{ canonical: string; regex: RegExp }> = [
  ...CANONICAL_STATES.map((name) => ({ canonical: name, regex: new RegExp(`\\b${statePattern(name)}\\b`, "i") })),
  ...STATE_ALIASES.map(([source, canonical]) => ({ canonical, regex: new RegExp(`\\b${source}\\b`, "i") })),
];

// Distinct canonical states named in the text, in order of first appearance.
export function findStates(text: string): string[] {
  const hits: Array<{ index: number; canonical: string }> = [];
  for (const { canonical, regex } of STATE_MATCHERS) {
    const m = regex.exec(text);
    if (m) hits.push({ index: m.index, canonical });
  }
  hits.sort((a, b) => a.index - b.index);
  return [...new Set(hits.map((hit) => hit.canonical))];
}

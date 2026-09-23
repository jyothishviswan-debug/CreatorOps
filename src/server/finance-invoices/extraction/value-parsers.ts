// Step 15C section 19/24: small PURE value parsers used by field-extractors.ts. Every parser is
// conservative: an input it cannot interpret unambiguously yields null - it never guesses.
//
// A DELIBERATE, LOCAL COPY of the relevant parts of Finance Agreements' own
// extraction/parsers.ts (money + date recognition only - Invoice extraction never needs the
// contract-specific mobile-number/state/word-date parsers). See pdf-text.ts's own header for why
// this module duplicates rather than imports across the finance-agreements/finance-invoices
// boundary (finance-invoices-static.test.ts enforces the separation structurally).

// --- Money ------------------------------------------------------------------------------------

export const MAX_AMOUNT_MINOR = 1_000_000_000 * 100;

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

// numberText like "25,000", "2.5", "1,20,000.50". Returns integer minor units (paise) or null.
export function parseAmountToMinor(numberText: string): number | null {
  const [integerPart, fractionPart = ""] = numberText.split(".");
  if (!integerPart || !hasValidGrouping(integerPart)) return null;
  if (fractionPart.length > 2) return null; // paise precision only
  const digits = Number(integerPart.replace(/,/g, "") + fractionPart);
  const scale = 10 ** fractionPart.length;
  const scaled = digits * 100;
  if (!Number.isSafeInteger(digits) || !Number.isSafeInteger(scaled)) return null;
  if (scaled % scale !== 0) return null;
  const minor = scaled / scale;
  if (minor > MAX_AMOUNT_MINOR) return null;
  return minor;
}

export type FoundAmount = { amountMinor: number; index: number; length: number; currencyMarker: boolean };

// An amount is only recognised when it carries an explicit money marker: a currency prefix
// (Rs., INR, rupee sign), a "/-" or "only"/"rupees" suffix. A bare number (or a percentage) is
// never an amount - the same discipline as Agreement extraction's own findAmounts.
const AMOUNT_PATTERN =
  "(?<![\\d,.])(?:(?<cur>INR|USD|Rs\\.?|\\u20B9|\\$|Rupees?)\\s*)?(?<num>(?:\\d{1,3}(?:,\\d{2,3})+|\\d+)(?:\\.\\d+)?)(?!\\d|,\\d)(?:\\s*(?<suf>\\/-|only\\b|rupees?\\b))?(?!\\s*%)";

export function findAmounts(text: string): FoundAmount[] {
  const found: FoundAmount[] = [];
  const pattern = new RegExp(AMOUNT_PATTERN, "gi");
  for (const match of text.matchAll(pattern)) {
    const groups = match.groups ?? {};
    if (!groups.cur && !groups.suf) continue;
    const amountMinor = parseAmountToMinor(groups.num!);
    if (amountMinor === null) continue;
    found.push({ amountMinor, index: match.index!, length: match[0].length, currencyMarker: true });
  }
  return found;
}

// --- Dates --------------------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};
const MONTH_NAMES = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec";

export type FoundDate = { iso: string; index: number; length: number; dayMonthOrderAssumed: boolean };

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
    if (month > 12) continue;
    push(m.index!, m[0].length, toIso(+m[4]!, month, day), day <= 12 && day !== month);
  }

  const dayFirst = new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+day)?(?:\\s+of)?[\\s,-]+(${MONTH_NAMES})\\b\\.?,?[\\s,-]+(\\d{4})(?!\\d)`, "gi");
  for (const m of text.matchAll(dayFirst)) push(m.index!, m[0].length, toIso(+m[3]!, MONTHS[m[2]!.toLowerCase()]!, +m[1]!));

  const monthFirst = new RegExp(`\\b(${MONTH_NAMES})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`, "gi");
  for (const m of text.matchAll(monthFirst)) push(m.index!, m[0].length, toIso(+m[3]!, MONTHS[m[1]!.toLowerCase()]!, +m[2]!));

  found.sort((a, b) => a.index - b.index);
  const kept: FoundDate[] = [];
  for (const date of found) {
    const previous = kept[kept.length - 1];
    if (previous && date.index < previous.index + previous.length) continue;
    kept.push(date);
  }
  return kept;
}

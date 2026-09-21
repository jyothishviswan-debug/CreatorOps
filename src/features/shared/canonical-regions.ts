import { DISCOVERY_REGIONS, REGION_ZONE_NAMES, REGION_ZONES } from "@/server/discovery/types";

// The canonical State / UT list the app's region pickers offer (the MSME zone list in src/server/discovery/types), as PURE helpers for
// screens that need one region and a native <select>: the zone groups for <optgroup>, and a forgiving match of a state the Agreement
// states in free text ("KARNATAKA", "Bengaluru, Karnataka 560001", "Andaman and Nicobar") onto exactly one canonical name.
// `regionIds` stays free text server-side; this only shapes what a picker offers and what it pre-selects.

export type RegionGroup = { zone: string; regions: string[] };

export const REGION_GROUPS: readonly RegionGroup[] = REGION_ZONE_NAMES.map((zone) => ({ zone, regions: [...REGION_ZONES[zone]] }));

export const CANONICAL_REGIONS: readonly string[] = DISCOVERY_REGIONS;

// Case-, punctuation- and "&"/"and"-insensitive form used only for comparing.
function comparable(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// The ONE canonical region a piece of text names, or null when it names none or (ambiguously) several. Never guesses a near spelling.
export function matchCanonicalRegion(text: string | null | undefined): string | null {
  if (!text) return null;
  const wanted = comparable(text);
  if (wanted.length === 0) return null;
  const exact = CANONICAL_REGIONS.find((region) => comparable(region) === wanted);
  if (exact) return exact;
  // The text carries a state among other words (a city, a PIN code): accept it only when exactly one canonical name occurs as whole words.
  const padded = ` ${wanted} `;
  const found = CANONICAL_REGIONS.filter((region) => padded.includes(` ${comparable(region)} `));
  return found.length === 1 ? found[0]! : null;
}

// True when `value` is one of the canonical names (exact, as stored).
export function isCanonicalRegion(value: string): boolean {
  return CANONICAL_REGIONS.includes(value);
}

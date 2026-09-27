// Reports Final-Master (spec section 8): reusable, VERSIONED View/Performance-Band distributions.
// Band sets are configurable/versioned data, never one band model hard-coded into every report -
// a new bandSetId can be added later without touching any section builder that references an
// existing one by id.
export type PerformanceBand = { label: string; min: number; max: number | null };

export type PerformanceBandSet = { bandSetId: string; version: number; label: string; bands: PerformanceBand[] };

// The exact band ladder spec section 8 lists for the Monthly reference report.
export const VIEW_BAND_SET_V1: PerformanceBandSet = {
  bandSetId: "views_standard",
  version: 1,
  label: "View bands (standard)",
  bands: [
    { label: "0-1K", min: 0, max: 1_000 },
    { label: "1K-5K", min: 1_000, max: 5_000 },
    { label: "5K-10K", min: 5_000, max: 10_000 },
    { label: "10K-50K", min: 10_000, max: 50_000 },
    { label: "50K-100K", min: 50_000, max: 100_000 },
    { label: "100K-250K", min: 100_000, max: 250_000 },
    { label: "250K-500K", min: 250_000, max: 500_000 },
    { label: "500K-750K", min: 500_000, max: 750_000 },
    { label: "750K-1M", min: 750_000, max: 1_000_000 },
    { label: "1M-5M", min: 1_000_000, max: 5_000_000 },
    { label: "5M-10M", min: 5_000_000, max: 10_000_000 },
    { label: "10M-25M", min: 10_000_000, max: 25_000_000 },
    { label: "25M-50M", min: 25_000_000, max: 50_000_000 },
    { label: "50M-100M", min: 50_000_000, max: 100_000_000 },
    { label: "100M+", min: 100_000_000, max: null },
  ],
};

export const PERFORMANCE_BAND_SETS: Record<string, PerformanceBandSet> = {
  [VIEW_BAND_SET_V1.bandSetId]: VIEW_BAND_SET_V1,
};

export function getPerformanceBandSet(bandSetId: string): PerformanceBandSet {
  const set = PERFORMANCE_BAND_SETS[bandSetId];
  if (!set) throw new Error(`Unknown performance band set: ${bandSetId}`);
  return set;
}

// A value at an exact band boundary falls into the band whose `min` it matches (half-open [min,max)
// intervals) - except the final band, which is closed-ended (max === null means "and above").
export function bandFor(bandSet: PerformanceBandSet, value: number): PerformanceBand | null {
  if (!Number.isFinite(value) || value < 0) return null;
  for (const band of bandSet.bands) {
    if (value >= band.min && (band.max === null || value < band.max)) return band;
  }
  return null;
}

export type DistributionResult = {
  bandSetId: string;
  bandSetVersion: number;
  bands: { label: string; count: number }[];
  omittedNullCount: number;
  totalCounted: number;
};

// `values` may contain null (missing evidence for that item) - null values are counted separately in
// `omittedNullCount`, NEVER coerced to 0 and NEVER silently dropped without disclosure (section 10:
// missing != zero).
export function buildDistribution(values: (number | null)[], bandSetId: string = VIEW_BAND_SET_V1.bandSetId): DistributionResult {
  const bandSet = getPerformanceBandSet(bandSetId);
  const counts = new Map<string, number>(bandSet.bands.map((b) => [b.label, 0]));
  let omittedNullCount = 0;
  let totalCounted = 0;
  for (const value of values) {
    if (value === null || value === undefined) {
      omittedNullCount += 1;
      continue;
    }
    const band = bandFor(bandSet, value);
    if (!band) {
      omittedNullCount += 1;
      continue;
    }
    counts.set(band.label, (counts.get(band.label) ?? 0) + 1);
    totalCounted += 1;
  }
  return {
    bandSetId: bandSet.bandSetId,
    bandSetVersion: bandSet.version,
    bands: bandSet.bands.map((b) => ({ label: b.label, count: counts.get(b.label) ?? 0 })),
    omittedNullCount,
    totalCounted,
  };
}

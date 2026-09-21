import { DISCOVERY_REGIONS } from "@/server/discovery/types";

// Shared by every Region FILTER control (Analytics Partners selector, Partner Reviews
// Workspace): choosing EVERY canonical State/UT ("Select all" / "All regions") is the
// same as no region filter - a record with no region, or only a free-text "Other"
// region, stays visible - so the closed control reads "All regions" without lying
// about what it shows. Anything less is a real narrowing. Pure; no I/O.
export function selectsEveryRegion(regions: readonly string[]): boolean {
  const chosen = new Set(regions.map((region) => region.toLowerCase()));
  return DISCOVERY_REGIONS.every((region) => chosen.has(region.toLowerCase()));
}

export function narrowingRegions(regions: readonly string[]): string[] {
  return selectsEveryRegion(regions) ? [] : [...regions];
}

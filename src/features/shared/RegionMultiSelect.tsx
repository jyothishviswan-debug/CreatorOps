"use client";

import { REGION_ZONE_NAMES, REGION_ZONES } from "@/server/discovery/types";
import { MultiSelectDropdown } from "./MultiSelectDropdown";

const REGION_GROUPS = REGION_ZONE_NAMES.map((zone) => ({ label: zone, options: [...REGION_ZONES[zone]] }));

// Zone-grouped, searchable region multi-select - the canonical State/UT
// list from the MSME Annexure 1 zone classification (REGION_ZONES),
// shared by every region-selection UI (Discovery/Partners/Vendors/
// Campaigns). `regionIds` itself stays free text server-side on every
// domain schema - a state typed via "Other" here is still accepted.
export function RegionMultiSelect({ value, onChange, selectAll = false, compact = false }: { value: string[]; onChange: (next: string[]) => void; selectAll?: boolean; compact?: boolean }) {
  return (
    <MultiSelectDropdown
      value={value}
      onChange={onChange}
      groups={REGION_GROUPS}
      placeholder="Select regions…"
      searchPlaceholder="Search states…"
      allowCustom
      customPlaceholder="Other region…"
      selectAll={selectAll}
      compact={compact}
      allLabel="All regions"
    />
  );
}

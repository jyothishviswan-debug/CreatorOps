"use client";

import { TARGET_AUDIENCES, type TargetAudience } from "@/server/discovery/types";
import { MultiSelectDropdown } from "./MultiSelectDropdown";

const TARGET_AUDIENCE_GROUPS = [{ label: "Target Audience", options: [...TARGET_AUDIENCES] }];

// Multi-select over the closed, canonical audience-segmentation taxonomy
// shared by Discovery Research, Partners, and Campaign targeting (see
// discovery/types.ts's own targetAudienceArraySchema comment). Unlike
// RegionMultiSelect, no `allowCustom` - this is a genuinely fixed
// 5-value enum, never free text. Exposes the real TargetAudience[] type
// to callers even though the underlying MultiSelectDropdown is generic
// over plain strings - every option offered here is already a member of
// TARGET_AUDIENCES, so the cast at this one boundary is safe and keeps
// every call site strongly typed without repeating it.
export function TargetAudienceMultiSelect({ value, onChange, selectAll = false }: { value: TargetAudience[]; onChange: (next: TargetAudience[]) => void; selectAll?: boolean }) {
  return (
    <MultiSelectDropdown
      value={value}
      onChange={(next) => onChange(next as TargetAudience[])}
      groups={TARGET_AUDIENCE_GROUPS}
      placeholder="Select Target Audience…"
      selectAll={selectAll}
      allLabel="All Target Audiences"
    />
  );
}

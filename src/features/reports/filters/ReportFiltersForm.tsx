"use client";

import type { ReportFilterFieldDef } from "@/server/reports/types";

import { FILTER_TYPE_HINT, PLATFORM_FILTER_OPTIONS } from "../copy";
import { PeriodsInput } from "./PeriodsInput";

const MAX_PERIODS_PER_RANGE_FILTER = 6;

export type ReportFiltersFormProps = {
  filters: ReportFilterFieldDef[];
  values: Record<string, string>;
  onChange: (id: string, value: string) => void;
  disabled?: boolean;
};

// Step 19B: renders exactly the ONE report's OWN declared supportedFilters (section 7) - never a
// client-invented filter, never a filter another report happens to support. Filter VALUES are plain
// strings the server re-validates and re-bounds independently (see filters.ts's own
// parseAppliedFilters and each family's own filter parsing) - this form only makes the input easier
// to get right, it is never itself the authority on what is accepted.
export function ReportFiltersForm({ filters, values, onChange, disabled }: ReportFiltersFormProps) {
  if (filters.length === 0) {
    return (
      <p className="foundationnote" data-testid="report-no-filters">
        This report has no configurable filters - it always runs over the actor&apos;s full authorized scope.
      </p>
    );
  }

  return (
    <div className="fields" data-testid="report-filters-form">
      {filters.map((filter) => {
        const value = values[filter.id] ?? "";
        const required = /\(required\)/i.test(filter.label);
        const fieldLabel = filter.label.replace(/\s*\(required\)\s*/i, "");

        if (filter.type === "periodRange") {
          return (
            <div className="field full" key={filter.id}>
              <label>
                {fieldLabel}
                {required ? " *" : ""}
              </label>
              <PeriodsInput value={value} onChange={(next) => onChange(filter.id, next)} max={MAX_PERIODS_PER_RANGE_FILTER} label={fieldLabel} />
              <small>{FILTER_TYPE_HINT[filter.type]}</small>
            </div>
          );
        }

        if (filter.type === "period") {
          return (
            <div className="field" key={filter.id}>
              <label>
                {fieldLabel}
                {required ? " *" : ""}
              </label>
              <input type="month" aria-label={fieldLabel} value={value} disabled={disabled} onChange={(e) => onChange(filter.id, e.target.value)} data-testid={`filter-${filter.id}`} />
              <small>{FILTER_TYPE_HINT[filter.type]}</small>
            </div>
          );
        }

        if (filter.type === "platform") {
          return (
            <div className="field" key={filter.id}>
              <label>
                {fieldLabel}
                {required ? " *" : ""}
              </label>
              <select aria-label={fieldLabel} value={value} disabled={disabled} onChange={(e) => onChange(filter.id, e.target.value)} data-testid={`filter-${filter.id}`}>
                <option value="">Any platform</option>
                {PLATFORM_FILTER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        // partnerRef / partnerAccountRef / campaignRef / status: a well-labeled, bounded text input
        // with an inline hint - the server never treats an unrecognized or malformed value as a
        // grant (section 7's own "Requested IDs never grant access").
        return (
          <div className="field" key={filter.id}>
            <label>
              {fieldLabel}
              {required ? " *" : ""}
            </label>
            <input
              type="text"
              aria-label={fieldLabel}
              placeholder={FILTER_TYPE_HINT[filter.type]}
              value={value}
              disabled={disabled}
              maxLength={200}
              onChange={(e) => onChange(filter.id, e.target.value)}
              data-testid={`filter-${filter.id}`}
            />
            <small>{FILTER_TYPE_HINT[filter.type]}</small>
          </div>
        );
      })}
    </div>
  );
}

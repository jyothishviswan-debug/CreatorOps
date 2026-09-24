"use client";

import { useEffect, useState } from "react";

import { Icon } from "@/ui/icons";
import type { TargetType } from "@/server/operations/target-ref";

import { searchTargetOptions, TARGET_TYPES_WITH_PICKER_SUPPORT, type TargetOption } from "./api-client";
import { TARGET_TYPE_LABEL } from "./copy";

const SEARCH_DEBOUNCE_MS = 300;

export type SelectedTarget = { targetType: TargetType; targetRef: string; label: string };

// Step 18B: the reusable cross-module target picker (spec section "Cross-module target picker").
// A closed target-type dropdown plus a bounded, live search against that type's OWN authoritative
// module list endpoint (via api-client.ts's searchTargetOptions) - never a free-text raw ref as the
// primary selection, never a generic/arbitrary Firestore query. Three of the eleven TARGET_TYPES
// (Partner Review, Agreement, Partner Account) have no general bounded-browse endpoint this picker
// can safely call yet and are shown as "not searchable here" rather than faked - a documented,
// honest Step 18B integration gap (see the completion report), not a silent omission.
export function TargetPicker({ value, onChange }: { value: SelectedTarget | null; onChange: (next: SelectedTarget | null) => void }) {
  const [targetType, setTargetType] = useState<TargetType>(value?.targetType ?? "PARTNER");
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<TargetOption[]>([]);
  const [loading, setLoading] = useState(false);

  const supported = TARGET_TYPES_WITH_PICKER_SUPPORT.includes(targetType);

  useEffect(() => {
    if (!supported) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      void searchTargetOptions(targetType, query, { signal: controller.signal }).then((results) => {
        if (controller.signal.aborted) return;
        setOptions(results);
        setLoading(false);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [targetType, query, supported]);

  const displayOptions = supported ? options : [];

  return (
    <div>
      <div className="fields">
        <div className="field">
          <label htmlFor="target-type-select">Target type</label>
          <select
            id="target-type-select"
            value={targetType}
            onChange={(event) => {
              const next = event.target.value as TargetType;
              setTargetType(next);
              setQuery("");
              setOptions([]);
              setLoading(false);
              onChange(null);
            }}
          >
            {Object.entries(TARGET_TYPE_LABEL).map(([type, label]) => (
              <option key={type} value={type}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {supported && (
          <div className="field">
            <label htmlFor="target-search">Search {TARGET_TYPE_LABEL[targetType]}</label>
            <div className="inputwrap">
              <Icon name="search" />
              <input id="target-search" type="search" placeholder="Type to search…" value={query} onChange={(event) => setQuery(event.target.value)} data-testid="target-search-input" />
            </div>
          </div>
        )}
      </div>

      {!supported && (
        <p className="foundationnote" role="status">
          {TARGET_TYPE_LABEL[targetType]} targets are not yet searchable from this picker. Choose a supported target type, or link this record from its own module screen once that integration is added.
        </p>
      )}

      {supported && (
        <div className="tablewrap" style={{ marginTop: 10 }}>
          <table className="compact">
            <caption className="sr">{TARGET_TYPE_LABEL[targetType]} search results</caption>
            <tbody>
              {loading && (
                <tr>
                  <td>Searching…</td>
                </tr>
              )}
              {!loading && displayOptions.length === 0 && (
                <tr>
                  <td className="foundationnote">No matching {TARGET_TYPE_LABEL[targetType].toLowerCase()} records found.</td>
                </tr>
              )}
              {!loading &&
                displayOptions.map((option) => {
                  const active = value?.targetType === targetType && value.targetRef === option.targetRef;
                  return (
                    <tr key={option.targetRef} className={active ? "active" : undefined} data-testid="target-option-row">
                      <td>
                        <b>
                          {TARGET_TYPE_LABEL[targetType]} · {option.label}
                        </b>
                        <small style={{ display: "block" }}>{option.targetRef}</small>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          className={active ? "btn primary" : "btn"}
                          onClick={() => onChange(active ? null : { targetType, targetRef: option.targetRef, label: option.label })}
                          data-testid="select-target"
                        >
                          {active ? "Selected" : "Select"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      {value && (
        <p className="foundationnote" style={{ marginTop: 8 }} data-testid="selected-target-summary">
          Selected target: {TARGET_TYPE_LABEL[value.targetType]} · {value.label} ({value.targetRef})
        </p>
      )}
    </div>
  );
}

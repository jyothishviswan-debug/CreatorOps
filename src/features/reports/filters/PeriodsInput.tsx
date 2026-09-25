"use client";

import { useState } from "react";

import { Pill } from "@/ui/Badge";
import { Icon } from "@/ui/icons";

import { periodKeyLabel } from "../copy";

const PERIOD_KEY_RE = /^\d{4}-\d{2}$/;

export type PeriodsInputProps = {
  value: string; // comma-separated YYYY-MM list, exactly the raw filter string sent to the server
  onChange: (next: string) => void;
  max: number;
  label: string;
};

// Step 19B: the bounded multi-period control for a "periodRange" filter (currently only Long-Period
// Partner Programme's own required "periods" filter - see families/long-period-partner-programme.ts,
// which caps at 6 explicit YYYY-MM keys and drops anything beyond that bound). This is a genuinely
// usable capped picker, not a raw text box with no guardrails: a native month picker adds one period
// at a time as a removable chip, and the control refuses to add a 7th chip once `max` is reached -
// the server independently re-enforces the same bound (and reports exactly how many periods were
// requested vs. covered vs. dropped in the result), so this is a UX guardrail, never the authority.
export function PeriodsInput({ value, onChange, max, label }: PeriodsInputProps) {
  const periods = value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => PERIOD_KEY_RE.test(p));
  const [draft, setDraft] = useState("");

  function commit(next: string[]) {
    onChange(next.join(","));
  }

  function addDraft() {
    if (!PERIOD_KEY_RE.test(draft)) return;
    if (periods.includes(draft)) {
      setDraft("");
      return;
    }
    if (periods.length >= max) return;
    commit([...periods, draft].sort());
    setDraft("");
  }

  function removeAt(period: string) {
    commit(periods.filter((p) => p !== period));
  }

  const atMax = periods.length >= max;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="month"
          aria-label={`${label} - add a period`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={atMax}
          style={{ width: 150 }}
          data-testid="periods-input-month"
        />
        <button type="button" className="btn" onClick={addDraft} disabled={atMax || !draft} data-testid="periods-input-add">
          <Icon name="plus" />
          Add period
        </button>
        <small className="muted">
          {periods.length} of {max} periods selected
        </small>
      </div>
      {periods.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }} data-testid="periods-input-chips">
          {periods.map((period) => (
            <Pill tone="blue" key={period}>
              {periodKeyLabel(period)}
              <button
                type="button"
                aria-label={`Remove ${periodKeyLabel(period)}`}
                onClick={() => removeAt(period)}
                style={{ marginLeft: 4, border: 0, background: "none", cursor: "pointer", color: "inherit", padding: 0, lineHeight: 1 }}
              >
                ✕
              </button>
            </Pill>
          ))}
        </div>
      )}
      {atMax && (
        <small className="muted" style={{ display: "block", marginTop: 6 }}>
          Maximum of {max} periods reached - remove one to add another.
        </small>
      )}
    </div>
  );
}

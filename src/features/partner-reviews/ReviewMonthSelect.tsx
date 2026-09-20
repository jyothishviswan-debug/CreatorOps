"use client";

import { useId, useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";

// Step 13B: the reporting-month control of the Partner Reviews pages. It mirrors the accepted Analytics
// month selector's markup (a labelled native <select> in the `.actions` row + a `.pill gray` source chip -
// no new CSS). The URL is the single source of truth: choosing a month only navigates; the SERVER
// re-validates it on every render, and an explicit choice is never changed for the user.
export type ReviewMonthOption = { month: string; label: string; href: string };

export function ReviewMonthSelect({ options, value, sourceLabel, latestHref }: { options: ReviewMonthOption[]; value: string | null; sourceLabel: string; latestHref?: string | null }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [selected, setSelected] = useOptimistic<string, string>(value ?? "", (_, next) => next);
  const id = useId();

  if (options.length === 0) {
    return (
      <span className="foundationnote">
        <b>Reporting month</b> · {sourceLabel}
      </span>
    );
  }

  function choose(month: string) {
    const option = options.find((candidate) => candidate.month === month);
    if (!option) return;
    startTransition(() => {
      setSelected(month);
      router.push(option.href, { scroll: false });
    });
  }

  return (
    <div className="actions">
      <label htmlFor={id} className="foundationnote">
        Reporting month
      </label>
      <select id={id} value={selected} onChange={(event) => choose(event.target.value)} style={{ minWidth: 160 }}>
        {options.map((option) => (
          <option key={option.month} value={option.month}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="pill gray" data-testid="month-source">
        {sourceLabel}
      </span>
      {latestHref && (
        <button type="button" className="btn ghost" onClick={() => startTransition(() => router.push(latestHref, { scroll: false }))}>
          Use latest review month
        </button>
      )}
    </div>
  );
}

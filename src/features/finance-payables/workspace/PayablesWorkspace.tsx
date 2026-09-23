"use client";

import { useEffect, useEffectEvent, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Skeleton } from "@/ui/States";
import type { PayableWorkspaceDto } from "@/server/finance-payables/client-dto";

import { PayablesList } from "./PayablesList";
import { LOADING_ANNOUNCEMENT, WORKSPACE_PROJECTION_NOTE, workspaceCountCopy } from "./workspace-copy";
import { EMPTY_WORKSPACE_STATE, hasActiveFilters, withFilter, workspaceHref, workspaceStateKey, type WorkspaceUrlState } from "./workspace-query";
import { summarizeWorkspaceRows } from "./workspace-view-model";
import { useNarrowViewport } from "./use-narrow-viewport";
import { WorkspaceToolbar, type WorkspaceLayout } from "./WorkspaceToolbar";

const COUNTERPARTY_DEBOUNCE_MS = 350;

// Step 15B: the Payables workspace. The SERVER page resolves the actor, parses the URL into `state`,
// reads the first bounded page through listPayablesWorkspace and hands both here. Every filter change is
// a router.replace to the canonical URL: the server re-applies ALL filters and re-renders, and the list
// below is remounted by key (its page cache resets). This shell (the toolbar, the summary strip) is NOT
// keyed, so typing in the counterparty box keeps focus across the refresh.
export function PayablesWorkspace({ initial, state, ignoredFilterCount = 0 }: { initial: PayableWorkspaceDto; state: WorkspaceUrlState; ignoredFilterCount?: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const narrow = useNarrowViewport();
  const [layoutChoice, setLayoutChoice] = useState<WorkspaceLayout | null>(null);
  const layout: WorkspaceLayout | null = layoutChoice ?? (narrow === null ? null : narrow ? "cards" : "table");

  const [refText, setRefText] = useState(state.counterpartyRef ?? "");
  const [pushedRef, setPushedRef] = useState<string | null>(state.counterpartyRef);
  const [seenRef, setSeenRef] = useState<string | null>(state.counterpartyRef);
  if (seenRef !== state.counterpartyRef) {
    setSeenRef(state.counterpartyRef);
    if (state.counterpartyRef !== pushedRef) {
      setRefText(state.counterpartyRef ?? "");
      setPushedRef(state.counterpartyRef);
    }
  }

  const latestState = useRef(state);
  useEffect(() => {
    latestState.current = state;
  }, [state]);

  function navigate(change: Partial<WorkspaceUrlState>) {
    const next = withFilter(latestState.current, { counterpartyRef: refText.trim() || null, ...change });
    latestState.current = next;
    setPushedRef(next.counterpartyRef);
    startTransition(() => {
      router.replace(workspaceHref(next), { scroll: false });
    });
  }

  const commitCounterpartyRef = useEffectEvent(() => navigate({ counterpartyRef: refText.trim() || null }));
  useEffect(() => {
    if (refText.trim() === (pushedRef ?? "")) return;
    const timer = setTimeout(() => commitCounterpartyRef(), COUNTERPARTY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [refText, pushedRef]);

  function clearFilters() {
    setRefText("");
    navigate({ ...EMPTY_WORKSPACE_STATE });
  }

  const anyFilterActive = hasActiveFilters(state);
  const canClear = anyFilterActive || refText.trim().length > 0;
  const countCopy = workspaceCountCopy({ total: initial.totalInBoundedSet, headsRead: initial.disclosure.headsRead, headsTruncated: initial.disclosure.headsTruncated });
  const notices = [...new Set([...(ignoredFilterCount > 0 ? ["Some filters in the link were not valid and were ignored."] : []), ...initial.notices])];
  const summary = summarizeWorkspaceRows(initial.rows);

  return (
    <>
      <SummaryStrip counts={summary} truncated={initial.disclosure.headsTruncated} />

      <section className="panel" aria-busy={pending}>
        <WorkspaceToolbar
          state={state}
          counterpartyRefText={refText}
          onCounterpartyRefText={setRefText}
          onCounterpartyRefCommit={() => navigate({ counterpartyRef: refText.trim() || null })}
          onChange={navigate}
          canClear={canClear}
          onClear={clearFilters}
          resultCount={initial.totalInBoundedSet}
          layout={layout ?? "table"}
          onLayout={setLayoutChoice}
        />

        {notices.map((notice) => (
          <div key={notice} className="banner" role="status" style={{ margin: "0 18px 10px" }}>
            {notice}
          </div>
        ))}

        <p className="foundationnote" style={{ margin: "0 18px 10px" }}>
          <span role="status" aria-live="polite" data-testid="workspace-count">
            {pending ? LOADING_ANNOUNCEMENT : (countCopy ?? "")}
          </span>{" "}
          {WORKSPACE_PROJECTION_NOTE}
        </p>

        {pending || layout === null ? (
          <div style={{ padding: "0 18px 18px" }} aria-hidden="true" data-testid="workspace-loading">
            <Skeleton lines={6} />
          </div>
        ) : (
          <PayablesList key={workspaceStateKey(state)} initial={initial} state={state} layout={layout} anyFilterActive={anyFilterActive} onClearFilters={clearFilters} />
        )}
      </section>
    </>
  );
}

// Step 15B section 4: one compact horizontal summary strip (not large KPI cards) showing Draft / Finance
// review required / Ready for invoice / Void, computed from the current bounded/filtered read.
function SummaryStrip({ counts, truncated }: { counts: { draft: number; financeReviewRequired: number; readyForInvoice: number; void: number }; truncated: boolean }) {
  const items: Array<{ label: string; value: number }> = [
    { label: "Draft", value: counts.draft },
    { label: "Finance review required", value: counts.financeReviewRequired },
    { label: "Ready for invoice", value: counts.readyForInvoice },
    { label: "Void", value: counts.void },
  ];
  return (
    <div className="panel" style={{ marginBottom: 14 }} data-testid="workspace-summary-strip">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 0 }}>
        {items.map((item, index) => (
          <div key={item.label} style={{ flex: "1 1 160px", padding: "14px 18px", borderRight: index < items.length - 1 ? "1px solid var(--line)" : undefined, minWidth: 140 }}>
            <small className="muted" style={{ display: "block", marginBottom: 4 }}>
              {item.label}
            </small>
            <b style={{ fontSize: 20, letterSpacing: "-0.5px" }} data-testid={`summary-${item.label.toLowerCase().replace(/\s+/g, "-")}`}>
              {item.value}
            </b>
          </div>
        ))}
      </div>
      {truncated && (
        <p className="foundationnote" style={{ padding: "0 18px 12px", margin: 0 }}>
          Counts are of the Payables read, not a total.
        </p>
      )}
    </div>
  );
}

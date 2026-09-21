"use client";

import { useEffect, useEffectEvent, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Skeleton } from "@/ui/States";
import type { AgreementWorkspaceDto } from "@/server/finance-agreements/workspace-dto";

import { AgreementsList } from "./AgreementsList";
import { LOADING_ANNOUNCEMENT, WORKSPACE_PROJECTION_NOTE, workspaceCountCopy } from "./workspace-copy";
import { currentMonthKey, EMPTY_WORKSPACE_STATE, hasActiveFilters, withFilter, workspaceHref, workspaceStateKey, type WorkspaceUrlState } from "./workspace-query";
import { useNarrowViewport } from "./use-narrow-viewport";
import { WorkspaceToolbar, type WorkspaceLayout } from "./WorkspaceToolbar";

const SEARCH_DEBOUNCE_MS = 350;

// Step 14B: the Agreements workspace. The SERVER page resolves the actor, parses the URL into `state`, reads the first bounded
// page through listAgreementsWorkspace and hands both here. Every filter change is a router.replace to the canonical URL: the
// server re-applies ALL filters and re-renders, and the list below is remounted by key (its page cache resets). This shell (the
// toolbar, the search text, the live count) is NOT keyed, so typing in the search box keeps focus across the refresh.
export function AgreementsWorkspace({ initial, state, ignoredFilterCount = 0 }: { initial: AgreementWorkspaceDto; state: WorkspaceUrlState; ignoredFilterCount?: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const narrow = useNarrowViewport();
  const [layoutChoice, setLayoutChoice] = useState<WorkspaceLayout | null>(null);
  // `null` until the viewport is known (first frame): the toolbar shows the table toggle, the list a placeholder.
  const layout: WorkspaceLayout | null = layoutChoice ?? (narrow === null ? null : narrow ? "cards" : "table");

  // The search box is local text; it becomes URL state after a short pause (or Enter). `pushedQ` is the last search text this
  // shell navigated to, so a slow refresh can never overwrite what the person kept typing - only an EXTERNAL URL change
  // (back / forward, a link) replaces the text.
  const [searchText, setSearchText] = useState(state.q ?? "");
  const [pushedQ, setPushedQ] = useState<string | null>(state.q);
  const [seenQ, setSeenQ] = useState<string | null>(state.q);
  if (seenQ !== state.q) {
    setSeenQ(state.q);
    if (state.q !== pushedQ) {
      setSearchText(state.q ?? "");
      setPushedQ(state.q);
    }
  }

  // The filter state the NEXT change builds on: the last one this shell navigated to. The `state` prop only catches up when the
  // server render for that navigation lands, so a second quick change (Clear filters, then a select) built on the stale prop would
  // silently bring the cleared filter back.
  const latestState = useRef(state);
  useEffect(() => {
    latestState.current = state;
  }, [state]);

  function navigate(change: Partial<WorkspaceUrlState>) {
    // Every navigation carries the text currently in the box, so no filter change can drop or resurrect a pending search.
    const next = withFilter(latestState.current, { q: searchText.trim() || null, ...change });
    latestState.current = next;
    setPushedQ(next.q);
    startTransition(() => {
      router.replace(workspaceHref(next), { scroll: false });
    });
  }

  const commitSearch = useEffectEvent(() => navigate({ q: searchText.trim() || null }));
  useEffect(() => {
    if (searchText.trim() === (pushedQ ?? "")) return;
    const timer = setTimeout(() => commitSearch(), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText, pushedQ]);

  function clearFilters() {
    setSearchText("");
    navigate({ ...EMPTY_WORKSPACE_STATE });
  }

  const anyFilterActive = hasActiveFilters(state);
  const canClear = anyFilterActive || searchText.trim().length > 0;
  const countCopy = workspaceCountCopy({ total: initial.totalInBoundedSet, headsRead: initial.disclosure.headsRead, headsTruncated: initial.disclosure.headsTruncated });
  const notices = [...new Set([...(ignoredFilterCount > 0 ? ["Some filters in the link were not valid and were ignored."] : []), ...initial.notices])];

  return (
    <section className="panel" aria-busy={pending}>
      <WorkspaceToolbar
        state={state}
        searchText={searchText}
        onSearchText={setSearchText}
        onSearchCommit={() => navigate({ q: searchText.trim() || null })}
        onChange={navigate}
        defaultMonth={currentMonthKey()}
        canClear={canClear}
        onClear={clearFilters}
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
        <AgreementsList key={workspaceStateKey(state)} initial={initial} state={state} layout={layout} anyFilterActive={anyFilterActive} onClearFilters={clearFilters} />
      )}
    </section>
  );
}

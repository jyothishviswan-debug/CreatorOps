"use client";

import { useEffect, useState } from "react";

import { listContent } from "@/features/content/api-client";
import type { ContentDto } from "@/server/content/client-dto";

// Step 11B: the ONE shared implementation of "how many required Content
// items has this Assignment actually completed" - used by both
// AssignmentContentPanel.tsx (the Content summary panel) and
// AssignmentNextActionPanel.tsx's own IN_PROGRESS branch, so the two
// never drift into two independent tally implementations. This performs
// a single bounded, bearer-authorized read (listContent({assignmentRef,
// limit: 20})) and then only TALLIES already-server-decided fields
// (status === "COMPLETED" && qualifyingFulfillment?.kind ===
// "QUALIFYING_REQUIRED") - it never re-derives what counts as qualifying;
// that decision is 100% server-side (see content-lifecycle-service.ts's
// completeContent).
export type AssignmentContentFulfillment = {
  loading: boolean;
  error: string | null;
  contentList: ContentDto[];
  qualifyingCount: number;
  requiredCount: number;
  refresh: () => void;
};

// `enabled` (default true) skips the read entirely when the caller
// doesn't need it yet - e.g. AssignmentNextActionPanel only needs this
// while the Assignment is IN_PROGRESS, so it passes `enabled: status ===
// "IN_PROGRESS"` to avoid an unbounded-feeling extra read on every other
// status.
//
// `loading` is derived, never a separately-set piece of state - the
// effect only ever calls setState from its async callback, never
// synchronously in the effect body (the same established idiom
// AssignmentHistoryDialog.tsx's own comment documents).
export function useAssignmentContentFulfillment(assignmentRef: string, requiredCount: number, enabled = true): AssignmentContentFulfillment {
  const [contentList, setContentList] = useState<ContentDto[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const currentKey = `${assignmentRef}:${reloadToken}`;
  const loading = enabled && loadedKey !== currentKey;

  useEffect(() => {
    if (!enabled || loadedKey === currentKey) return;
    let cancelled = false;
    listContent({ assignmentRef, limit: 20 }).then((result) => {
      if (cancelled) return;
      setLoadedKey(currentKey);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setContentList(result.data.content);
    });
    return () => {
      cancelled = true;
    };
  }, [assignmentRef, enabled, currentKey, loadedKey]);

  const qualifyingCount = contentList.filter((c) => c.status === "COMPLETED" && c.qualifyingFulfillment?.kind === "QUALIFYING_REQUIRED").length;

  return { loading, error, contentList, qualifyingCount, requiredCount, refresh: () => setReloadToken((t) => t + 1) };
}

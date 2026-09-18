"use client";

import { useEffect, useState } from "react";

import { listContent } from "@/features/content/api-client";
import type { ContentDto } from "@/server/content/client-dto";

// Step 11A.1: simplified from a list-tally hook (counting qualifying
// Content items against a required slot count) to a single-thread-status
// hook - there is now at most ONE canonical Content thread per
// Assignment, so "is this Assignment fulfilled" collapses to "has its one
// thread reached APPROVED". This remains the ONE shared implementation of
// that question, used by both AssignmentContentPanel.tsx (the Content
// summary panel) and AssignmentNextActionPanel.tsx's own IN_PROGRESS
// branch, so the two never drift into two independent implementations of
// "what is this Assignment's thread status".
export type AssignmentContentFulfillment = {
  loading: boolean;
  error: string | null;
  thread: ContentDto | null;
  fulfilled: boolean;
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
export function useAssignmentContentFulfillment(assignmentRef: string, enabled = true): AssignmentContentFulfillment {
  const [thread, setThread] = useState<ContentDto | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const currentKey = `${assignmentRef}:${reloadToken}`;
  const loading = enabled && loadedKey !== currentKey;

  useEffect(() => {
    if (!enabled || loadedKey === currentKey) return;
    let cancelled = false;
    // Bounded to 1 - there is at most one canonical thread per Assignment
    // by construction (the contentAssignmentThreadClaims uniqueness lock).
    listContent({ assignmentRef, limit: 1 }).then((result) => {
      if (cancelled) return;
      setLoadedKey(currentKey);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setThread(result.data.content[0] ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [assignmentRef, enabled, currentKey, loadedKey]);

  const fulfilled = thread?.status === "APPROVED";

  return { loading, error, thread, fulfilled, refresh: () => setReloadToken((t) => t + 1) };
}

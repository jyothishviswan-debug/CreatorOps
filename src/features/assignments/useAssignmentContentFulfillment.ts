"use client";

import { useEffect, useState } from "react";

import { listContent } from "@/features/content/api-client";
import type { ContentDto } from "@/server/content/client-dto";

// Finding #50 (reopened): an Assignment can carry SEVERAL Content records
// over its lifetime (one per submission cycle) - never just one - and is
// fulfilled once the COUNT of its APPROVED records reaches its own
// requiredCount (see fulfillment-service.ts, the server-authoritative
// version of this same question). This is the ONE shared client
// implementation, used by both AssignmentContentPanel.tsx (the Content
// summary panel) and AssignmentNextActionPanel.tsx's own IN_PROGRESS
// branch, so the two never drift into two independent counts.
export type AssignmentContentFulfillment = {
  loading: boolean;
  error: string | null;
  threads: ContentDto[];
  requiredCount: number;
  qualifyingCount: number;
  fulfilled: boolean;
  refresh: () => void;
};

// A generous display page size - this is a summary list, not the gating
// decision itself (evaluateAssignmentFulfillment, server-side, is
// unbounded and authoritative; see its own comment for why). Far above
// MAX_ASSIGNMENT_REQUIRED_COUNT so a normal Assignment's full history
// always fits in one page.
const CONTENT_DISPLAY_PAGE_SIZE = 50;

// `enabled` (default true) skips the read entirely when the caller
// doesn't need it yet - e.g. AssignmentNextActionPanel only needs this
// while the Assignment is IN_PROGRESS, so it passes `enabled: status ===
// "IN_PROGRESS"` to avoid an unbounded-feeling extra read on every other
// status. `requiredCount` comes from the caller's own AssignmentDto
// (assignment.brief.requiredCount ?? 1) - both call sites already have it
// in scope, so this never needs its own Assignment read.
//
// `loading` is derived, never a separately-set piece of state - the
// effect only ever calls setState from its async callback, never
// synchronously in the effect body (the same established idiom
// AssignmentHistoryDialog.tsx's own comment documents).
export function useAssignmentContentFulfillment(assignmentRef: string, requiredCount: number, enabled = true): AssignmentContentFulfillment {
  const [threads, setThreads] = useState<ContentDto[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const currentKey = `${assignmentRef}:${reloadToken}`;
  const loading = enabled && loadedKey !== currentKey;

  useEffect(() => {
    if (!enabled || loadedKey === currentKey) return;
    let cancelled = false;
    listContent({ assignmentRef, limit: CONTENT_DISPLAY_PAGE_SIZE }).then((result) => {
      if (cancelled) return;
      setLoadedKey(currentKey);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setThreads(result.data.content);
    });
    return () => {
      cancelled = true;
    };
  }, [assignmentRef, enabled, currentKey, loadedKey]);

  const qualifyingCount = threads.filter((t) => t.status === "APPROVED").length;
  const fulfilled = qualifyingCount >= requiredCount;

  return { loading, error, threads, requiredCount, qualifyingCount, fulfilled, refresh: () => setReloadToken((t) => t + 1) };
}

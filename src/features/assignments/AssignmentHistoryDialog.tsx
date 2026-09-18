"use client";

import { useEffect, useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import { EmptyState } from "@/ui/States";
import type { AssignmentHistoryEventDto } from "@/server/assignments/assignment-service";
import { getAssignmentHistory } from "./api-client";
import { absoluteTime, eventLabel } from "./format";

// Step 10B: the frozen golden-master "History" tab-strip action opens a
// dialog (its own interaction archetype, never a route tab) - reuses the
// existing src/ui/Dialog.tsx DialogShell (native <dialog>, focus trap/
// restore comes free from the browser's own showModal()/close()). Real
// content from the already-built, already-tested getAssignmentHistory
// API (Step 10A) - append-only, read-only, never raw actor ids/refs.
export function AssignmentHistoryDialog({ assignmentRef, open, onClose }: { assignmentRef: string; open: boolean; onClose: () => void }) {
  const [events, setEvents] = useState<AssignmentHistoryEventDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // `loading` is derived, never a separately-set piece of state - the
  // effect only ever calls setState from its async callback, never
  // synchronously in the effect body (matches the codebase's own
  // established idiom, e.g. CampaignHistoryPanel, which starts its
  // loading flag already-true rather than setting it inside the effect).
  const loading = open && loadedFor !== assignmentRef;

  useEffect(() => {
    if (!open || loadedFor === assignmentRef) return;
    let cancelled = false;
    getAssignmentHistory(assignmentRef, { limit: 20 }).then((result) => {
      if (cancelled) return;
      setLoadedFor(assignmentRef);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setEvents(result.data.events);
    });
    return () => {
      cancelled = true;
    };
  }, [open, assignmentRef, loadedFor]);

  return (
    <DialogShell open={open} title="Record history" onClose={onClose}>
      {loading ? (
        <p className="foundationnote">Loading…</p>
      ) : error ? (
        <div className="banner" role="alert">
          {error}
        </div>
      ) : events.length === 0 ? (
        <EmptyState title="No activity yet" icon="clock" />
      ) : (
        events.map((event) => (
          <div className="activity" key={event.id}>
            <span className="eventdot" />
            <div>
              <b>{eventLabel(event.kind)}</b>
              <small>
                {absoluteTime(event.createdAt)} · {event.actorDisplayName ?? "Unknown actor"}
              </small>
            </div>
          </div>
        ))
      )}
    </DialogShell>
  );
}

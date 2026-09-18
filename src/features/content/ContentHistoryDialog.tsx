"use client";

import { useEffect, useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import { EmptyState } from "@/ui/States";
import type { ContentHistoryEventDto } from "@/server/content/content-service";
import { getContentHistory } from "./api-client";
import { absoluteTime, eventLabel } from "./format";

// Step 11B: mirrors src/features/assignments/AssignmentHistoryDialog.tsx
// exactly - real content from the already-built, already-tested
// getContentHistory API (Step 11A). Append-only, read-only, never raw
// actor ids/refs.
export function ContentHistoryDialog({ contentRef, open, onClose }: { contentRef: string; open: boolean; onClose: () => void }) {
  const [events, setEvents] = useState<ContentHistoryEventDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const loading = open && loadedFor !== contentRef;

  useEffect(() => {
    if (!open || loadedFor === contentRef) return;
    let cancelled = false;
    getContentHistory(contentRef, { limit: 20 }).then((result) => {
      if (cancelled) return;
      setLoadedFor(contentRef);
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
  }, [open, contentRef, loadedFor]);

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

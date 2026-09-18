"use client";

import { useEffect, useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import { EmptyState } from "@/ui/States";
import type { ContentDto } from "@/server/content/client-dto";
import type { ContentHistoryEventDto } from "@/server/content/content-service";
import { getContentHistory } from "./api-client";
import { absoluteTime, platformLabel } from "./format";

// Step 11A.1: read-only - the current revision's own links are already
// loaded client-side on the ContentDto (currentLinks), so no extra fetch
// is needed for those. The "when" history below (one line per revision
// submitted/decision made) reuses the already-existing getContentHistory
// read rather than inventing a new dedicated revisions-list endpoint -
// exactly the "submitted"/"approved"/"revision_requested" event kinds
// already carry that timeline.
export function ContentEvidenceDialog({ content, open, onClose }: { content: ContentDto; open: boolean; onClose: () => void }) {
  const [events, setEvents] = useState<ContentHistoryEventDto[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!open || loadedFor === content.contentRef) return;
    let cancelled = false;
    getContentHistory(content.contentRef, { limit: 20 }).then((result) => {
      if (cancelled) return;
      setLoadedFor(content.contentRef);
      if (result.ok) {
        setEvents(result.data.events.filter((e) => e.kind === "submitted" || e.kind === "approved" || e.kind === "revision_requested"));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, content.contentRef, loadedFor]);

  return (
    <DialogShell open={open} title="Submitted links" onClose={onClose}>
      <p className="foundationnote" style={{ marginBottom: 8 }}>
        Current revision ({content.currentRevisionNumber || "none yet"})
      </p>
      {content.currentLinks.length === 0 ? (
        <EmptyState title="No links submitted yet" icon="clock" />
      ) : (
        content.currentLinks.map((link) => (
          <div className="activity" key={link.normalizedUrl}>
            <span className="eventdot" />
            <div>
              <b>{platformLabel(link.platform)}</b>
              <div>
                <a href={link.originalUrl} target="_blank" rel="noreferrer noopener">
                  {link.originalUrl}
                </a>
              </div>
              <small>Recorded {absoluteTime(link.recordedAt)}</small>
            </div>
          </div>
        ))
      )}

      {events.length > 0 && (
        <>
          <p className="foundationnote" style={{ margin: "18px 0 8px" }}>
            Revision timeline
          </p>
          {events.map((event) => (
            <div className="activity" key={event.id}>
              <span className="eventdot" />
              <div>
                <b>
                  {event.kind === "submitted" ? "Links submitted" : event.kind === "approved" ? "Approved" : "Revision requested"}
                  {typeof event.metadata?.revisionNumber === "number" ? ` · revision ${event.metadata.revisionNumber}` : ""}
                </b>
                <small>{absoluteTime(event.createdAt)}</small>
              </div>
            </div>
          ))}
        </>
      )}
    </DialogShell>
  );
}

"use client";

import { DialogShell } from "@/ui/Dialog";
import { EmptyState } from "@/ui/States";
import type { ContentDto } from "@/server/content/client-dto";
import { platformLabel } from "./format";

// Step 11B: read-only - the full ContentDto (including publicationEvidence)
// is already loaded client-side by the time this opens, so no extra fetch
// is needed. Each evidence item's URL is a safe external link
// (target="_blank" rel="noreferrer noopener").
export function ContentEvidenceDialog({ content, open, onClose }: { content: ContentDto; open: boolean; onClose: () => void }) {
  return (
    <DialogShell open={open} title="Publication evidence" onClose={onClose}>
      {content.publicationEvidence.length === 0 ? (
        <EmptyState title="No publication evidence yet" icon="clock" />
      ) : (
        content.publicationEvidence.map((evidence) => (
          <div className="activity" key={evidence.evidenceId}>
            <span className="eventdot" />
            <div>
              <b>{platformLabel(evidence.platform)}</b>
              <div>
                <a href={evidence.originalUrl} target="_blank" rel="noreferrer noopener">
                  {evidence.originalUrl}
                </a>
              </div>
              <small>
                {evidence.platformContentId ? `ID ${evidence.platformContentId} · ` : ""}
                {evidence.publishedAt ? `Published ${evidence.publishedAt.slice(0, 10)}` : "Publish date not recorded"}
              </small>
            </div>
          </div>
        ))
      )}
    </DialogShell>
  );
}

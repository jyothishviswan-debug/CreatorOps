"use client";

import { useState } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import type { ContentDto } from "@/server/content/client-dto";
import { platformLabel } from "./format";
import { ContentEvidenceDialog } from "./ContentEvidenceDialog";

// Step 11A.1: repurposed from "versions, review and publication
// evidence" to "submitted links" - there is no separate version/
// publication-evidence concept anymore, only the thread's own current
// revision and its links (currentRevisionNumber/currentLinks are already
// denormalized onto the loaded ContentDto, no extra fetch needed).
export function ContentEvidencePanel({ content }: { content: ContentDto }) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const latest = content.currentLinks[content.currentLinks.length - 1] ?? null;

  return (
    <Panel span={4}>
      <PanelHead title="Submitted links" description="The current revision's own links" />
      <PanelBody>
        <div className="kv">
          <span>Current revision</span>
          <b>{content.currentRevisionNumber > 0 ? content.currentRevisionNumber : "No submission yet"}</b>
        </div>
        {content.reviewedRevisionNumber !== null && (
          <div className="kv">
            <span>Awaiting decision on</span>
            <b>Revision {content.reviewedRevisionNumber}</b>
          </div>
        )}
        <div className="kv">
          <span>Links in this revision</span>
          <b>{content.currentLinks.length}</b>
        </div>
        {latest && (
          <p className="detailcopy" style={{ marginTop: 10 }}>
            Latest: {platformLabel(latest.platform)} ·{" "}
            <a href={latest.originalUrl} target="_blank" rel="noreferrer noopener">
              View link
            </a>
          </p>
        )}
        <div className="actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn" onClick={() => setEvidenceOpen(true)}>
            View links
          </button>
        </div>
      </PanelBody>
      <ContentEvidenceDialog content={content} open={evidenceOpen} onClose={() => setEvidenceOpen(false)} />
    </Panel>
  );
}

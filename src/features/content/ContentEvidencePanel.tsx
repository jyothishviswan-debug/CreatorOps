"use client";

import { useState } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import type { ContentDto } from "@/server/content/client-dto";
import { platformLabel } from "./format";
import { ContentEvidenceDialog } from "./ContentEvidenceDialog";

// Step 11B: "Content evidence" panel - versions/review/publication
// evidence, compact. currentVersion/lastSubmittedVersion/evidence count
// all come straight off the already-loaded ContentDto, no extra fetch.
export function ContentEvidencePanel({ content }: { content: ContentDto }) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const latest = content.publicationEvidence[content.publicationEvidence.length - 1] ?? null;

  return (
    <Panel span={4}>
      <PanelHead title="Content evidence" description="Versions, review and publication evidence" />
      <PanelBody>
        <div className="kv">
          <span>Current version</span>
          <b>{content.currentVersion > 0 ? content.currentVersion : "No version saved yet"}</b>
        </div>
        {content.lastSubmittedVersion !== null && (
          <div className="kv">
            <span>Last reviewed</span>
            <b>Version {content.lastSubmittedVersion}</b>
          </div>
        )}
        <div className="kv">
          <span>Publication evidence</span>
          <b>{content.publicationEvidence.length}</b>
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
            View evidence
          </button>
        </div>
      </PanelBody>
      <ContentEvidenceDialog content={content} open={evidenceOpen} onClose={() => setEvidenceOpen(false)} />
    </Panel>
  );
}

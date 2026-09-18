"use client";

import { useState } from "react";
import Link from "next/link";

import { Panel, PanelBody, PanelGrid, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState } from "@/ui/States";
import { Icon } from "@/ui/icons";
import type { ContentDto } from "@/server/content/client-dto";
import { absoluteTime, contentDisplayTitle, dateLabel, STATUS_LABELS, statusTone } from "./format";
import { CONTENT_MAINLINE_STEPS, reachedIndex, stepStates } from "./workflow";
import { ContentHistoryDialog } from "./ContentHistoryDialog";
import { ContentNotesDialog } from "./ContentNotesDialog";
import { ContentNextActionPanel } from "./ContentNextActionPanel";
import { ContentEvidencePanel } from "./ContentEvidencePanel";
import { ContentWorkflowPanel } from "./ContentWorkflowPanel";

// Step 11B: the frozen golden-master Content Detail structure, mirroring
// src/features/assignments/AssignmentDetail.tsx's own section order
// exactly: header/actions -> 4-box context strip -> tab/action strip
// (Overview/Notes & meetings/History + scope chip) -> lifecycle workflow
// step strip -> first grid (Record context span8, Next action span4) ->
// second grid (Content evidence, Content workflow, Notes & meetings).
// No Edit page button anywhere (task doc's own explicit prohibition).
export function ContentDetail({ initialContent, actorCanReview }: { initialContent: ContentDto; actorCanReview: boolean }) {
  const [content, setContent] = useState(initialContent);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  function handleContentUpdated(updated: ContentDto) {
    setContent(updated);
  }

  const displayTitle = contentDisplayTitle(content);
  const steps = CONTENT_MAINLINE_STEPS;
  const currentReachedIndex = reachedIndex(content);
  const states = stepStates(currentReachedIndex, steps.length, content.status, steps);

  const showBranchBanner = content.status === "REVISION_REQUESTED" || content.status === "CANCELLED";

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">CONTENT / RECORD DETAIL</div>
          <h1>{displayTitle}</h1>
          <p>
            {content.partnerDisplayName ?? "Unknown Partner"} · {content.campaignName ?? "Unknown Campaign"}
          </p>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={() => setHistoryOpen(true)}>
            Inspect history
          </button>
          <Link href="/content" className="btn">
            Back to Content
          </Link>
        </div>
      </div>

      <div className="detailcontext">
        <div>
          <small>Status</small>
          <Pill tone={statusTone(content.status)}>{STATUS_LABELS[content.status]}</Pill>
        </div>
        <div>
          <small>Responsible owner</small>
          <b>{content.ownerDisplayName ?? "Unassigned"}</b>
        </div>
        <div>
          <small>Region</small>
          <b>{content.regionIds.length > 0 ? content.regionIds.join(", ") : "—"}</b>
        </div>
        <div>
          <small>Last updated</small>
          <b>{absoluteTime(content.updatedAt)}</b>
        </div>
      </div>

      <div className="workflow" role="tablist" aria-label="Content sections" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 23 }}>
          <span className="step current" role="tab" aria-selected="true">
            Overview
          </span>
          <button type="button" className="step" role="tab" aria-selected="false" onClick={() => setNotesOpen(true)}>
            Notes &amp; meetings
          </button>
          <button type="button" className="step" role="tab" aria-selected="false" onClick={() => setHistoryOpen(true)}>
            History
          </button>
        </div>
        <span className="scope">
          <Icon name="shield" />
          Authorized record preview
        </span>
      </div>

      <div className="workflow" aria-hidden="true">
        {steps.map((step, i) => (
          <div key={step} className={`step ${states[i] ?? ""}`}>
            <i>{states[i] === "done" ? "✓" : i + 1}</i>
            {STATUS_LABELS[step]}
          </div>
        ))}
      </div>

      {showBranchBanner && (
        <div className="banner" role="status" style={{ margin: "0 0 15px" }}>
          {content.status === "REVISION_REQUESTED" && (
            <>
              <p style={{ margin: "0 0 4px" }}>The public submission page has reopened for correction.</p>
              <b>Changes requested.</b> {content.statusReason ?? "No reason recorded."}
            </>
          )}
          {content.status === "CANCELLED" && (
            <>
              <b>Cancelled.</b> {content.statusReason ?? "No reason recorded."}
            </>
          )}
        </div>
      )}

      <PanelGrid>
        <Panel span={8}>
          <PanelHead title="Record context" description="Essential details stay visible" />
          <PanelBody>
            <p className="detailcopy">
              {content.currentRevisionNumber > 0
                ? `${content.currentLinks.length} link(s) submitted (revision ${content.currentRevisionNumber}).`
                : "No links have been submitted yet - the public submission page is still open."}
            </p>
            <div style={{ marginTop: 14 }}>
              <div className="kv">
                <span>Due date</span>
                <b>{content.dueAt ? dateLabel(content.dueAt) : "No due date"}</b>
              </div>
              <div className="kv">
                <span>Campaign</span>
                <b>{content.campaignName ?? "Unknown Campaign"}</b>
              </div>
              <div className="kv">
                <span>Partner</span>
                <b>{content.partnerDisplayName ?? "Unknown Partner"}</b>
              </div>
            </div>
          </PanelBody>
        </Panel>
        <ContentNextActionPanel content={content} actorCanReview={actorCanReview} onSaved={handleContentUpdated} />
      </PanelGrid>

      <div className="grid three">
        <ContentEvidencePanel content={content} />
        <ContentWorkflowPanel content={content} onSaved={handleContentUpdated} />
        <Panel span={4}>
          <PanelHead title="Notes & meetings" description="Keep the conversation with the record" />
          <PanelBody>
            <EmptyState title="Not yet built" description="No real trusted source is wired to this Content record yet." icon="clock" />
          </PanelBody>
        </Panel>
      </div>

      <ContentHistoryDialog contentRef={content.contentRef} open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <ContentNotesDialog open={notesOpen} onClose={() => setNotesOpen(false)} />
    </>
  );
}

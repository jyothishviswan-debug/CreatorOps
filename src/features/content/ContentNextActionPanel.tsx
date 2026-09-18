"use client";

import { useState } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Icon } from "@/ui/icons";
import type { ContentDto } from "@/server/content/client-dto";
import { completeContent, startContentProduction, submitContentForReview } from "./api-client";
import { decideNextAction } from "./workflow";
import { ContentVersionDialog } from "./ContentVersionDialog";
import { ContentReviewDialog } from "./ContentReviewDialog";
import { ContentPublicationDialog } from "./ContentPublicationDialog";

// Step 11B: the frozen golden-master "Next action" panel shape (title/
// description preserved verbatim, mirrors AssignmentNextActionPanel.tsx's
// JSX archetype exactly) - mapped to the Content Next Action decision
// table in workflow.ts's decideNextAction, the ONE place this mapping is
// computed (unit-tested there, rendered here).
export function ContentNextActionPanel({ content, actorCanReview, onSaved }: { content: ContentDto; actorCanReview: boolean; onSaved: (content: ContentDto) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versionDialogOpen, setVersionDialogOpen] = useState(false);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [publicationDialogOpen, setPublicationDialogOpen] = useState(false);

  const action = decideNextAction(content, actorCanReview);

  async function runStartProduction() {
    setBusy(true);
    setError(null);
    const result = await startContentProduction(content.contentRef, { expectedVersion: content.version });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved(result.data);
  }

  async function runSubmitForReview() {
    setBusy(true);
    setError(null);
    const result = await submitContentForReview(content.contentRef, { expectedVersion: content.version });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved(result.data);
  }

  async function runCompleteContent() {
    setBusy(true);
    setError(null);
    const result = await completeContent(content.contentRef, { expectedVersion: content.version });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved(result.data);
  }

  let heading = "";
  let description = "Server remains authoritative - this action is re-verified on every attempt.";
  let buttonLabel: string | null = null;
  let onClick: (() => void) | null = null;

  switch (action) {
    case "start_production":
      heading = "Start production";
      buttonLabel = "Start production";
      onClick = runStartProduction;
      break;
    case "save_production_version":
      heading = "Save production version";
      buttonLabel = "Save production version";
      onClick = () => setVersionDialogOpen(true);
      break;
    case "submit_for_review":
      heading = "Submit for review";
      buttonLabel = "Submit for review";
      onClick = runSubmitForReview;
      break;
    case "record_publication":
      heading = "Record publication";
      buttonLabel = "Record publication";
      onClick = () => setPublicationDialogOpen(true);
      break;
    case "review_submission":
      heading = "Review submission";
      buttonLabel = "Review submission";
      onClick = () => setReviewDialogOpen(true);
      break;
    case "awaiting_review":
      heading = "Awaiting authorized review";
      description = "This Content is submitted and waiting on an authorized reviewer.";
      break;
    case "save_revised_version":
      heading = "Save revised version";
      buttonLabel = "Save revised version";
      onClick = () => setVersionDialogOpen(true);
      break;
    case "resubmit_for_review":
      heading = "Resubmit for review";
      buttonLabel = "Resubmit for review";
      onClick = runSubmitForReview;
      break;
    case "complete_content":
      heading = "Complete Content";
      buttonLabel = "Complete Content";
      onClick = runCompleteContent;
      break;
    case "terminal_completed":
      heading = "Content completed";
      description = "This Content is in a terminal state - no further action is available.";
      break;
    case "terminal_rejected":
      heading = "Rejected";
      description = "This Content is in a terminal state - no further action is available.";
      break;
    case "terminal_cancelled":
      heading = "Content cancelled";
      description = "This Content is in a terminal state - no further action is available.";
      break;
    default:
      heading = "No action available";
      description = "There is nothing to do here right now.";
  }

  return (
    <Panel span={4}>
      <PanelHead title="Next action" description="Keep the workflow moving" />
      <PanelBody>
        <span className="tile">
          <Icon name="check" />
        </span>
        <h3 style={{ marginTop: 12 }}>{heading}</h3>
        <p className="detailcopy" style={{ margin: "8px 0 17px" }}>
          {description}
        </p>
        {buttonLabel && onClick && (
          <button type="button" className="btn primary" disabled={busy} onClick={onClick}>
            {busy ? "Saving…" : buttonLabel}
          </button>
        )}
        {error && (
          <div className="banner" role="alert" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
      </PanelBody>

      <ContentVersionDialog
        content={content}
        title={content.status === "CHANGES_REQUIRED" ? "Save revised version" : "Save production version"}
        open={versionDialogOpen}
        onClose={() => setVersionDialogOpen(false)}
        onSaved={onSaved}
      />
      {content.reviewPolicy === "REVIEW_REQUIRED" && <ContentReviewDialog content={content} open={reviewDialogOpen} onClose={() => setReviewDialogOpen(false)} onSaved={onSaved} />}
      <ContentPublicationDialog content={content} open={publicationDialogOpen} onClose={() => setPublicationDialogOpen(false)} onSaved={onSaved} />
    </Panel>
  );
}

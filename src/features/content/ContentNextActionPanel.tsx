"use client";

import { useState } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Icon } from "@/ui/icons";
import type { ContentDto } from "@/server/content/client-dto";
import { decideNextAction } from "./workflow";
import { ContentReviewDialog } from "./ContentReviewDialog";

// Step 11A.1: drastically simplified mapping - submission only ever
// happens via the public page now, so staff never has a production/
// submit/publication-evidence/complete action here anymore. Only the
// UNDER_REVIEW -> review action remains a real staff action; every other
// status is a neutral, honest status readout (never a fake button).
export function ContentNextActionPanel({ content, actorCanReview, onSaved }: { content: ContentDto; actorCanReview: boolean; onSaved: (content: ContentDto) => void }) {
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);

  const action = decideNextAction(content, actorCanReview);

  let heading = "";
  let description = "Server remains authoritative - this action is re-verified on every attempt.";
  let buttonLabel: string | null = null;
  let onClick: (() => void) | null = null;

  switch (action) {
    case "awaiting_submission":
      heading = content.status === "REVISION_REQUESTED" ? "Awaiting resubmission" : "Awaiting Partner/Vendor submission";
      description =
        content.status === "REVISION_REQUESTED"
          ? "The public submission page has reopened for correction. No staff action is needed here - submission only happens through that page."
          : "No links have been submitted yet. A submission thread is created automatically the first time a public submission link is shared for this Assignment.";
      break;
    case "review_submission":
      heading = "Review submission";
      description = "Links have been submitted and are waiting on your decision.";
      buttonLabel = "Review submission";
      onClick = () => setReviewDialogOpen(true);
      break;
    case "awaiting_review":
      heading = "Awaiting authorized review";
      description = "This submission is waiting on an authorized reviewer.";
      break;
    case "terminal_approved":
      heading = "Approved — closed";
      description = "This submission has been approved. The public page is now closed.";
      break;
    case "terminal_cancelled":
      heading = "Content cancelled";
      description = "This Content thread is in a terminal state - no further action is available.";
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
          <button type="button" className="btn primary" onClick={onClick}>
            {buttonLabel}
          </button>
        )}
      </PanelBody>

      <ContentReviewDialog content={content} open={reviewDialogOpen} onClose={() => setReviewDialogOpen(false)} onSaved={onSaved} />
    </Panel>
  );
}

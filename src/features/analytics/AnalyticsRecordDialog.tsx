"use client";

import { DialogShell } from "@/ui/Dialog";
import { Pill } from "@/ui/Badge";
import type { AnalyticsLabelMaps } from "@/server/analytics/label-resolution";
import type { AnalyticsChannelSourceRecordDoc, AnalyticsContentSourceRecordDoc } from "@/server/analytics/types";

import type { ExplorerRecord } from "./AnalyticsExplorerWorkspace";
import { contentRecordLabel, channelRecordLabel, contentScopeLabel, channelScopeLabel, sourceLabel } from "./explorer-helpers";
import { formatMetric, matchStateLabel, matchStateTone, platformLabel, reportingPeriodLabel } from "./format";

// Read-only source-record inspection - Section 19's own safe evidence
// list: record kind, platform, reporting period, ONLY the canonical
// supported source metrics (never an unsupported one, never a missing
// value rendered as 0), match state, matched context (safe resolved
// labels only), source batch/sheet/row. Never shows a raw auth uid, an
// internal claim id, a Firestore path string, or an unsupported metric.
export function AnalyticsRecordDialog({
  record,
  recordKind,
  labels,
  open,
  onClose,
  actorCanResolve,
  onResolve,
}: {
  record: ExplorerRecord;
  recordKind: "content" | "channel";
  labels: AnalyticsLabelMaps;
  open: boolean;
  onClose: () => void;
  actorCanResolve: boolean;
  onResolve?: () => void;
}) {
  const isContent = recordKind === "content";
  const label = isContent ? contentRecordLabel(record as AnalyticsContentSourceRecordDoc, labels) : channelRecordLabel(record as AnalyticsChannelSourceRecordDoc, labels);
  const scope = isContent ? contentScopeLabel(record as AnalyticsContentSourceRecordDoc, labels) : channelScopeLabel(record as AnalyticsChannelSourceRecordDoc, labels);

  return (
    <DialogShell
      open={open}
      title={label}
      onClose={onClose}
      footer={
        actorCanResolve && record.matchState !== "MATCHED" && onResolve ? (
          <button type="button" className="btn primary" onClick={onResolve}>
            Resolve match
          </button>
        ) : undefined
      }
    >
      <div className="kv">
        <div>
          <span>Record kind</span>
          <b>{isContent ? "Content analytics" : "Channel analytics"}</b>
        </div>
        <div>
          <span>Platform</span>
          <b>{platformLabel(record.platform)}</b>
        </div>
        <div>
          <span>Reporting period</span>
          <b>{reportingPeriodLabel(record.reportingPeriod)}</b>
        </div>
        <div>
          <span>Match state</span>
          <b>
            <Pill tone={matchStateTone(record.matchState)}>{matchStateLabel(record.matchState)}</Pill>
          </b>
        </div>
        <div>
          <span>Matched scope</span>
          <b>{scope}</b>
        </div>
        <div>
          <span>Source</span>
          <b>{sourceLabel(record, labels)}</b>
        </div>
      </div>

      <p className="foundationnote" style={{ margin: "16px 0 8px" }}>
        Source-reported metrics (verified registry only)
      </p>
      <div className="kv">
        {isContent ? <ContentMetrics record={record as AnalyticsContentSourceRecordDoc} /> : <ChannelMetrics record={record as AnalyticsChannelSourceRecordDoc} />}
      </div>

      <p className="foundationnote" style={{ margin: "16px 0 4px" }}>
        Correction status: revision {record.correctionRevision}
        {record.correctionRevision > 1 ? " (has been corrected)" : " (original resolution, never corrected)"}. A dedicated correction-history read endpoint doesn&rsquo;t exist yet in this step, so only the current revision number is
        shown here.
      </p>

      {record.matchState !== "MATCHED" && (
        <p className="foundationnote" style={{ margin: "4px 0 0" }}>
          Match evidence: {record.matchEvidence.reasonCode ?? "No reason code recorded"} ({record.matchEvidence.candidateCount} candidate{record.matchEvidence.candidateCount === 1 ? "" : "s"} considered).
        </p>
      )}
    </DialogShell>
  );
}

function ContentMetrics({ record }: { record: AnalyticsContentSourceRecordDoc }) {
  return (
    <>
      <div>
        <span>Comments</span>
        <b>{formatMetric(record.comments)}</b>
      </div>
      <div>
        <span>Likes</span>
        <b>{formatMetric(record.likes)}</b>
      </div>
      <div>
        <span>Views</span>
        <b>{formatMetric(record.views)}</b>
      </div>
      <div>
        <span>Engagement</span>
        <b>{formatMetric(record.engagement)}</b>
      </div>
      <div>
        <span>Profile followers</span>
        <b>{formatMetric(record.profileFollowers)}</b>
      </div>
    </>
  );
}

function ChannelMetrics({ record }: { record: AnalyticsChannelSourceRecordDoc }) {
  return (
    <div>
      <span>Profile followers</span>
      <b>{formatMetric(record.profileFollowers)}</b>
    </div>
  );
}

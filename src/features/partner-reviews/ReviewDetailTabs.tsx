// Step 13B: the five Review Detail sections. Presentational only - every figure is the accepted actor-scoped
// (redacted) snapshot, copied verbatim; nothing is scored, summed across sections or turned into money.
// Built exclusively from foundation pieces: `.panel` / `.grid`, `.kv` rows, `.pill`, `.tablewrap` + `.compact`
// tables. Unavailable is always the word "Unavailable" (never a zero, never a blank).
import type { ReactNode } from "react";

import { Panel, PanelBody, PanelGrid, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import type { PartnerReviewDetailDto, PartnerReviewVersionDto, PartnerReviewVersionSummaryDto } from "@/server/partner-reviews/client-dto";
import { computeReviewListSummary } from "@/server/partner-reviews/review-list-summary";
import { PARTNER_REVIEW_STATUSES, type PartnerReviewFreshnessState } from "@/server/partner-reviews/types";

import {
  absoluteTime,
  COMMERCIAL_EVIDENCE_LABEL,
  dateOnly,
  DISABLED_BUTTON_STYLE,
  formatCount,
  FRESHNESS_LABELS,
  freshnessTone,
  incompleteReasonLabel,
  LIFECYCLE_LABELS,
  lifecycleTone,
  platformLabel,
  TARGET_MONITORING_LABEL,
  targetMetricLabel,
  unavailableReasonLabel,
} from "./format";

type Snapshot = PartnerReviewVersionDto["snapshot"];

const EVALUATION_LABELS: Record<string, string> = { met: "Met", below_requirement: "Below requirement", exceeded: "Exceeded", unavailable: "Unavailable", not_met: "Not met" };

export const FRESHNESS_EXPLANATIONS: Record<PartnerReviewFreshnessState, string> = {
  current: "This version matches the current upstream evidence.",
  refresh_available: "Upstream evidence changed after this version was captured. Refresh the evidence to bring this version up to date.",
  revision_available: "Upstream evidence changed after this version was finalized. The finalized version is unchanged; create a revision to capture the new evidence.",
  revision_in_progress: "Upstream evidence changed after this version was finalized, and a revision is already open.",
  evidence_incomplete: "This version matches upstream, but the evidence is incomplete (see the reasons below).",
  superseded: "A later version replaced this one. It stays readable and is never compared with current evidence.",
};

function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <b>{children}</b>
    </div>
  );
}

function Unavailable({ reason }: { reason?: string | null }) {
  return (
    <span>
      Unavailable
      {reason && <small style={{ display: "block", fontWeight: 400 }}>{reason}</small>}
    </span>
  );
}

function yesNoUnknown(value: boolean | null): string {
  return value === null ? "Unknown" : value ? "Yes" : "No";
}

// ---- Overview -----------------------------------------------------------------------------------------
export function OverviewSection({ detail, freshnessState }: { detail: PartnerReviewDetailDto; freshnessState: PartnerReviewFreshnessState | null }) {
  const version = detail.selectedVersion;
  if (!version) return <NoVersion />;
  const snapshot = version.snapshot;
  const summary = computeReviewListSummary(snapshot);
  const supersededBy = version.status === "SUPERSEDED" ? version.supersededByVersion : null;
  const counts = snapshot.completeness.counts;
  const withheld = version.withheldSourceCounts;
  const withheldTotal = withheld.assignment + withheld.content + withheld.analyticsSourceRecord + withheld.campaign;
  const platforms = Object.entries(summary.performance.perPlatform);

  return (
    <>
      <PanelGrid>
        <Panel span={8}>
          <PanelHead title="Review status" description="Lifecycle, freshness and evidence completeness for this version" />
          <PanelBody>
            <Kv label="Lifecycle">
              <Pill tone={lifecycleTone(version.status)}>{LIFECYCLE_LABELS[version.status]}</Pill>
              {supersededBy !== null && <small style={{ display: "block", fontWeight: 400 }}>Superseded by version {supersededBy}</small>}
            </Kv>
            <Kv label="Version">
              Version {version.version} of {detail.head.latestVersion}
              {detail.head.currentFinalizedVersion === version.version && <small style={{ display: "block", fontWeight: 400 }}>Current finalized version</small>}
            </Kv>
            <Kv label="Freshness">
              {freshnessState ? <Pill tone={freshnessTone(freshnessState)}>{FRESHNESS_LABELS[freshnessState]}</Pill> : <Unavailable />}
              {freshnessState && <small style={{ display: "block", fontWeight: 400 }}>{FRESHNESS_EXPLANATIONS[freshnessState]}</small>}
            </Kv>
            <Kv label="Evidence cutoff">{absoluteTime(version.evidenceCutoff)}</Kv>
            <Kv label="Evidence completeness">
              {snapshot.completeness.incompleteReasons.length === 0 ? (
                "Complete for the bounded evidence read"
              ) : (
                <>
                  Incomplete
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontWeight: 400 }}>
                    {snapshot.completeness.incompleteReasons.map((code) => (
                      <li key={code}>{incompleteReasonLabel(code)}</li>
                    ))}
                  </ul>
                </>
              )}
            </Kv>
            <Kv label="Generated">{absoluteTime(version.generatedAt)}</Kv>
            {version.lastRefreshedAt && <Kv label="Last refreshed">{absoluteTime(version.lastRefreshedAt)}</Kv>}
            {version.submittedAt && <Kv label="Submitted for review">{absoluteTime(version.submittedAt)}</Kv>}
            {version.finalizedAt && <Kv label="Finalized">{absoluteTime(version.finalizedAt)}</Kv>}
          </PanelBody>
        </Panel>

        <Panel span={4}>
          <PanelHead title="Source coverage" description="Safe summary of the evidence read" />
          <PanelBody>
            <Kv label="Assignments in month">{counts.assignmentsInPeriod}</Kv>
            <Kv label="Content threads found">{counts.threadsFound}</Kv>
            <Kv label="Analytics records in month">{counts.analyticsRecordsInPeriod}</Kv>
            <Kv label="Approved Content without Analytics">{counts.approvedContentWithoutAnalytics}</Kv>
            {withheldTotal > 0 && (
              <p className="foundationnote" style={{ margin: "10px 0 0" }}>
                {withheldTotal} source record{withheldTotal === 1 ? " is" : "s are"} outside your access. Their evidence is included in every count above but shown without identifying details.
              </p>
            )}
          </PanelBody>
        </Panel>
      </PanelGrid>

      <PanelGrid>
        <Panel span={4}>
          <PanelHead title="Production" description="Independent section" />
          <PanelBody>
            <Kv label="Assignments included">{summary.production.assignmentsIncluded}</Kv>
            <Kv label="Content under review">{summary.production.underReviewContent}</Kv>
            <Kv label="Approved Content">{summary.production.approvedContent}</Kv>
            <Kv label="Completed assignments">{summary.production.completedAssignments}</Kv>
          </PanelBody>
        </Panel>
        <Panel span={4}>
          <PanelHead title="Compliance" description="Independent section" />
          <PanelBody>
            <Kv label="On time">{summary.compliance.onTime}</Kv>
            <Kv label="Late">{summary.compliance.late}</Kv>
            <Kv label="Unknown timing">{summary.compliance.unknownTiming}</Kv>
            <Kv label="Revision requests">{summary.compliance.revisionRequests}</Kv>
            <Kv label="Missing or incomplete work">{summary.compliance.missingOrIncompleteWork}</Kv>
          </PanelBody>
        </Panel>
        <Panel span={4}>
          <PanelHead title="Performance" description="Independent section" />
          <PanelBody>
            <Kv label="Evidence">{summary.performance.state === "available" ? `Available · ${summary.performance.recordCount} source record${summary.performance.recordCount === 1 ? "" : "s"}` : <Unavailable reason="No Analytics record is matched to this Partner-month." />}</Kv>
            {platforms.map(([platform, metrics]) => (
              <Kv key={platform} label={platformLabel(platform)}>
                Views {formatCount(metrics.views)} · Engagement {formatCount(metrics.engagement)}
              </Kv>
            ))}
            <Kv label="Reach">
              <Unavailable reason="Not reported by any verified source." />
            </Kv>
          </PanelBody>
        </Panel>
      </PanelGrid>

      <CommercialPanel snapshot={snapshot} />
    </>
  );
}

// ---- Commercial evidence (shared by Overview and Production) ---------------------------------------------------
function CommercialPanel({ snapshot }: { snapshot: Snapshot }) {
  const commercial = snapshot.commercial;
  const governed = commercial.governingAgreement !== null;
  const deliverable = commercial.monthlyDeliverable;
  const lfcSfc = commercial.lfcSfc;

  return (
    <PanelGrid>
      <Panel span={12}>
        <PanelHead title="Monthly commercial evidence" description={governed ? "Evidence supplied by the governing Agreement · no money is calculated here" : "No Agreement governs this Partner-month · no money is calculated here"} />
        <PanelBody>
          <h3 style={{ margin: "0 0 8px" }}>Payment-affecting evidence</h3>
          {governed && commercial.governingAgreement && (
            <Kv label="Governing Agreement">
              {commercial.governingAgreement.agreementRef} · version {commercial.governingAgreement.agreementVersion}
            </Kv>
          )}
          <Kv label="Required qualifying content">{deliverable.requiredCount === null ? <Unavailable reason={unavailableReasonLabel(deliverable.unavailableReason)} /> : deliverable.requiredCount}</Kv>
          <Kv label="Actual qualifying content">{deliverable.actualQualifyingCount === null ? <Unavailable reason="Approved Content evidence only - raw submitted links never count." /> : deliverable.actualQualifyingCount}</Kv>
          <Kv label="Variance and evaluation">
            {deliverable.evaluation === "unavailable" ? (
              <Unavailable />
            ) : (
              <>
                {EVALUATION_LABELS[deliverable.evaluation]}
                {deliverable.variance !== null && ` (${deliverable.variance > 0 ? "+" : ""}${deliverable.variance})`}
              </>
            )}
          </Kv>
          <Kv label="LFC / SFC evidence">
            {lfcSfc.status === "evaluated" ? (
              <>
                LFC {formatCount(lfcSfc.lfcCount)} · SFC {formatCount(lfcSfc.sfcCount)} · Unclassified {formatCount(lfcSfc.unclassifiedCount)}
              </>
            ) : (
              <Unavailable reason={unavailableReasonLabel(lfcSfc.unavailableReason)} />
            )}
          </Kv>
          {(deliverable.affectsPayment || lfcSfc.affectsPayment) && (
            <p style={{ margin: "8px 0 0" }}>
              <Pill tone="orange">{COMMERCIAL_EVIDENCE_LABEL}</Pill>
            </p>
          )}

          <h3 style={{ margin: "18px 0 8px" }}>Warning-only targets</h3>
          <TargetsTable targets={commercial.targets} />
        </PanelBody>
      </Panel>
    </PanelGrid>
  );
}

function TargetsTable({ targets }: { targets: Snapshot["commercial"]["targets"] }) {
  if (targets.length === 0) return <p className="foundationnote">No Agreement target applies to this Partner-month.</p>;
  return (
    <div className="tablewrap">
      <table className="compact">
        <caption className="sr">Agreement targets - warning only</caption>
        <thead>
          <tr>
            <th scope="col">Target</th>
            <th scope="col">Target value</th>
            <th scope="col">Actual</th>
            <th scope="col">Result</th>
            <th scope="col">Provenance</th>
            <th scope="col">Effect</th>
          </tr>
        </thead>
        <tbody>
          {targets.map((target, index) => (
            <tr key={index}>
              <td>{targetMetricLabel(target.metricId)}</td>
              <td>
                {target.targetValue.toLocaleString("en-GB")} <small>{target.unit}</small>
              </td>
              <td>{target.actualValue === null ? <Unavailable /> : target.actualValue.toLocaleString("en-GB")}</td>
              <td>
                <Pill tone={target.evaluation === "met" ? "default" : target.evaluation === "not_met" ? "orange" : "gray"}>{EVALUATION_LABELS[target.evaluation]}</Pill>
                {target.unavailableReason && <small style={{ display: "block" }}>{unavailableReasonLabel(target.unavailableReason)}</small>}
              </td>
              <td>
                {target.provenance.recordsWithMetric} record{target.provenance.recordsWithMetric === 1 ? "" : "s"} with the metric · {target.provenance.recordsMissingMetric} without
              </td>
              <td>{TARGET_MONITORING_LABEL}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Production ----------------------------------------------------------------------------------------------------
export function ProductionSection({ detail }: { detail: PartnerReviewDetailDto }) {
  const version = detail.selectedVersion;
  if (!version) return <NoVersion />;
  const snapshot = version.snapshot;
  const summary = computeReviewListSummary(snapshot);
  const commercial = snapshot.commercial;
  const rows = snapshot.production.assignments;

  return (
    <>
      <PanelGrid>
        <Panel span={12}>
          <PanelHead title="Production evidence" description="Inspectable monthly evidence · never scored" />
          <PanelBody>
            <Kv label="Assignments included">{summary.production.assignmentsIncluded}</Kv>
            <Kv label="Monthly required qualifying content">{commercial.monthlyDeliverable.requiredCount === null ? <Unavailable reason={unavailableReasonLabel(commercial.monthlyDeliverable.unavailableReason)} /> : commercial.monthlyDeliverable.requiredCount}</Kv>
            <Kv label="Actual qualifying content">{commercial.monthlyDeliverable.actualQualifyingCount === null ? <Unavailable reason="Approved Content evidence only - raw submitted links never count." /> : commercial.monthlyDeliverable.actualQualifyingCount}</Kv>
            <Kv label="Content under review">{summary.production.underReviewContent}</Kv>
            <Kv label="Approved Content">{summary.production.approvedContent}</Kv>
            <Kv label="Completed assignments">{summary.production.completedAssignments}</Kv>
            <Kv label="LFC / SFC evidence">
              {commercial.lfcSfc.status === "evaluated" ? (
                <>
                  LFC {formatCount(commercial.lfcSfc.lfcCount)} · SFC {formatCount(commercial.lfcSfc.sfcCount)} · Unclassified {formatCount(commercial.lfcSfc.unclassifiedCount)}
                </>
              ) : (
                <Unavailable reason={unavailableReasonLabel(commercial.lfcSfc.unavailableReason)} />
              )}
            </Kv>
            {(commercial.monthlyDeliverable.affectsPayment || commercial.lfcSfc.affectsPayment) && (
              <p style={{ margin: "8px 0 0" }}>
                <Pill tone="orange">{COMMERCIAL_EVIDENCE_LABEL}</Pill>
              </p>
            )}
          </PanelBody>
        </Panel>
      </PanelGrid>

      <PanelGrid>
        <Panel span={12}>
          <PanelHead title="Included Assignments" description="Assignments whose due date (else created date) falls in this month" />
          <PanelBody>
            {rows.length === 0 ? (
              <p className="foundationnote">No Assignment falls in this month.</p>
            ) : (
              <div className="tablewrap">
                <table className="compact">
                  <caption className="sr">Included Assignments and their Content</caption>
                  <thead>
                    <tr>
                      <th scope="col">Assignment</th>
                      <th scope="col">Campaign</th>
                      <th scope="col">Status</th>
                      <th scope="col">Due</th>
                      <th scope="col">Required</th>
                      <th scope="col">Formats · platforms</th>
                      <th scope="col">Content</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((item, index) => (
                      <tr key={item.itemKey}>
                        <td>
                          Assignment {index + 1}
                          <small style={{ display: "block" }}>Placed by {item.eventDateSource === "dueAt" ? "due date" : "created date"} · {item.eventDate}</small>
                        </td>
                        <td>{item.campaignName ?? <span className="foundationnote">Withheld</span>}</td>
                        <td>{item.status}</td>
                        <td>{item.dueAt ? dateOnly(item.dueAt) : <Unavailable />}</td>
                        <td>{item.requiredCount ?? <Unavailable />}</td>
                        <td>
                          {item.formats.join(", ") || "—"} · {item.platforms.map(platformLabel).join(", ") || "—"}
                        </td>
                        <td>
                          {item.thread ? (
                            <>
                              {item.thread.status} · revision {item.thread.currentRevisionNumber}
                              <small style={{ display: "block" }}>
                                {item.thread.linkCount} submitted link{item.thread.linkCount === 1 ? "" : "s"}
                                {item.thread.status !== "APPROVED" && item.thread.linkCount > 0 && " (not counted until approved)"}
                              </small>
                              {item.thread.links && item.thread.links.length > 0 && (
                                <small style={{ display: "block" }}>
                                  {item.thread.links.map((link) => (
                                    <a key={link.url} href={link.url} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>
                                      {platformLabel(link.platform)} link
                                    </a>
                                  ))}
                                </small>
                              )}
                            </>
                          ) : (
                            <span>No Content thread</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </PanelBody>
        </Panel>
      </PanelGrid>
    </>
  );
}

// ---- Compliance -----------------------------------------------------------------------------------------------------
export function ComplianceSection({ detail }: { detail: PartnerReviewDetailDto }) {
  const version = detail.selectedVersion;
  if (!version) return <NoVersion />;
  const snapshot = version.snapshot;
  const summary = computeReviewListSummary(snapshot);
  const rows = snapshot.compliance.assignments;

  return (
    <>
      <PanelGrid>
        <Panel span={12}>
          <PanelHead title="Compliance evidence" description="Raw and derived facts, each independent · no compliance score · unknown timing is never late" />
          <PanelBody>
            <Kv label="Submitted on time">{summary.compliance.onTime}</Kv>
            <Kv label="Submitted late">{summary.compliance.late}</Kv>
            <Kv label="Unknown timing">{summary.compliance.unknownTiming}</Kv>
            <Kv label="Revision requests">{summary.compliance.revisionRequests}</Kv>
            <Kv label="Missing or incomplete work">{summary.compliance.missingOrIncompleteWork}</Kv>
            <Kv label="Evidence gaps">
              {snapshot.completeness.incompleteReasons.length === 0 ? (
                "None recorded"
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18, fontWeight: 400 }}>
                  {snapshot.completeness.incompleteReasons.map((code) => (
                    <li key={code}>{incompleteReasonLabel(code)}</li>
                  ))}
                </ul>
              )}
            </Kv>
          </PanelBody>
        </Panel>
      </PanelGrid>

      <PanelGrid>
        <Panel span={12}>
          <PanelHead title="Per-Assignment compliance" description="Timing against the recorded due instant, and process evidence" />
          <PanelBody>
            {rows.length === 0 ? (
              <p className="foundationnote">No Assignment falls in this month.</p>
            ) : (
              <div className="tablewrap">
                <table className="compact">
                  <caption className="sr">Per-Assignment compliance evidence</caption>
                  <thead>
                    <tr>
                      <th scope="col">Assignment</th>
                      <th scope="col">Due</th>
                      <th scope="col">First submitted</th>
                      <th scope="col">Submitted before due</th>
                      <th scope="col">Approved</th>
                      <th scope="col">Revision requests</th>
                      <th scope="col">Process evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((item, index) => (
                      <tr key={item.itemKey}>
                        <td>
                          Assignment {index + 1}
                          <small style={{ display: "block" }}>{item.assignmentStatus}</small>
                        </td>
                        <td>{item.dueAt ? dateOnly(item.dueAt) : <Unavailable />}</td>
                        <td>{item.submittedAt ? absoluteTime(item.submittedAt) : "Not submitted"}</td>
                        <td>{yesNoUnknown(item.submittedBeforeDue)}</td>
                        <td>
                          {item.approvedAt ? absoluteTime(item.approvedAt) : "Not approved"}
                          {item.approvedBeforeDue !== null && <small style={{ display: "block" }}>Before due: {yesNoUnknown(item.approvedBeforeDue)}</small>}
                        </td>
                        <td>
                          {item.revisionRequestCount}
                          {!item.revisionRequestCountIsExact && <small style={{ display: "block" }}>At least - not exactly recoverable</small>}
                        </td>
                        <td>
                          {[item.hasNoThread && "No Content thread yet", item.threadOpenWithNoLinks && "Thread open with no links", item.notCompletedPastDue && "Not completed past due"].filter(Boolean).join(" · ") || "No gaps recorded"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </PanelBody>
        </Panel>
      </PanelGrid>
    </>
  );
}

// ---- Performance ----------------------------------------------------------------------------------------------------
// Metrics the accepted registry lists as not available. Ids that name a blended/authenticity score are never
// rendered - this module has no such concept, not even as an "unavailable" label.
const METRIC_LABELS: Record<string, string> = { reach: "Reach", impressions: "Impressions", shares: "Shares", saves: "Saves", watchTimeMinutes: "Watch time", demographics: "Demographics" };

export function PerformanceSection({ detail }: { detail: PartnerReviewDetailDto }) {
  const version = detail.selectedVersion;
  if (!version) return <NoVersion />;
  const snapshot = version.snapshot;
  const summary = computeReviewListSummary(snapshot);
  const platforms = Object.entries(summary.performance.perPlatform);
  const followerRecords = snapshot.performance.records.filter((record) => typeof record.metrics.profileFollowers === "number");
  const unavailableMetrics = snapshot.performance.unavailableMetrics.filter((metric) => !/score/i.test(metric));

  return (
    <>
      <PanelGrid>
        <Panel span={12}>
          <PanelHead title="Performance evidence" description="Verified Analytics-backed facts only · native platform measures are never blended · no performance score" />
          <PanelBody>
            <Kv label="Evidence">{summary.performance.state === "available" ? `Available · ${summary.performance.recordCount} source record${summary.performance.recordCount === 1 ? "" : "s"} in this month` : <Unavailable reason="No Analytics record is matched to this Partner-month. Missing is not zero and not a failure." />}</Kv>
            {snapshot.performance.latestImportedAt && <Kv label="Latest import">{absoluteTime(snapshot.performance.latestImportedAt)}</Kv>}

            {platforms.length > 0 && (
              <div className="tablewrap" style={{ marginTop: 12 }}>
                <table className="compact">
                  <caption className="sr">Source-reported metrics by platform</caption>
                  <thead>
                    <tr>
                      <th scope="col">Platform</th>
                      <th scope="col">Views</th>
                      <th scope="col">Engagement (source-reported)</th>
                      <th scope="col">Likes</th>
                      <th scope="col">Comments</th>
                    </tr>
                  </thead>
                  <tbody>
                    {platforms.map(([platform, metrics]) => (
                      <tr key={platform}>
                        <td>{platformLabel(platform)}</td>
                        <td>{metrics.views === null ? <Unavailable /> : metrics.views.toLocaleString("en-GB")}</td>
                        <td>{metrics.engagement === null ? <Unavailable /> : metrics.engagement.toLocaleString("en-GB")}</td>
                        <td>{metrics.likes === null ? <Unavailable /> : metrics.likes.toLocaleString("en-GB")}</td>
                        <td>{metrics.comments === null ? <Unavailable /> : metrics.comments.toLocaleString("en-GB")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="foundationnote" style={{ margin: "8px 0 0" }}>
              Each platform is its own row: Instagram and YouTube measures are native counts and are never combined. A metric no record reported reads Unavailable, never zero.
            </p>
          </PanelBody>
        </Panel>
      </PanelGrid>

      <PanelGrid>
        <Panel span={6}>
          <PanelHead title="Profile-follower snapshots" description="Point-in-time values per record · never summed · one snapshot is not growth" />
          <PanelBody>
            {followerRecords.length === 0 ? (
              <p className="foundationnote">
                <b>Unavailable</b> - no follower snapshot was reported in this month. Follower growth needs at least two comparable verified snapshots.
              </p>
            ) : (
              <div className="tablewrap">
                <table className="compact">
                  <caption className="sr">Profile-follower snapshots by source record</caption>
                  <thead>
                    <tr>
                      <th scope="col">Platform</th>
                      <th scope="col">Reporting period</th>
                      <th scope="col">Followers (snapshot)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {followerRecords.map((record) => (
                      <tr key={record.itemKey}>
                        <td>{platformLabel(record.platform)}</td>
                        <td>
                          {record.reportingPeriod.start} – {record.reportingPeriod.end}
                        </td>
                        <td>{(record.metrics.profileFollowers as number).toLocaleString("en-GB")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {followerRecords.length === 1 && <p className="foundationnote">A single snapshot is a point in time, not growth.</p>}
          </PanelBody>
        </Panel>

        <Panel span={6}>
          <PanelHead title="Metric coverage" description="How many source records reported each measure" />
          <PanelBody>
            {snapshot.performance.metricPresence.length === 0 || summary.performance.state === "missing" ? (
              <p className="foundationnote">No source records, so no coverage to report.</p>
            ) : (
              snapshot.performance.metricPresence.map((entry) => (
                <Kv key={entry.metric} label={targetMetricLabel(entry.metric)}>
                  {entry.presentCount} reported · {entry.missingCount} not reported
                </Kv>
              ))
            )}
            {unavailableMetrics.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <b style={{ fontSize: 12 }}>Not available from any verified source</b>
                <p className="foundationnote" style={{ margin: "4px 0 0" }}>
                  {unavailableMetrics.map((metric) => METRIC_LABELS[metric] ?? metric).join(" · ")} - Unavailable, never estimated.
                </p>
              </div>
            )}
          </PanelBody>
        </Panel>
      </PanelGrid>

      <PanelGrid>
        <Panel span={12}>
          <PanelHead title="Agreement targets" description="Warning-only · a missed or unavailable target never changes payment-affecting evidence" />
          <PanelBody>
            <TargetsTable targets={snapshot.commercial.targets} />
          </PanelBody>
        </Panel>
      </PanelGrid>
    </>
  );
}

// ---- Version History --------------------------------------------------------------------------------------------------
export function VersionHistorySection({
  detail,
  freshnessState,
  viewingVersion,
  busy,
  onViewVersion,
}: {
  detail: PartnerReviewDetailDto;
  freshnessState: PartnerReviewFreshnessState | null;
  viewingVersion: number | null;
  busy: boolean;
  onViewVersion: (version: number) => void;
}) {
  const { head, versions } = detail;
  const highest = versions.reduce((max, entry) => Math.max(max, entry.version), 0);

  return (
    <PanelGrid>
      <Panel span={12}>
        <PanelHead title="Version History" description="Every version, newest first · finalized and superseded versions are immutable and stay readable" />
        <PanelBody>
          <div className="tablewrap">
            <table className="compact">
              <caption className="sr">Review versions</caption>
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Status</th>
                  <th scope="col">Evidence cutoff</th>
                  <th scope="col">Generated</th>
                  <th scope="col">Submitted</th>
                  <th scope="col">Finalized</th>
                  <th scope="col">Review version status</th>
                  <th scope="col">
                    <span className="sr">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {versions.map((entry) => (
                  <VersionRow key={entry.version} entry={entry} isCurrentFinalized={head.currentFinalizedVersion === entry.version} isOpen={head.openVersion === entry.version} isNewest={entry.version === highest} freshnessState={viewingVersion === entry.version ? freshnessState : null} viewing={viewingVersion === entry.version} busy={busy} onView={() => onViewVersion(entry.version)} />
                ))}
              </tbody>
            </table>
          </div>
          {detail.hasMoreVersions && <p className="foundationnote">Showing the newest {versions.length} versions.</p>}
          <p className="foundationnote" style={{ margin: "8px 0 0" }}>
            Timestamps are shown for each step; actor identities are not part of this view.
          </p>
        </PanelBody>
      </Panel>
    </PanelGrid>
  );
}

function VersionRow({ entry, isCurrentFinalized, isOpen, isNewest, freshnessState, viewing, busy, onView }: { entry: PartnerReviewVersionSummaryDto; isCurrentFinalized: boolean; isOpen: boolean; isNewest: boolean; freshnessState: PartnerReviewFreshnessState | null; viewing: boolean; busy: boolean; onView: () => void }) {
  const status = (PARTNER_REVIEW_STATUSES as readonly string[]).includes(entry.status) ? entry.status : "DRAFT";
  return (
    <tr>
      <td>
        <b>Version {entry.version}</b>
        {isNewest && <small style={{ display: "block" }}>Newest</small>}
      </td>
      <td>
        <Pill tone={lifecycleTone(status as PartnerReviewVersionSummaryDto["status"])}>{LIFECYCLE_LABELS[status as PartnerReviewVersionSummaryDto["status"]]}</Pill>
        {entry.status === "SUPERSEDED" && entry.supersededByVersion !== null && <small style={{ display: "block" }}>Superseded by version {entry.supersededByVersion}</small>}
        {isCurrentFinalized && <small style={{ display: "block" }}>Current finalized version</small>}
        {isOpen && <small style={{ display: "block" }}>Open version</small>}
      </td>
      <td>{absoluteTime(entry.evidenceCutoff)}</td>
      <td>{absoluteTime(entry.generatedAt)}</td>
      <td>{entry.submittedAt ? absoluteTime(entry.submittedAt) : "—"}</td>
      <td>
        {entry.finalizedAt ? absoluteTime(entry.finalizedAt) : "—"}
        {entry.supersededAt && <small style={{ display: "block" }}>Superseded {dateOnly(entry.supersededAt)}</small>}
      </td>
      <td>
        {entry.status === "SUPERSEDED" ? (
          <Pill tone="gray">Historical · not compared</Pill>
        ) : freshnessState ? (
          <Pill tone={freshnessTone(freshnessState)}>{FRESHNESS_LABELS[freshnessState]}</Pill>
        ) : (
          <span className="foundationnote">Open the version to check</span>
        )}
      </td>
      <td>
        {viewing ? (
          <span className="foundationnote">Viewing</span>
        ) : (
          <button type="button" className="btn" disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} onClick={onView} aria-label={`View version ${entry.version}`}>
            View version
          </button>
        )}
      </td>
    </tr>
  );
}

function NoVersion() {
  return (
    <PanelGrid>
      <Panel span={12}>
        <PanelBody>
          <p className="foundationnote">This version could not be loaded.</p>
        </PanelBody>
      </Panel>
    </PanelGrid>
  );
}

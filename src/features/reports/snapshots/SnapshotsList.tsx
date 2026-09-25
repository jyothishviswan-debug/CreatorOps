import Link from "next/link";

import { EmptyState } from "@/ui/States";
import type { ReportDefinitionDto, ReportSnapshotDoc } from "@/server/reports";

import { formatDateTime } from "../copy";

export type SnapshotsListProps = {
  snapshots: ReportSnapshotDoc[];
  definitions: ReportDefinitionDto[];
};

// Step 19B section 15: the acting user's OWN finalized report snapshot history - listMyFinalizedSnapshots
// is already scoped to the calling actor only (see snapshot-service.ts), so this list is titled and
// worded as "yours", never "all finalized reports".
export function SnapshotsList({ snapshots, definitions }: SnapshotsListProps) {
  const titleByReportId = new Map(definitions.map((d) => [d.reportId, d.title]));

  if (snapshots.length === 0) {
    return (
      <section className="panel">
        <EmptyState title="No finalized reports yet" description="Run a report and choose Finalize as snapshot to keep an immutable copy here." icon="file" />
      </section>
    );
  }

  return (
    <section className="panel" data-testid="snapshots-panel">
      <div className="panelhead">
        <div>
          <h2>Your finalized reports</h2>
          <p>Immutable snapshots you finalized - visible only to you.</p>
        </div>
      </div>
      <div className="tablewrap" data-testid="snapshots-table">
        <table>
          <caption className="sr">Your finalized report snapshots</caption>
          <thead>
            <tr>
              <th scope="col">Report</th>
              <th scope="col">Finalized</th>
              <th scope="col">Evidence cutoff</th>
              <th scope="col">Rows</th>
              <th scope="col">
                <span className="sr">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {snapshots.map((snap) => (
              <tr key={snap.snapshotRef} data-testid="snapshot-row" data-snapshot-ref={snap.snapshotRef}>
                <td>
                  <b>{titleByReportId.get(snap.reportId) ?? snap.reportId}</b>
                  <small style={{ display: "block" }}>{snap.snapshotRef}</small>
                </td>
                <td>{formatDateTime(snap.createdAt)}</td>
                <td>{formatDateTime(snap.evidenceCutoff)}</td>
                <td>
                  {snap.rowCount} of max {snap.maxRows}
                  {snap.truncated ? " (truncated)" : ""}
                </td>
                <td>
                  <Link className="btn" href={`/reports/snapshots/${encodeURIComponent(snap.snapshotRef)}`} data-testid="open-snapshot">
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

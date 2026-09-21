"use client";

import { Panel, PanelBody, PanelGrid, PanelHead } from "@/ui/Panel";

import { StatusChip } from "../components";
import { DISABLED_BUTTON_STYLE } from "../format";
import type { TabContext } from "./detail-types";
import { ActorNote } from "./TermRows";
import { buildVersionRows } from "./versions-view";

// Every version of the Agreement, newest first. Versions are immutable once confirmed: a superseded or ended version stays listed and
// readable exactly as it was frozen. Viewing one only changes what the Terms and Verification tabs show; it never edits anything.
export function VersionsTab({ ctx, busy, onView }: { ctx: TabContext; busy: boolean; onView: (version: number) => void }) {
  const { head, versions, hasMoreVersions, viewNumber } = ctx;
  const rows = buildVersionRows(versions, head, viewNumber);

  return (
    <PanelGrid>
      <Panel span={12}>
        <PanelHead title="Versions" description="Immutable history · a replacement never edits an earlier version" />
        <PanelBody>
          <div className="tablewrap">
            <table className="compact">
              <caption className="sr">Agreement versions</caption>
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Status</th>
                  <th scope="col">Effective period</th>
                  <th scope="col">Confirmed</th>
                  <th scope="col">Activated</th>
                  <th scope="col">Source</th>
                  <th scope="col">State</th>
                  <th scope="col">
                    <span className="sr">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.version} data-testid={`version-row-${row.version}`} aria-current={row.isViewing ? "true" : undefined}>
                    <td>
                      <b>Version {row.version}</b>
                    </td>
                    <td>
                      <StatusChip chip={row.status} />
                    </td>
                    <td>{row.effectivePeriod}</td>
                    <td>
                      {row.confirmedAt}
                      <ActorNote actorRef={row.confirmedBy} />
                    </td>
                    <td>
                      {row.activatedAt}
                      <ActorNote actorRef={row.activatedBy} />
                    </td>
                    <td>{row.sourceMode}</td>
                    <td>{row.roleText}</td>
                    <td>
                      {row.isViewing ? (
                        <span className="pill gray">Viewing</span>
                      ) : (
                        <button type="button" className="btn" aria-label={`View version ${row.version}`} disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} onClick={() => onView(row.version)}>
                          View
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMoreVersions && <p className="foundationnote">Showing the newest {versions.length} versions.</p>}
          <p className="foundationnote" style={{ margin: "8px 0 0" }}>
            The version in force stays current until a replacement is activated. Activating a replacement marks the earlier version Superseded; it remains readable.
          </p>
        </PanelBody>
      </Panel>
    </PanelGrid>
  );
}

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";

import { StatusChip } from "../components";
import { groupChangesBySection, type RevisionChanges } from "./revision-changes";
import { ROW_HEADER_STYLE } from "./styles";

// The changed-field indicators of a revision (or of a version that replaced an earlier one): every field whose value differs from the prior
// confirmed version, with both values side by side. The prior version stays in force and readable; nothing here changes it.
export function RevisionChangesPanel({ revision, version, span = 12 }: { revision: RevisionChanges; version: number; span?: 4 | 6 | 8 | 12 }) {
  const groups = groupChangesBySection(revision.changes);
  const draft = revision.basis === "draft";
  return (
    <Panel span={span}>
      <PanelHead
        title={draft ? `Changes in draft version ${version}` : `Changes in version ${version}`}
        description={`Compared with version ${revision.priorVersion}${draft ? " · decided fields only" : ""}`}
      />
      <PanelBody>
        {draft && (
          <p className="foundationnote" style={{ margin: "0 0 10px" }}>
            Version {revision.priorVersion} stays in force until this revision is confirmed and activated. It remains readable afterwards.
            {revision.pendingCount > 0 ? ` ${revision.pendingCount} proposed value${revision.pendingCount === 1 ? " still needs" : "s still need"} a decision and ${revision.pendingCount === 1 ? "is" : "are"} not counted as changes.` : ""}
          </p>
        )}
        {revision.changes.length === 0 ? (
          <p className="detailcopy" role="status">
            {draft ? "No field has been changed yet." : `No field differs from version ${revision.priorVersion}.`}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.section} style={{ marginBottom: 12 }}>
              <div className="tablewrap">
                <table className="compact">
                  <caption className="sr">{group.label}: changed fields</caption>
                  <thead>
                    <tr>
                      <th scope="col">{group.label}</th>
                      <th scope="col">Version {revision.priorVersion}</th>
                      <th scope="col">{draft ? "This revision" : `Version ${version}`}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.changes.map((change) => (
                      <tr key={change.fieldKey}>
                        <th scope="row" style={ROW_HEADER_STYLE}>
                          {change.label} <StatusChip label="Changed" tone="blue" />
                        </th>
                        <td style={{ overflowWrap: "anywhere" }}>{change.beforeText}</td>
                        <td style={{ overflowWrap: "anywhere" }}>
                          <b>{change.afterText}</b>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </PanelBody>
    </Panel>
  );
}

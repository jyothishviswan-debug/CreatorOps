"use client";

import Link from "next/link";

import { Panel, PanelBody, PanelGrid, PanelHead } from "@/ui/Panel";
import { EmptyState } from "@/ui/States";

import { KeyValueRow, StatusChip } from "../components";
import { TARGET_MONITORING_LABEL, versionStatusChip } from "../format";
import { intakeHref } from "./detail-model";
import type { TabContext } from "./detail-types";
import { RevisionChangesPanel } from "./RevisionChangesPanel";
import { buildTermsView } from "./terms-view";
import { TermRows } from "./TermRows";

// CONFIRMED structured terms only. A draft has none (its working values live in the intake form), so it never shows guessed terms here.
// Two separate groups: the payment-affecting terms, and the warning-only performance targets.
export function TermsTab({ ctx }: { ctx: TabContext }) {
  const { head, viewed, viewedDoc, revision, permissions } = ctx;
  if (!viewed) return <EmptyPanel title="Version not found" description="This Agreement has no such version." />;
  if (!viewedDoc) return <EmptyPanel title="Loading version" description="The details of this version are being loaded." />;

  const terms = viewedDoc.terms;
  if (terms === null) {
    return (
      <PanelGrid>
        <Panel span={12}>
          <PanelBody>
            <EmptyState
              title={`Version ${viewed.version} has no confirmed terms yet`}
              description="Terms are shown here after the version is confirmed. Until then the working values are edited in the intake form."
              icon="file"
              action={
                permissions.canManage && head.openVersion === viewed.version ? (
                  <Link className="btn" href={intakeHref(head.agreementRef, viewed.version)}>
                    Continue draft
                  </Link>
                ) : undefined
              }
            />
          </PanelBody>
        </Panel>
      </PanelGrid>
    );
  }

  const view = buildTermsView(terms, viewedDoc.contactSnapshot);
  const changes = revision ? new Map(revision.changes.map((change) => [change.fieldKey, change])) : null;
  const priorVersion = revision?.priorVersion ?? null;
  const isCurrent = viewed.version === head.activeVersion;
  const historical = !isCurrent && head.openVersion !== viewed.version;

  return (
    <>
      <div className="banner" role="status" style={{ marginBottom: 12 }}>
        <span>
          <b>Version {viewed.version}</b> · <StatusChip chip={versionStatusChip(viewed)} />{" "}
          {isCurrent ? "This is the version in force." : historical ? "Read-only history: this version never changes, even if the Partner or Vendor record changes later." : "Confirmed and waiting to be activated. It becomes the version in force when activated."}
        </span>
      </div>

      {revision && <PanelGrid><RevisionChangesPanel revision={revision} version={viewed.version} /></PanelGrid>}

      <PanelGrid>
        <Panel span={6}>
          <PanelHead title="Payment-affecting terms" description="These terms can change what is owed" />
          <PanelBody>
            <TermRows rows={view.commercial} changes={changes} priorVersion={priorVersion} />
            {view.slabs.length > 0 && (
              <div className="tablewrap" style={{ marginTop: 12 }}>
                <table className="compact">
                  <caption className="sr">Incentive slabs</caption>
                  <thead>
                    <tr>
                      <th scope="col">Metric</th>
                      <th scope="col">Range</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.slabs.map((slab) => (
                      <tr key={slab.slabRef}>
                        <td>{slab.metric}</td>
                        <td>{slab.range}</td>
                        <td>{slab.amount}</td>
                        <td style={{ overflowWrap: "anywhere" }}>{slab.description ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {view.lfcSfc.length > 0 && (
              <div className="tablewrap" style={{ marginTop: 12 }}>
                <table className="compact">
                  <caption className="sr">LFC / SFC rule by format</caption>
                  <thead>
                    <tr>
                      <th scope="col">Format</th>
                      <th scope="col">Rule</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.lfcSfc.map((item) => (
                      <tr key={item.format}>
                        <td style={{ overflowWrap: "anywhere" }}>{item.format}</td>
                        <td>{item.rule}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </PanelBody>
        </Panel>

        <Panel span={6}>
          <PanelHead title="Agreement details" description="Dates, clauses, platform and contact as confirmed" />
          <PanelBody>
            <TermRows rows={view.agreement} changes={changes} priorVersion={priorVersion} />
            <TermRows rows={view.platform} changes={changes} priorVersion={priorVersion} />
            <TermRows rows={view.contact} changes={changes} priorVersion={priorVersion} />
            <TermRows rows={view.admin} changes={changes} priorVersion={priorVersion} />
          </PanelBody>
        </Panel>
      </PanelGrid>

      <PanelGrid>
        <Panel span={12}>
          <PanelHead title="Performance targets" description="Separate from the payment-affecting terms above" />
          <PanelBody>
            {view.targets.length === 0 ? (
              <p className="detailcopy">No performance targets in this version.</p>
            ) : (
              <div className="tablewrap">
                <table className="compact">
                  <caption className="sr">Performance targets (warning only)</caption>
                  <thead>
                    <tr>
                      <th scope="col">Metric</th>
                      <th scope="col">Target</th>
                      <th scope="col">Effect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.targets.map((target) => (
                      <tr key={target.targetRef}>
                        <td>{target.metric}</td>
                        <td>{target.target}</td>
                        <td>
                          <StatusChip label={TARGET_MONITORING_LABEL} tone="gray" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {changes?.has("performanceTargets") && (
              <KeyValueRow label="Change">
                <StatusChip label="Changed" tone="blue" /> <small style={{ fontWeight: 400 }}>Was {changes.get("performanceTargets")!.beforeText} in version {priorVersion}</small>
              </KeyValueRow>
            )}
            <p className="foundationnote" style={{ margin: "10px 0 0" }}>
              Targets are monitored for review only. They never change what is owed.
            </p>
          </PanelBody>
        </Panel>
      </PanelGrid>
    </>
  );
}

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <PanelGrid>
      <Panel span={12}>
        <PanelBody>
          <EmptyState title={title} description={description} icon="file" />
        </PanelBody>
      </Panel>
    </PanelGrid>
  );
}

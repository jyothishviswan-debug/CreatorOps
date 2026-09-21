"use client";

import Link from "next/link";

import { Panel, PanelBody, PanelGrid, PanelHead } from "@/ui/Panel";
import { EmptyState, Skeleton } from "@/ui/States";

import { StatusChip } from "../components";
import { intakeHref } from "./detail-model";
import type { TabContext } from "./detail-types";
import { ActorNote } from "./TermRows";
import { buildComparisonRows, buildProvenanceRows, reconciliationAttentionCount, reconciliationSummaryChips } from "./verification-view";
import { ROW_HEADER_STYLE } from "./styles";

// Field-by-field verification of ONE version:
//   1. what was frozen when it was confirmed (decision, source, provenance) - immutable history;
//   2. how the version compares with CreatorOps master data right now (informational, read-only).
export function VerificationTab({ ctx }: { ctx: TabContext }) {
  const { head, viewed, viewedDoc, reconciliation, reconciliationState, permissions } = ctx;
  if (!viewed) return null;
  const frozen = viewedDoc ? buildProvenanceRows(viewedDoc) : [];
  const isOpenDraft = !viewed.confirmed && head.openVersion === viewed.version;
  const pending = isOpenDraft && viewedDoc ? Object.values(viewedDoc.draft).filter((entry) => entry?.decision === "PENDING").length : 0;
  const comparison = reconciliation ? buildComparisonRows(reconciliation) : [];
  const chips = reconciliation ? reconciliationSummaryChips(reconciliation.summary) : [];
  const attention = reconciliation ? reconciliationAttentionCount(reconciliation.summary) : 0;

  return (
    <>
      <div className="banner" role="status" style={{ marginBottom: 12 }}>
        <span>
          <b>Version {viewed.version}.</b>{" "}
          {viewed.confirmed
            ? "A confirmed version never changes when Partner or Vendor master data changes later. The frozen record below is history; the comparison shows how CreatorOps records look now."
            : "This version is still a draft. Decisions are made in the intake form; this page shows the live comparison."}
        </span>
      </div>

      {isOpenDraft && (
        <PanelGrid>
          <Panel span={12}>
            <PanelHead title="Draft in progress" description="Decisions are made in the intake form" />
            <PanelBody>
              <p className="detailcopy" role="status">
                {pending > 0 ? `${pending} proposed value${pending === 1 ? " needs" : "s need"} a decision.` : "No proposed value is waiting for a decision."}
                {attention > 0 ? ` ${attention} difference${attention === 1 ? "" : "s"} between the Agreement and CreatorOps records ${attention === 1 ? "needs" : "need"} review.` : ""}
              </p>
              {permissions.canManage && (
                <div style={{ marginTop: 12 }}>
                  <Link className="btn" href={intakeHref(head.agreementRef, viewed.version)}>
                    Open in the intake form
                  </Link>
                </div>
              )}
            </PanelBody>
          </Panel>
        </PanelGrid>
      )}

      {viewed.confirmed && (
        <PanelGrid>
          <Panel span={12}>
            <PanelHead title="Frozen at confirmation" description="Who decided what, and where each value came from" />
            <PanelBody>
              {!viewedDoc ? (
                <Skeleton lines={3} />
              ) : frozen.length === 0 ? (
                <p className="detailcopy">No field record was kept for this version.</p>
              ) : (
                <div className="tablewrap">
                  <table className="compact">
                    <caption className="sr">Confirmed fields with their source and decision</caption>
                    <thead>
                      <tr>
                        <th scope="col">Field</th>
                        <th scope="col">Decision</th>
                        <th scope="col">Confirmed value</th>
                        <th scope="col">Source</th>
                        <th scope="col">Decided</th>
                      </tr>
                    </thead>
                    <tbody>
                      {frozen.map((row) => (
                        <tr key={row.fieldKey}>
                          <th scope="row" style={ROW_HEADER_STYLE}>
                            {row.label}
                          </th>
                          <td>
                            <StatusChip chip={row.decision} />
                          </td>
                          <td style={{ overflowWrap: "anywhere" }}>{row.value}</td>
                          <td style={{ overflowWrap: "anywhere" }}>
                            {row.source}
                            <small style={{ display: "block", fontWeight: 400 }}>{row.provenance}</small>
                          </td>
                          <td>
                            {row.decidedAt}
                            <ActorNote actorRef={row.decidedBy} />
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
      )}

      <PanelGrid>
        <Panel span={12}>
          <PanelHead title="Comparison with CreatorOps records" description="Live · informational · never changes this Agreement" />
          <PanelBody>
            {reconciliationState === "loading" && <Skeleton lines={4} />}
            {reconciliationState === "error" && (
              <EmptyState title="Comparison not available" description="The comparison with CreatorOps records could not be loaded. Try again later." icon="alert" />
            )}
            {reconciliationState === "ready" && reconciliation && (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }} role="list" aria-label="Comparison summary">
                  {chips.map((chip) => (
                    <span key={chip.state} role="listitem">
                      <StatusChip label={`${chip.label} ${chip.count}`} tone={chip.tone} />
                    </span>
                  ))}
                </div>
                {!reconciliation.identityCompared && <p className="foundationnote" style={{ margin: "0 0 10px" }}>KYC values are not compared for your access. They are never shown on this page.</p>}
                <div className="tablewrap">
                  <table className="compact">
                    <caption className="sr">Agreement value compared with the CreatorOps value, field by field</caption>
                    <thead>
                      <tr>
                        <th scope="col">Field</th>
                        <th scope="col">CreatorOps value</th>
                        <th scope="col">Agreement value</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.map((row) => (
                        <tr key={row.fieldKey} style={row.highlight ? { background: "var(--tint)" } : undefined}>
                          <th scope="row" style={ROW_HEADER_STYLE}>
                            {row.label}
                          </th>
                          <td style={{ overflowWrap: "anywhere" }}>{row.creatorOpsText}</td>
                          <td style={{ overflowWrap: "anywhere" }}>{row.agreementText}</td>
                          <td>
                            <StatusChip chip={row.stateChip} />
                            {row.reason && <small style={{ display: "block", fontWeight: 400 }}>{row.reason}</small>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </PanelBody>
        </Panel>
      </PanelGrid>
    </>
  );
}

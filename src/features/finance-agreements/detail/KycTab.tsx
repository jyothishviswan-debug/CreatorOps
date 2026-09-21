"use client";

import Link from "next/link";

import { Panel, PanelBody, PanelGrid, PanelHead } from "@/ui/Panel";
import { EmptyState } from "@/ui/States";

import { ChipList, StatusChip } from "../components";
import {
  KYC_AVAILABLE_NOTE,
  counterpartyTypeLabel,
  formatInstant,
  kycComponentChip,
  kycComponentLabel,
  kycStateChip,
  type KycComponentKey,
} from "../format";
import type { TabContext } from "./detail-types";
import { ROW_HEADER_STYLE } from "./styles";

const COMPONENTS: KycComponentKey[] = ["pan", "aadhaar", "gst", "bank"];

const EVIDENCE_LABELS: Record<string, string> = { pan: "PAN document", aadhaar: "Aadhaar document", gst: "GST certificate", bank: "Bank document", other: "Other document" };

// KYC as SAFE STATUS by default: available / missing / incomplete / restricted per document type. No identity value is ever shown on this page
// and none is requested; the values live in the Partner / Vendor record behind its own restricted access. Managing KYC is a link to that
// record, offered only to an actor whose server-computed permissions allow it.
export function KycTab({ ctx }: { ctx: TabContext }) {
  const { head, kycStatus, viewedDoc, permissions } = ctx;
  const type = head.counterparty.type;
  const owner = counterpartyTypeLabel(type);
  const ownerHref = type === "PARTNER" ? `/partners/${encodeURIComponent(head.counterparty.ref)}` : `/vendors/${encodeURIComponent(head.counterparty.ref)}`;
  const snapshot = viewedDoc?.identityStatus ?? null;
  const rows = COMPONENTS.filter((key) => !(key === "aadhaar" && type === "VENDOR"));

  if (!kycStatus) {
    return (
      <PanelGrid>
        <Panel span={12}>
          <PanelBody>
            <EmptyState title="KYC status not available" description="The KYC status could not be loaded right now." icon="alert" />
          </PanelBody>
        </Panel>
      </PanelGrid>
    );
  }

  const detailRestricted = rows.every((key) => kycStatus.components[key] === "RESTRICTED");
  const stateChip = kycStateChip(kycStatus.state);
  const evidence = kycStatus.evidenceTypesPresent ?? [];

  return (
    <>
      <PanelGrid>
        <Panel span={8}>
          <PanelHead title="KYC in the CreatorOps record" description={`Held by the ${owner} record · status only`} />
          <PanelBody>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <StatusChip chip={stateChip} />
              {kycStatus.state === "AVAILABLE" && <span className="foundationnote">{KYC_AVAILABLE_NOTE}</span>}
            </div>
            <div className="tablewrap">
              <table className="compact">
                <caption className="sr">KYC status by document type</caption>
                <thead>
                  <tr>
                    <th scope="col">Document</th>
                    <th scope="col">Status now</th>
                    <th scope="col">At confirmation{viewedDoc?.confirmed ? ` (v${viewedDoc.version})` : ""}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((key) => {
                    const now = kycComponentChip(kycStatus.components[key]);
                    const frozen = snapshot ? kycComponentChip(snapshot.components[key]) : null;
                    return (
                      <tr key={key}>
                        <th scope="row" style={ROW_HEADER_STYLE}>
                          {kycComponentLabel(key)}
                        </th>
                        <td>
                          <StatusChip chip={now} />
                        </td>
                        <td>{frozen ? <StatusChip chip={frozen} /> : <span className="muted">{viewedDoc?.confirmed ? "Not recorded" : "Recorded when confirmed"}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {detailRestricted && <p className="foundationnote" style={{ margin: "10px 0 0" }}>Per-document detail is restricted for your access. Only the overall status is shown.</p>}
            {evidence.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <small className="muted">Evidence on file</small>
                <div>
                  <ChipList items={evidence.map((item) => EVIDENCE_LABELS[item] ?? item)} ariaLabel="Evidence types on file" />
                </div>
              </div>
            )}
            {snapshot?.capturedAt && (
              <p className="foundationnote" style={{ margin: "10px 0 0" }}>
                The confirmed version recorded this status on {formatInstant(snapshot.capturedAt)}. That record never changes; the status now can.
              </p>
            )}
          </PanelBody>
        </Panel>

        <Panel span={4}>
          <PanelHead title="Manage KYC" description="In the owning record" />
          <PanelBody>
            <p className="detailcopy">KYC values are stored once, in the {owner} record. This page never shows or copies them.</p>
            {permissions.canManageCounterpartyKyc ? (
              <div style={{ marginTop: 12 }}>
                <Link className="btn" href={ownerHref}>
                  Open {owner} record
                </Link>
              </div>
            ) : (
              <p className="foundationnote" style={{ margin: "10px 0 0" }}>Managing KYC needs restricted-details access.</p>
            )}
          </PanelBody>
        </Panel>
      </PanelGrid>
    </>
  );
}

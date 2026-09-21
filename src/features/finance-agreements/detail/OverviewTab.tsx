"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";

import { Panel, PanelBody, PanelGrid, PanelHead } from "@/ui/Panel";
import { Skeleton } from "@/ui/States";
import type { ExtractionResultDto } from "@/server/finance-agreements/client-dto";

import { getExtractionResult } from "../api-client";
import { ChipList, KeyValueRow, StatusChip } from "../components";
import {
  EXTRACTION_NOTE,
  KYC_AVAILABLE_NOTE,
  NO_VALUE_TEXT,
  agreementTypeLabel,
  counterpartyTypeLabel,
  extractionStatusChip,
  formatEffectivePeriod,
  formatInstant,
  formatPlatformList,
  formatPlatformName,
  kycComponentChip,
  kycComponentLabel,
  kycStateChip,
  sourceModeLabel,
  versionStatusChip,
  type KycComponentKey,
} from "../format";
import { AgreementDocumentPanel, type AgreementDocumentPanelProps } from "./AgreementDocumentPanel";
import { intakeHref } from "./detail-model";
import type { TabContext } from "./detail-types";
import { RevisionChangesPanel } from "./RevisionChangesPanel";
import { buildCommercialSummary } from "./terms-view";
import { TermRows } from "./TermRows";
import { reconciliationAttentionCount, reconciliationSummaryChips } from "./verification-view";

const COMPONENT_ORDER: KycComponentKey[] = ["pan", "aadhaar", "gst", "bank"];

export function OverviewTab({ ctx, lifecycle, onOpenTab, documentPanel }: { ctx: TabContext; lifecycle: ReactNode; onOpenTab: (tab: "verification" | "kyc" | "terms") => void; documentPanel?: AgreementDocumentPanelProps }) {
  const { head, viewed, viewedDoc, openDoc, openRevision, permissions } = ctx;
  const terms = viewedDoc?.terms ?? null;
  const confirmed = viewed?.confirmed === true && terms !== null;
  const scope = head.counterparty.platformScope;
  const openIsFirstDraft = head.openVersion !== null && openDoc !== null && openRevision === null && head.activeVersion === null && head.lastEndedVersion === null;
  const pendingInFirstDraft = openIsFirstDraft && openDoc.terms === null ? Object.values(openDoc.draft).filter((entry) => entry?.decision === "PENDING").length : 0;

  return (
    <>
      {lifecycle}

      <PanelGrid>
        <Panel span={8}>
          <PanelHead title="Agreement summary" description={viewed ? `Version ${viewed.version}${viewed.version === head.activeVersion ? " · current" : ""}` : undefined} />
          <PanelBody>
            <KeyValueRow label={counterpartyTypeLabel(head.counterparty.type)}>{ctx.counterpartyName}</KeyValueRow>
            {head.counterparty.type === "PARTNER" && (
              <KeyValueRow label="Platform scope">
                <ChipList items={scope.map(formatPlatformName)} emptyText="Not set" ariaLabel="Platform scope" />
              </KeyValueRow>
            )}
            <KeyValueRow label="Agreement number">{terms?.agreementNumber ?? NO_VALUE_TEXT}</KeyValueRow>
            <KeyValueRow label="Effective period">{viewed?.confirmed ? formatEffectivePeriod(viewed.effectiveFrom, viewed.effectiveTo) : "Set when the version is confirmed"}</KeyValueRow>
            <KeyValueRow label="Status">{viewed ? <StatusChip chip={versionStatusChip(viewed)} /> : NO_VALUE_TEXT}</KeyValueRow>
            <KeyValueRow label="Agreement type">{viewed?.agreementType ? agreementTypeLabel(viewed.agreementType) : "Derived when the version is confirmed"}</KeyValueRow>
            <KeyValueRow label="Platforms in terms">{terms ? formatPlatformList(terms.platform.platforms) : NO_VALUE_TEXT}</KeyValueRow>
            <KeyValueRow label="Last updated">{viewed ? formatInstant(viewed.updatedAt) : formatInstant(head.updatedAt)}</KeyValueRow>
          </PanelBody>
        </Panel>

        <Panel span={4}>
          <PanelHead title="KYC readiness" description="Status only" />
          <PanelBody>
            <KycReadiness ctx={ctx} onOpenKyc={() => onOpenTab("kyc")} />
          </PanelBody>
        </Panel>
      </PanelGrid>

      {documentPanel && documentPanel.rows.length > 0 && (
        <PanelGrid>
          <AgreementDocumentPanel {...documentPanel} />
        </PanelGrid>
      )}

      {openRevision && head.openVersion !== null && (
        <PanelGrid>
          <RevisionChangesPanel revision={openRevision} version={head.openVersion} />
        </PanelGrid>
      )}

      {openIsFirstDraft && openDoc && (
        <PanelGrid>
          <Panel span={12}>
            <PanelHead title={`Draft version ${openDoc.version}`} description="Not yet confirmed" />
            <PanelBody>
              <p className="detailcopy" role="status">
                {openDoc.confirmed
                  ? "This version is confirmed and waiting to be activated."
                  : pendingInFirstDraft > 0
                    ? `${pendingInFirstDraft} proposed value${pendingInFirstDraft === 1 ? " needs" : "s need"} a decision. Terms are frozen when the version is confirmed.`
                    : "Terms are frozen when the version is confirmed."}
              </p>
              {permissions.canManage && !openDoc.confirmed && (
                <div style={{ marginTop: 12 }}>
                  <Link className="btn" href={intakeHref(head.agreementRef, openDoc.version)}>
                    Open in the intake form
                  </Link>
                </div>
              )}
            </PanelBody>
          </Panel>
        </PanelGrid>
      )}

      <PanelGrid>
        <Panel span={6}>
          <PanelHead title="Commercial summary" description={confirmed ? "Confirmed terms" : "Shown once the version is confirmed"} />
          <PanelBody>
            {confirmed && terms ? (
              <>
                <TermRows rows={buildCommercialSummary(terms)} changes={ctx.revision ? new Map(ctx.revision.changes.map((change) => [change.fieldKey, change])) : null} priorVersion={ctx.revision?.priorVersion ?? null} />
                <div style={{ marginTop: 12 }}>
                  <button type="button" className="btn" onClick={() => onOpenTab("terms")}>
                    View all terms
                  </button>
                </div>
              </>
            ) : (
              <p className="detailcopy">Payment-affecting terms and performance targets are shown here after the version is confirmed. Nothing is inferred from the draft.</p>
            )}
          </PanelBody>
        </Panel>

        <Panel span={6}>
          <PanelHead title="Source and verification" description="How this version was prepared" />
          <PanelBody>
            <SourceAndVerification ctx={ctx} onOpenVerification={() => onOpenTab("verification")} />
          </PanelBody>
        </Panel>
      </PanelGrid>
    </>
  );
}

function KycReadiness({ ctx, onOpenKyc }: { ctx: TabContext; onOpenKyc: () => void }) {
  const kyc = ctx.kycStatus;
  if (!kyc) return <p className="detailcopy">KYC status is not available right now.</p>;
  const chip = kycStateChip(kyc.state);
  const restricted = COMPONENT_ORDER.every((key) => kyc.components[key] === "RESTRICTED");
  return (
    <>
      <KeyValueRow label="KYC">
        <StatusChip chip={chip} />
      </KeyValueRow>
      {kyc.state === "AVAILABLE" && <p className="foundationnote" style={{ margin: "8px 0" }}>{KYC_AVAILABLE_NOTE}</p>}
      {!restricted && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "8px 0" }}>
          {COMPONENT_ORDER.filter((key) => !(key === "aadhaar" && ctx.head.counterparty.type === "VENDOR")).map((key) => {
            const status = kycComponentChip(kyc.components[key]);
            return <StatusChip key={key} label={`${kycComponentLabel(key)}: ${status.label}`} tone={status.tone} />;
          })}
        </div>
      )}
      {restricted && <p className="foundationnote" style={{ margin: "8px 0" }}>Per-document detail is restricted for your access.</p>}
      <button type="button" className="btn" onClick={onOpenKyc}>
        View KYC
      </button>
    </>
  );
}

function SourceAndVerification({ ctx, onOpenVerification }: { ctx: TabContext; onOpenVerification: () => void }) {
  const { viewed, viewedDoc, reconciliation, reconciliationState } = ctx;
  if (!viewed) return <p className="detailcopy">{NO_VALUE_TEXT}</p>;
  const source = viewedDoc?.source ?? null;
  const chips = reconciliation ? reconciliationSummaryChips(reconciliation.summary) : [];
  const attention = reconciliation ? reconciliationAttentionCount(reconciliation.summary) : 0;
  return (
    <>
      <KeyValueRow label="Source">{sourceModeLabel(viewed.sourceMode)}</KeyValueRow>
      <KeyValueRow label="Signed Agreement">{source ? (source.contractArtifactRef ? "Uploaded" : "None uploaded") : NO_VALUE_TEXT}</KeyValueRow>
      <KeyValueRow label="Extraction">{source?.extractionRunRef ? <ExtractionSummary key={source.extractionRunRef} agreementRef={ctx.head.agreementRef} runRef={source.extractionRunRef} /> : "No extraction attached"}</KeyValueRow>
      <KeyValueRow label="Comparison">
        {reconciliationState === "loading" && <span role="status">Checking CreatorOps records…</span>}
        {reconciliationState === "error" && <span>Comparison is not available right now.</span>}
        {reconciliationState === "ready" && reconciliation && (
          <>
            <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }} role="list" aria-label="Comparison summary">
              {chips.map((chip) => (
                <span key={chip.state} role="listitem">
                  <StatusChip label={`${chip.label} ${chip.count}`} tone={chip.tone} />
                </span>
              ))}
            </span>
            <small style={{ display: "block", fontWeight: 400 }}>{attention > 0 ? `${attention} difference${attention === 1 ? "" : "s"} between the Agreement and CreatorOps records.` : "No differences found."}</small>
          </>
        )}
      </KeyValueRow>
      <div style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={onOpenVerification}>
          View verification
        </button>
      </div>
    </>
  );
}

// The extraction run's completeness (never legal verification), fetched once per run. Ordinary proposals are visible to everyone
// authorized for the Agreement; restricted detail is never requested here.
function ExtractionSummary({ agreementRef, runRef }: { agreementRef: string; runRef: string }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error" } | { status: "ready"; result: ExtractionResultDto }>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void getExtractionResult(agreementRef, { runRef }, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setState(result.ok ? { status: "ready", result: result.data } : { status: "error" });
    });
    return () => controller.abort();
  }, [agreementRef, runRef]);

  if (state.status === "loading") return <Skeleton lines={1} />;
  if (state.status === "error") return <span>Extraction details are not available right now.</span>;
  const chip = extractionStatusChip(state.result.run.status);
  const count = state.result.fields.length;
  return (
    <>
      <StatusChip chip={chip} />
      <small style={{ display: "block", fontWeight: 400 }}>
        {count} proposed value{count === 1 ? "" : "s"} · {EXTRACTION_NOTE}
      </small>
    </>
  );
}

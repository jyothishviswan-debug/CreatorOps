"use client";

import { useState } from "react";
import Link from "next/link";

import { Panel, PanelBody, PanelGrid, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import type { LeadDto } from "@/server/discovery/client-dto";
import type { ReadinessResult } from "@/server/discovery/types";
import { getLeadReadiness } from "./api-client";
import { AlternativeOutcomes } from "./AlternativeOutcomes";
import { absoluteTime, LIFECYCLE_LABELS, lifecycleTone } from "./format";
import { HistoryPanel } from "./HistoryPanel";
import { ConvertedStage, ReadyStage } from "./ReadyConvertedStages";
import { AgreementStage, AssetStage, KycStage, LeadStage, ManagerStage, OutreachStage, ResearchStage, ReviewStage } from "./stages";
import { currentStageKey, isStageDone, STAGES, type StageKey } from "./workflow";

type ReadinessDto = ReadinessResult & { leadRef: string; version: number; lifecycle: LeadDto["lifecycle"] };

export function DiscoveryLeadDetail({ initialLead, initialReadiness }: { initialLead: LeadDto; initialReadiness: ReadinessDto | null }) {
  const [lead, setLead] = useState(initialLead);
  const [readiness, setReadiness] = useState<ReadinessDto | null>(initialReadiness);
  const [selectedStage, setSelectedStage] = useState<StageKey>(() => currentStageKey(initialLead, initialReadiness?.blockers ?? []));
  // Bumped on every successful mutation - leadRef alone never changes
  // across those, so History needs its own explicit refresh signal (see
  // HistoryPanel's own comment).
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  async function refreshReadiness(leadRef: string) {
    const result = await getLeadReadiness(leadRef);
    if (result.ok) setReadiness(result.data);
  }

  function handleLeadUpdated(updated: LeadDto) {
    setLead(updated);
    setHistoryRefreshKey((k) => k + 1);
    void refreshReadiness(updated.leadRef);
  }

  const blockers = readiness?.blockers ?? [];

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">DISCOVERY / RECORD DETAIL</div>
          <h1>{lead.displayName}</h1>
          <p>{lead.platform ?? "No platform on file"}</p>
        </div>
        <div className="actions">
          <Link href="/discovery/leads" className="btn">
            Back to workspace
          </Link>
          <Link href={`/discovery/${lead.leadRef}/edit`} className="btn primary">
            Edit lead
          </Link>
        </div>
      </div>

      <div className="detailcontext">
        <div>
          <small>Lifecycle</small>
          <Pill tone={lifecycleTone(lead.lifecycle)}>{LIFECYCLE_LABELS[lead.lifecycle]}</Pill>
        </div>
        <div>
          <small>Owner</small>
          <b>{lead.ownerDisplayName ?? "Unassigned"}</b>
        </div>
        <div>
          <small>Region</small>
          <b>{lead.region ?? "—"}</b>
        </div>
        <div>
          <small>Last updated</small>
          <b>{absoluteTime(lead.updatedAt)}</b>
        </div>
      </div>

      <div className="workflow" role="tablist" aria-label="Discovery workflow">
        {STAGES.map((stage, i) => {
          const done = isStageDone(stage.key, lead, blockers);
          const isCurrent = stage.key === selectedStage;
          return (
            <button
              key={stage.key}
              type="button"
              role="tab"
              aria-selected={isCurrent}
              className={`step ${done ? "done" : ""} ${isCurrent ? "current" : ""}`}
              onClick={() => setSelectedStage(stage.key)}
            >
              <i>{done ? "✓" : i + 1}</i>
              {stage.label}
            </button>
          );
        })}
      </div>

      {/* Manager pairs with Alternative Outcomes as a 1x2 row on this
          tab specifically; Restricted KYC gets its own full-width
          section right below (its form needs the full width) - every
          other stage keeps Alternative Outcomes as its own full-width
          panel below instead (see the else branch). */}
      {selectedStage === "manager" ? (
        <>
          <PanelGrid>
            <Panel span={6}>
              <PanelHead title="Manager" description={stageDescription(selectedStage, lead, blockers)} />
              <PanelBody>
                <ManagerStage lead={lead} onSaved={handleLeadUpdated} />
              </PanelBody>
            </Panel>
            <AlternativeOutcomes lead={lead} onSaved={handleLeadUpdated} span={6} />
          </PanelGrid>
          <PanelGrid>
            <Panel span={12}>
              <PanelHead title="Restricted KYC" description="Gated by the discovery_kyc sensitive-access category." />
              <PanelBody>
                <KycStage lead={lead} onSaved={handleLeadUpdated} />
              </PanelBody>
            </Panel>
          </PanelGrid>
        </>
      ) : (
        <>
          <PanelGrid>
            <Panel span={12}>
              <PanelHead title={STAGES.find((s) => s.key === selectedStage)!.label} description={stageDescription(selectedStage, lead, blockers)} />
              <PanelBody>
                <StageBody stageKey={selectedStage} lead={lead} readiness={readiness} onSaved={handleLeadUpdated} />
              </PanelBody>
            </Panel>
          </PanelGrid>

          <PanelGrid>
            <AlternativeOutcomes lead={lead} onSaved={handleLeadUpdated} />
          </PanelGrid>
        </>
      )}

      <PanelGrid>
        <HistoryPanel leadRef={lead.leadRef} refreshKey={historyRefreshKey} />
      </PanelGrid>
    </>
  );
}

function stageDescription(stageKey: StageKey, lead: LeadDto, blockers: ReadinessResult["blockers"]): string {
  return isStageDone(stageKey, lead, blockers)
    ? "Saved evidence for this stage - update it below at any time."
    : stageKey === currentStageKey(lead, blockers)
      ? "This is the next stage to complete."
      : "You can still review or prepare this stage ahead of time.";
}

function StageBody({ stageKey, lead, readiness, onSaved }: { stageKey: StageKey; lead: LeadDto; readiness: ReadinessDto | null; onSaved: (lead: LeadDto) => void }) {
  switch (stageKey) {
    case "lead":
      return <LeadStage lead={lead} onSaved={onSaved} />;
    case "research":
      return <ResearchStage lead={lead} onSaved={onSaved} />;
    case "review":
      return <ReviewStage lead={lead} onSaved={onSaved} />;
    case "outreach":
      return <OutreachStage lead={lead} onSaved={onSaved} />;
    case "agreement":
      return <AgreementStage lead={lead} onSaved={onSaved} />;
    case "asset":
      return <AssetStage lead={lead} onSaved={onSaved} />;
    case "manager":
      return <ManagerStage lead={lead} onSaved={onSaved} />;
    case "ready":
      return <ReadyStage lead={lead} readiness={readiness} onSaved={onSaved} />;
    case "converted":
      return <ConvertedStage lead={lead} />;
  }
}

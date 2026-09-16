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
import { AgreementStage, AssetStage, LeadStage, ManagerKycStage, OutreachStage, ResearchStage, ReviewStage } from "./stages";
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

      <PanelGrid>
        <Panel span={12}>
          <PanelHead
            title={STAGES.find((s) => s.key === selectedStage)!.label}
            description={
              isStageDone(selectedStage, lead, blockers)
                ? "Saved evidence for this stage - update it below at any time."
                : selectedStage === currentStageKey(lead, blockers)
                  ? "This is the next stage to complete."
                  : "You can still review or prepare this stage ahead of time."
            }
          />
          <PanelBody>
            <StageBody stageKey={selectedStage} lead={lead} readiness={readiness} onSaved={handleLeadUpdated} />
          </PanelBody>
        </Panel>
      </PanelGrid>

      <PanelGrid>
        <AlternativeOutcomes lead={lead} onSaved={handleLeadUpdated} />
      </PanelGrid>

      <PanelGrid>
        <HistoryPanel leadRef={lead.leadRef} refreshKey={historyRefreshKey} />
      </PanelGrid>
    </>
  );
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
      return <ManagerKycStage lead={lead} onSaved={onSaved} />;
    case "ready":
      return <ReadyStage lead={lead} readiness={readiness} onSaved={onSaved} />;
    case "converted":
      return <ConvertedStage lead={lead} />;
  }
}

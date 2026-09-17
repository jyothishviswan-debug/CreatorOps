"use client";

import { useEffect, useState } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import type { CampaignReadinessResult } from "@/server/campaigns/types";
import { getCampaignReadiness } from "./api-client";

// The real readiness endpoint, called fresh every time this panel
// mounts (or refreshKey changes) - never a duplicated client-side
// reimplementation of the rules (Step 9B section 7's own explicit
// instruction). DRAFT -> PLANNED itself re-runs this exact same server
// function; this panel is purely informational, not a gate.
export function CampaignReadinessPanel({ campaignRef, refreshKey }: { campaignRef: string; refreshKey: number }) {
  const [readiness, setReadiness] = useState<CampaignReadinessResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCampaignReadiness(campaignRef).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setReadiness(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [campaignRef, refreshKey]);

  return (
    <Panel span={12}>
      <PanelHead title="Readiness" description="Recomputed live from this Campaign's own recorded state - the same check DRAFT -> PLANNED itself runs." />
      <PanelBody>
        {loading ? (
          <p className="foundationnote">Checking…</p>
        ) : error ? (
          <div className="banner" role="alert">
            {error}
          </div>
        ) : readiness ? (
          <>
            <p className={readiness.ready ? "foundationnote" : ""}>
              {readiness.ready ? "Ready to plan." : `${readiness.blockers.length} blocker${readiness.blockers.length === 1 ? "" : "s"} remaining.`}
            </p>
            {readiness.blockers.length > 0 && (
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {readiness.blockers.map((b) => (
                  <li key={b.code}>{b.message}</li>
                ))}
              </ul>
            )}
            {readiness.warnings.length > 0 && (
              <ul style={{ margin: "10px 0 0", paddingLeft: 18, color: "var(--muted)" }}>
                {readiness.warnings.map((w) => (
                  <li key={w.code}>{w.message}</li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

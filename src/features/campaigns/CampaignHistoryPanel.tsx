"use client";

import { useEffect, useState } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { EmptyState } from "@/ui/States";
import type { CampaignHistoryEventDto } from "@/server/campaigns/campaign-service";
import { getCampaignHistory } from "./api-client";
import { absoluteTime, eventLabel } from "./format";

// Append-only Campaign event/audit history - read-only, never an
// editable timeline. Events are already redacted server-side (see
// campaign-events.ts); no future Agreement/financial value ever reaches
// this panel. Mirrors Vendors'/Partners' own HistoryPanel exactly.
export function CampaignHistoryPanel({ campaignRef, refreshKey }: { campaignRef: string; refreshKey: number }) {
  const [events, setEvents] = useState<CampaignHistoryEventDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCampaignHistory(campaignRef, { limit: 20 }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEvents(result.data.events);
    });
    return () => {
      cancelled = true;
    };
  }, [campaignRef, refreshKey]);

  return (
    <Panel span={12}>
      <PanelHead title="History / activity" description="Append-only Campaign event history - plan, ownership, lifecycle and resource changes." />
      <PanelBody>
        {loading ? (
          <p className="foundationnote">Loading…</p>
        ) : error ? (
          <div className="banner" role="alert">
            {error}
          </div>
        ) : events.length === 0 ? (
          <EmptyState title="No activity yet" icon="clock" />
        ) : (
          events.map((event) => (
            <div className="activity" key={event.id}>
              <span className="eventdot" />
              <div>
                <b>{eventLabel(event.kind)}</b>
                <small>
                  {absoluteTime(event.createdAt)} · {event.actorDisplayName ?? "Unknown actor"}
                </small>
              </div>
            </div>
          ))
        )}
      </PanelBody>
    </Panel>
  );
}

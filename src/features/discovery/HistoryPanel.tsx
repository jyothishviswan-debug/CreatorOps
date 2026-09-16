"use client";

import { useEffect, useState } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { EmptyState } from "@/ui/States";
import type { LeadEvent } from "@/server/discovery/types";
import { getLeadHistory } from "./api-client";
import { absoluteTime, eventLabel } from "./format";

// Append-only Discovery event history - read-only, never an editable
// timeline. Events are already redacted server-side (see
// lead-events.ts); nothing restricted ever reaches this panel.
//
// `refreshKey` is bumped by the parent every time a mutation succeeds
// (evidence saved, lifecycle changed, converted, ...) - leadRef alone
// never changes across those, so it can't be the only effect dependency
// or this would fetch once at mount and never again.
export function HistoryPanel({ leadRef, refreshKey }: { leadRef: string; refreshKey: number }) {
  const [events, setEvents] = useState<(LeadEvent & { id: string; actorDisplayName: string | null })[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLeadHistory(leadRef, { limit: 20 }).then((result) => {
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
  }, [leadRef, refreshKey]);

  return (
    <Panel span={12}>
      <PanelHead title="History / activity" description="Append-only Discovery event history - preserved after conversion." />
      <PanelBody>
        {loading ? (
          <p className="foundationnote">Loading…</p>
        ) : error ? (
          <div className="banner" role="alert">
            {error}
          </div>
        ) : events.length === 0 ? (
          <EmptyState title="No activity yet" />
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

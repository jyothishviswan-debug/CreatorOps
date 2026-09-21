"use client";

import { useEffect, useState } from "react";

import { Panel, PanelBody, PanelGrid, PanelHead } from "@/ui/Panel";
import { EmptyState, Skeleton } from "@/ui/States";
import type { AgreementEventDto } from "@/server/finance-agreements/client-dto";

import { listAgreementEvents } from "../api-client";
import { StatusChip } from "../components";
import { describeAgreementEvent } from "./event-view";
import { ActorNote } from "./TermRows";

const EVENT_PAGE = 50;

type Loaded = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; events: AgreementEventDto[]; hasMore: boolean };

// The Agreement's own audit trail, newest first (one bounded page). Only the allowlist-redacted event metadata reaches the browser: every line is
// a version number, a status, a field NAME, a count or a typed reason - never a field value, an amount or an identity value.
// `refreshKey` changes whenever the Agreement changes, so the list re-reads after a lifecycle action.
export function ActivityTab({ agreementRef, refreshKey }: { agreementRef: string; refreshKey: string }) {
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void listAgreementEvents(agreementRef, { limit: EVENT_PAGE }, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setState(result.ok ? { status: "ready", events: result.data.events, hasMore: result.data.hasMore } : { status: "error", message: result.message });
    });
    return () => controller.abort();
  }, [agreementRef, refreshKey, attempt]);

  const retry = () => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  };

  return (
    <PanelGrid>
      <Panel span={12}>
        <PanelHead title="Activity" description="Audit trail of this Agreement · newest first" />
        <PanelBody>
          {state.status === "loading" && <Skeleton lines={5} />}
          {state.status === "error" && (
            <div className="banner" role="alert">
              <b>Couldn’t load activity.</b> {state.message}{" "}
              <button type="button" className="btn" onClick={retry}>
                Try again
              </button>
            </div>
          )}
          {state.status === "ready" && state.events.length === 0 && <EmptyState title="No activity yet" description="Changes to this Agreement will be listed here." icon="clock" />}
          {state.status === "ready" && state.events.length > 0 && <EventTable events={state.events} hasMore={state.hasMore} />}
        </PanelBody>
      </Panel>
    </PanelGrid>
  );
}

function EventTable({ events, hasMore }: { events: AgreementEventDto[]; hasMore: boolean }) {
  const views = events.map(describeAgreementEvent);
  return (
    <>
      <div className="tablewrap">
        <table className="compact">
          <caption className="sr">Agreement activity</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Event</th>
              <th scope="col">Version</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {views.map((view, index) => (
              <tr key={`${events[index]!.createdAt}-${index}`}>
                <td style={{ whiteSpace: "nowrap" }}>
                  {view.at}
                  <ActorNote actorRef={view.actorRef} />
                </td>
                <td>
                  <StatusChip label={view.label} tone={view.tone} />
                </td>
                <td>Version {view.version}</td>
                <td style={{ overflowWrap: "anywhere" }}>{view.detail ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore && <p className="foundationnote">Showing the newest {events.length} events.</p>}
      <p className="foundationnote" style={{ margin: "8px 0 0" }}>
        Field values, amounts and KYC values are never recorded in this trail.
      </p>
    </>
  );
}

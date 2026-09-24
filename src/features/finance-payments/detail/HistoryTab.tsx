"use client";

import { useEffect, useState } from "react";

import { Skeleton } from "@/ui/States";

import { listPaymentEvents } from "../api-client";
import { historyRows } from "./detail-view";

// Step 17B: Payment detail - History tab. A compact chronological table, fetched on demand (only
// when this tab is actually viewed) rather than on every detail-page load.
export function HistoryTab({ paymentRef }: { paymentRef: string }) {
  const [rows, setRows] = useState<ReturnType<typeof historyRows> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void listPaymentEvents(paymentRef, {}, { signal: controller.signal }).then((result) => {
      if (!result.ok) {
        if (!result.aborted) setError(result.message);
        return;
      }
      setRows(historyRows(result.data.events));
    });
    return () => controller.abort();
  }, [paymentRef]);

  return (
    <section className="panel">
      <div className="panelhead">
        <div>
          <h2>History</h2>
        </div>
      </div>
      <div className="panelbody">
        {error && (
          <div className="banner" role="alert">
            {error}
          </div>
        )}
        {!error && rows === null && <Skeleton lines={4} />}
        {rows !== null && (
          <div className="tablewrap">
            <table className="compact">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Event</th>
                  <th scope="col">Version</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Reason / notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td>{row.date}</td>
                    <td>{row.event}</td>
                    <td>v{row.version}</td>
                    <td>{row.actor}</td>
                    <td style={{ whiteSpace: "normal" }}>{row.reasonOrMetadata}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      No history yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

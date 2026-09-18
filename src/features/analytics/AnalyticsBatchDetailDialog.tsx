"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { DialogShell } from "@/ui/Dialog";
import { Pill } from "@/ui/Badge";
import { Skeleton } from "@/ui/States";
import type { AnalyticsImportBatchDetailDto } from "@/server/analytics/import-history-service";

import { getAnalyticsImportBatchDetail } from "./api-client";
import { absoluteTime, batchStatusLabel, batchStatusTone, shortHash, targetKindLabel } from "./format";

// Read-only - Section 23's own explicit rule: no retry/mutation button
// unless the trusted API genuinely already supports one AND the current
// actor holds permission for it. No such batch-retry endpoint exists in
// this step beyond the already-separate match-correction flow (Explorer's
// own AnalyticsResolveMatchDialog) - so this dialog is strictly display
// only.
export function AnalyticsBatchDetailDialog({ batchRef, open, onClose }: { batchRef: string; open: boolean; onClose: () => void }) {
  const [detail, setDetail] = useState<AnalyticsImportBatchDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!open || loadedFor === batchRef) return;
    let cancelled = false;
    getAnalyticsImportBatchDetail(batchRef).then((result) => {
      if (cancelled) return;
      setLoadedFor(batchRef);
      if (result.ok) setDetail(result.data);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [open, batchRef, loadedFor]);

  return (
    <DialogShell open={open} title={detail?.sourceFilename ?? "Import batch"} onClose={onClose}>
      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}
      {!detail && !error && <Skeleton lines={6} />}
      {detail && (
        <>
          <div className="kv">
            <div>
              <span>Status</span>
              <b>
                <Pill tone={batchStatusTone(detail.status)}>{batchStatusLabel(detail.status)}</Pill>
              </b>
            </div>
            <div>
              <span>Target</span>
              <b>{targetKindLabel(detail.targetKind)}</b>
            </div>
            <div>
              <span>Source revision</span>
              <b>{shortHash(detail.sourceHash)}</b>
            </div>
            <div>
              <span>Created</span>
              <b>{absoluteTime(detail.createdAt)}</b>
            </div>
            <div>
              <span>Started</span>
              <b>{detail.startedAt ? absoluteTime(detail.startedAt) : "—"}</b>
            </div>
            <div>
              <span>Completed</span>
              <b>{detail.completedAt ? absoluteTime(detail.completedAt) : "—"}</b>
            </div>
            <div>
              <span>Actor</span>
              <b>{detail.actorDisplayName ?? "Unknown"}</b>
            </div>
            <div>
              <span>Correction eligible</span>
              <b>{detail.correctionEligible ? "Yes" : "No - superseded"}</b>
            </div>
          </div>

          {detail.supersededByBatchRef && (
            <p className="foundationnote" style={{ margin: "12px 0 0" }}>
              Superseded by a later batch.{" "}
              <Link href={`/analytics/import-history`} onClick={onClose}>
                View import history
              </Link>
              .
            </p>
          )}

          <p className="foundationnote" style={{ margin: "16px 0 6px" }}>
            Source sheet inventory
          </p>
          {detail.sourceSheetInventory.length === 0 ? (
            <p className="foundationnote">No sheet inventory recorded.</p>
          ) : (
            <div className="kv">
              {detail.sourceSheetInventory.map((sheet) => (
                <div key={sheet.sheetName}>
                  <span>{sheet.sheetName}</span>
                  <b>
                    {sheet.rowCount} rows · {sheet.recognizedAs === "unrecognized" ? "Unrecognized sheet" : targetKindLabel(sheet.recognizedAs)}
                  </b>
                </div>
              ))}
            </div>
          )}

          <p className="foundationnote" style={{ margin: "16px 0 6px" }}>
            Reconciled row totals
          </p>
          <div className="kv">
            <div>
              <span>Total rows</span>
              <b>{detail.totalRows.toLocaleString("en-GB")}</b>
            </div>
            <div>
              <span>Actionable</span>
              <b>{detail.actionableRows.toLocaleString("en-GB")}</b>
            </div>
            <div>
              <span>Matched</span>
              <b>{detail.matchedRows.toLocaleString("en-GB")}</b>
            </div>
            <div>
              <span>Unmatched</span>
              <b>{detail.unmatchedRows.toLocaleString("en-GB")}</b>
            </div>
            <div>
              <span>Ambiguous</span>
              <b>{detail.ambiguousRows.toLocaleString("en-GB")}</b>
            </div>
            <div>
              <span>Invalid</span>
              <b>{detail.invalidRows.toLocaleString("en-GB")}</b>
            </div>
            <div>
              <span>Duplicate/unchanged</span>
              <b>{detail.duplicateUnchangedRows.toLocaleString("en-GB")}</b>
            </div>
            <div>
              <span>Failed</span>
              <b>{detail.failedRows.toLocaleString("en-GB")}</b>
            </div>
          </div>

          {detail.safeErrorSummary.length > 0 && (
            <>
              <p className="foundationnote" style={{ margin: "16px 0 6px" }}>
                Error summary
              </p>
              <ul>
                {detail.safeErrorSummary.map((message, i) => (
                  <li key={i}>{message}</li>
                ))}
              </ul>
            </>
          )}

          <p className="foundationnote" style={{ margin: "16px 0 0" }}>
            <Link href={`/analytics/explorer?batchRef=${encodeURIComponent(detail.batchRef)}&recordKind=${detail.targetKind === "channel_account" ? "channel" : "content"}`} onClick={onClose}>
              View this batch&rsquo;s records in Explorer
            </Link>
          </p>
        </>
      )}
    </DialogShell>
  );
}

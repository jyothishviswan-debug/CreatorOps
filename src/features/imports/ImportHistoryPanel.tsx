"use client";

import { useEffect, useState } from "react";

import { Icon } from "@/ui/icons";
import { Pill } from "@/ui/Badge";

import { executeImport, getImportBatchDetail, listImportBatches, resumeAnalyticsImport, type ImportBatchListItem, type ImportModuleArg } from "./api-client";
import { batchStatusLabel } from "./copy";
import { CountsSummary, RowsTable } from "./RowsTable";
import type { ClassifiedImportError, ImportRunResult } from "./types";

// Finding #61: a batch resumable status is COMPLETED_WITH_ERRORS OR
// FAILED (a batch where every row quarantined is classified FAILED, not
// COMPLETED_WITH_ERRORS - see import-service.ts's own comment) - as long
// as it has at least one quarantined row. Recomputed here from the same
// two facts the server itself gates on, so History never silently hides
// the Resume action for a FAILED batch just because its status label
// looks more severe.
function isResumable(status: string, quarantinedRows: number): boolean {
  return (status === "COMPLETED_WITH_ERRORS" || status === "FAILED") && quarantinedRows > 0;
}

// Finding #61: users must understand batch status, whether any rows
// committed, and what's safe to do next - not just a status pill.
function statusExplanation(status: string, quarantinedRows: number): string {
  switch (status) {
    case "COMPLETED":
      return "Every row was processed successfully. No action needed.";
    case "COMPLETED_WITH_ERRORS":
      return `Most rows committed, but ${quarantinedRows} row(s) failed to commit and are quarantined - the rows that succeeded are already saved and will not be re-processed. Resume with the exact same file to retry only the quarantined rows.`;
    case "FAILED":
      return quarantinedRows > 0
        ? `No rows committed - all ${quarantinedRows} row(s) failed and are quarantined. Resume with the exact same file to retry them, or start a superseding import if the source data itself needs correcting.`
        : "This batch failed before any rows could be processed.";
    case "PENDING":
      return "This batch is still being processed.";
    default:
      return "";
  }
}

// Import Center Completion (spec section 11): Import History / Provenance -
// safe metadata only (target, source filename, actor DISPLAY label,
// timestamps, status, row counts/outcomes, attempts/resume relationship).
// Never a raw uid/doc id as a primary label, never a restricted contract-
// bundle value.

function StatusPill({ status }: { status: string }) {
  const tone = status === "COMPLETED" ? "blue" : status === "FAILED" ? "red" : status === "COMPLETED_WITH_ERRORS" ? "orange" : "gray";
  return <Pill tone={tone}>{batchStatusLabel(status)}</Pill>;
}

export function ImportHistoryPanel() {
  const [moduleKey, setModuleKey] = useState<ImportModuleArg>("analytics");
  const [batches, setBatches] = useState<ImportBatchListItem[] | null>(null);
  const [error, setError] = useState<ClassifiedImportError | null>(null);
  const [busy, setBusy] = useState(true);
  const [selected, setSelected] = useState<ImportBatchListItem | null>(null);

  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState<ClassifiedImportError | null>(null);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);

  const [supersedeFile, setSupersedeFile] = useState<File | null>(null);
  const [supersedeBusy, setSupersedeBusy] = useState(false);
  const [supersedeError, setSupersedeError] = useState<ClassifiedImportError | null>(null);
  const [supersedeNotice, setSupersedeNotice] = useState<string | null>(null);

  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listImportBatches(moduleKey, 20).then((result) => {
      if (cancelled) return;
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setBatches(result.data.batches);
    });
    return () => {
      cancelled = true;
    };
  }, [moduleKey, refreshToken]);

  function handleModuleChange(next: ImportModuleArg) {
    setBusy(true);
    setSelected(null);
    // Clear the previous target's rows/error immediately - otherwise a
    // denied or empty result for the NEW target briefly renders underneath
    // the PREVIOUS target's still-visible batch rows, which reads as if
    // those rows belong to the newly selected target.
    setBatches(null);
    setError(null);
    setModuleKey(next);
  }

  async function openDetail(batchRef: string) {
    const result = await getImportBatchDetail(moduleKey, batchRef);
    if (result.ok) setSelected(result.data);
  }

  // The row-click entry point - resets per-action state (resume/supersede
  // file pickers, errors, success notices) since this is a genuinely NEW
  // batch being viewed. handleResume/handleSupersede re-fetch the SAME
  // batch afterward via openDetail directly (not this wrapper), so their
  // own just-set success notice is never immediately wiped out.
  async function selectBatch(batchRef: string) {
    setResumeFile(null);
    setResumeError(null);
    setResumeNotice(null);
    setSupersedeFile(null);
    setSupersedeError(null);
    setSupersedeNotice(null);
    await openDetail(batchRef);
  }

  async function handleResume() {
    if (!resumeFile || !selected) return;
    setResumeBusy(true);
    setResumeError(null);
    setResumeNotice(null);
    const result = await resumeAnalyticsImport(String(selected.batchRef), resumeFile, selected.targetKind === "channel_account" ? { channelPlatform: "instagram" } : {});
    setResumeBusy(false);
    if (!result.ok) {
      setResumeError(result.error);
      return;
    }
    setResumeNotice(`Resumed - ${result.data.quarantinedRows ?? 0} row(s) still quarantined.`);
    await openDetail(String(selected.batchRef));
    setRefreshToken((n) => n + 1);
  }

  // Finding #61: "Upload corrected file" / "Start a superseding import" -
  // both just execute a new import that declares supersedesBatchRef,
  // reusing the exact same trusted execute path (and finding #67's own
  // fix, which is what makes byte-identical re-assertion vs. a genuinely
  // different corrected file both work correctly here) rather than a
  // second, invented recovery mechanism.
  async function handleSupersede() {
    if (!supersedeFile || !selected || moduleKey !== "analytics") return;
    setSupersedeBusy(true);
    setSupersedeError(null);
    setSupersedeNotice(null);
    const result = await executeImport("analytics", supersedeFile, {
      targetKind: selected.targetKind,
      supersedesBatchRef: String(selected.batchRef),
      ...(selected.targetKind === "channel_account" ? { channelPlatform: "instagram" } : {}),
    });
    setSupersedeBusy(false);
    if (!result.ok) {
      setSupersedeError(result.error);
      return;
    }
    setSupersedeNotice(`New batch created: ${result.data.batchRef ?? "—"}.`);
    setSupersedeFile(null);
    setRefreshToken((n) => n + 1);
  }

  const safeErrorSummary = Array.isArray(selected?.safeErrorSummary) ? (selected.safeErrorSummary as string[]) : [];
  const selectedRows = Array.isArray(selected?.rows) ? (selected.rows as ImportRunResult["rows"]) : undefined;
  // AnalyticsImportBatchDoc (what History's detail fetch actually returns)
  // has no nested `counts` object - it stores the same numbers as separate
  // flat fields (matchedRows, unmatchedRows, ...). Rebuilt into the same
  // shape CountsSummary/batchToDto already use server-side, so this panel
  // shows real counts instead of always reading `selected.counts` (which
  // never existed on this DTO) and silently rendering "No rows counted."
  const historyCounts: Record<string, number> = selected
    ? {
        matched: Number(selected.matchedRows ?? 0),
        unmatched: Number(selected.unmatchedRows ?? 0),
        ambiguous: Number(selected.ambiguousRows ?? 0),
        invalid: Number(selected.invalidRows ?? 0),
        duplicate: Number(selected.duplicateUnchangedRows ?? 0),
        quarantined: Number(selected.quarantinedRows ?? 0),
      }
    : {};

  return (
    <div>
      <div className="fields">
        <div className="field">
          <label htmlFor="import-history-module">Target</label>
          <select id="import-history-module" value={moduleKey} onChange={(e) => handleModuleChange(e.target.value as ImportModuleArg)}>
            <option value="analytics">Analytics</option>
            <option value="contract_bundle">Contract bundle</option>
            <option value="content_links">Content links</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="banner" role="alert">
          {error.message}
        </div>
      )}
      {busy && <p className="foundationnote">Loading…</p>}

      {batches && batches.length === 0 && <p className="foundationnote">No import runs yet.</p>}

      {batches && batches.length > 0 && (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Source file</th>
                <th>Actor</th>
                <th>Status</th>
                <th>Rows</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={String(batch.batchRef)} style={{ cursor: "pointer" }} onClick={() => void selectBatch(String(batch.batchRef))}>
                  <td>{String(batch.createdAt).slice(0, 19).replace("T", " ")}</td>
                  <td>{String(batch.sourceFilename)}</td>
                  <td>{String((batch as { actorDisplayName?: string | null }).actorDisplayName ?? "—")}</td>
                  <td>
                    <StatusPill status={String(batch.status)} />
                  </td>
                  <td>{String(batch.totalRows ?? "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panelhead">
            <h2>
              <Icon name="file" /> {String(selected.sourceFilename)}
            </h2>
          </div>
          <div className="panelbody">
            <p>
              <StatusPill status={String(selected.status)} /> · Actor: {String((selected as { actorDisplayName?: string | null }).actorDisplayName ?? "—")} · Started {String(selected.createdAt).slice(0, 19).replace("T", " ")}
              {selected.completedAt ? ` · Completed ${String(selected.completedAt).slice(0, 19).replace("T", " ")}` : ""}
            </p>
            {statusExplanation(String(selected.status), Number(selected.quarantinedRows ?? 0)) && (
              <p className="foundationnote">{statusExplanation(String(selected.status), Number(selected.quarantinedRows ?? 0))}</p>
            )}
            {typeof selected.attempts === "number" && selected.attempts > 1 && <p className="foundationnote">{selected.attempts} attempt(s) recorded (see attempt history below).</p>}
            {(selected as { supersededByBatchRef?: string | null }).supersededByBatchRef && (
              <div className="banner" role="status">This batch has been superseded by a newer import - it is no longer the current revision.</div>
            )}
            <CountsSummary counts={historyCounts} />
            {safeErrorSummary.length > 0 && (
              <>
                <h3>Why rows failed</h3>
                <ul className="checklist">
                  {safeErrorSummary.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </>
            )}
            {Array.isArray(selected.attemptHistory) && selected.attemptHistory.length > 0 && (
              <>
                <h3>Attempt history</h3>
                <ul className="checklist">
                  {(selected.attemptHistory as Array<{ attemptNumber: number; kind: string; at: string; status: string; quarantinedRows: number }>).map((attempt) => (
                    <li key={attempt.attemptNumber}>
                      Attempt {attempt.attemptNumber} ({attempt.kind}) at {attempt.at.slice(0, 19).replace("T", " ")} - {batchStatusLabel(attempt.status)}, {attempt.quarantinedRows} quarantined
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h3>Row-level detail</h3>
            {selectedRows ? (
              <RowsTable rows={selectedRows} rowsTruncated={Boolean((selected as { rowsTruncated?: boolean }).rowsTruncated)} />
            ) : (
              <p className="foundationnote">Row-level detail isn&rsquo;t available for this batch (it predates this feature).</p>
            )}

            {moduleKey === "analytics" && isResumable(String(selected.status), Number(selected.quarantinedRows ?? 0)) && (
              <div className="field full" style={{ marginTop: 12 }}>
                <div className="scopebox">This batch has {String(selected.quarantinedRows)} quarantined row(s). Re-upload the exact same source file to resume - already-committed rows are never re-processed.</div>
                <input id="import-history-resume-file" type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setResumeFile(e.target.files?.[0] ?? null)} />
                <button type="button" className="btn" disabled={!resumeFile || resumeBusy} onClick={handleResume}>
                  {resumeBusy ? "Resuming…" : "Resume"}
                </button>
                {resumeNotice && <p className="foundationnote">{resumeNotice}</p>}
                {resumeError && (
                  <div className="banner" role="alert">
                    {resumeError.message}
                  </div>
                )}
              </div>
            )}

            {moduleKey === "analytics" && !(selected as { supersededByBatchRef?: string | null }).supersededByBatchRef && (
              <div className="field full" style={{ marginTop: 12 }}>
                <div className="scopebox">
                  Start a superseding import to correct this batch - upload a corrected file, or re-upload the same file to explicitly re-assert it. This creates a genuinely new batch; it never overwrites this one&rsquo;s records.
                </div>
                <input id="import-history-supersede-file" type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setSupersedeFile(e.target.files?.[0] ?? null)} />
                <button type="button" className="btn" disabled={!supersedeFile || supersedeBusy} onClick={handleSupersede}>
                  {supersedeBusy ? "Starting…" : "Start a superseding import"}
                </button>
                {supersedeNotice && <p className="foundationnote">{supersedeNotice}</p>}
                {supersedeError && (
                  <div className="banner" role="alert">
                    {supersedeError.message}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

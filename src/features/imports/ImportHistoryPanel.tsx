"use client";

import { useEffect, useState } from "react";

import { Icon } from "@/ui/icons";
import { Pill } from "@/ui/Badge";

import { getImportBatchDetail, listImportBatches, resumeAnalyticsImport, type ImportBatchListItem, type ImportModuleArg } from "./api-client";
import { batchStatusLabel } from "./copy";
import type { ClassifiedImportError } from "./types";

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
    setModuleKey(next);
  }

  async function openDetail(batchRef: string) {
    const result = await getImportBatchDetail(moduleKey, batchRef);
    if (result.ok) setSelected(result.data);
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

  return (
    <div>
      <div className="fields">
        <div className="field">
          <label htmlFor="import-history-module">Target</label>
          <select id="import-history-module" value={moduleKey} onChange={(e) => handleModuleChange(e.target.value as ImportModuleArg)}>
            <option value="analytics">Analytics</option>
            <option value="contract_bundle">Contract bundle</option>
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
                <tr key={String(batch.batchRef)} style={{ cursor: "pointer" }} onClick={() => void openDetail(String(batch.batchRef))}>
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
            {typeof selected.attempts === "number" && selected.attempts > 1 && <p className="foundationnote">{selected.attempts} attempt(s) recorded (see attempt history below).</p>}
            <ul className="checklist">
              {Object.entries((selected.counts as Record<string, number> | undefined) ?? {})
                .filter(([, count]) => count > 0)
                .map(([key, count]) => (
                  <li key={key}>
                    {key}: {count}
                  </li>
                ))}
            </ul>
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

            {moduleKey === "analytics" && String(selected.status) === "COMPLETED_WITH_ERRORS" && Number(selected.quarantinedRows ?? 0) > 0 && (
              <div className="field full" style={{ marginTop: 12 }}>
                <div className="scopebox">This batch has {String(selected.quarantinedRows)} quarantined row(s). Re-upload the exact same source file to resume.</div>
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
          </div>
        </div>
      )}
    </div>
  );
}

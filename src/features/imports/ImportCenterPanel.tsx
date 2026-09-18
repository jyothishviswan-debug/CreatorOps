"use client";

import { useState } from "react";

// Step 12A: the minimal, real Import Center wiring for
// /imports?module=analytics - reuses the existing page's own visual
// shell/classes (panel/panelhead/panelbody/fields/field/btn/banner), no
// redesign. Proves the actual pipeline (upload -> dry-run -> execute)
// through the real UI, kept intentionally bounded - this is NOT the
// final, polished Import Center experience.
type TargetKind = "campaign_content" | "channel_account";

type ImportRunResult = {
  batchRef: string | null;
  totalRows: number;
  counts: Record<string, number>;
  sourceSheetInventory: Array<{ sheetName: string; rowCount: number; recognizedAs: string }>;
  safeErrorSummary: string[];
  status?: string | null;
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const commaIndex = result.indexOf(",");
      resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

async function postImportRequest(path: "dry-run" | "execute", file: File, targetKind: TargetKind, channelPlatform: string): Promise<{ ok: true; data: ImportRunResult } | { ok: false; error: string }> {
  const fileBase64 = await fileToBase64(file);
  const response = await fetch(`/api/imports/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      module: "analytics",
      targetKind,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      fileBase64,
      ...(targetKind === "channel_account" ? { channelPlatform } : {}),
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, error: (body && body.error) || `Request failed (${response.status}).` };
  return { ok: true, data: body as ImportRunResult };
}

export function ImportCenterPanel() {
  const [targetKind, setTargetKind] = useState<TargetKind>("campaign_content");
  const [channelPlatform, setChannelPlatform] = useState("instagram");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<"dry-run" | "execute" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportRunResult | null>(null);

  async function run(path: "dry-run" | "execute") {
    if (!file) {
      setError("Choose a file first.");
      return;
    }
    setBusy(path);
    setError(null);
    const outcome = await postImportRequest(path, file, targetKind, channelPlatform);
    setBusy(null);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setResult(outcome.data);
  }

  return (
    <div className="fields">
      <div className="field">
        <label htmlFor="import-target-kind">Import target</label>
        <select id="import-target-kind" value={targetKind} onChange={(e) => setTargetKind(e.target.value as TargetKind)}>
          <option value="campaign_content">Campaign / Content (posts)</option>
          <option value="channel_account">Channel / Account (snapshots)</option>
        </select>
      </div>

      {targetKind === "channel_account" && (
        <div className="field">
          <label htmlFor="import-channel-platform">Platform</label>
          <input id="import-channel-platform" type="text" value={channelPlatform} onChange={(e) => setChannelPlatform(e.target.value)} placeholder="instagram" />
        </div>
      )}

      <div className="field full">
        <label htmlFor="import-file">File (.xlsx, .xls, .csv - max 10 MB)</label>
        <input id="import-file" type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>

      <div className="field full" style={{ display: "flex", gap: 10 }}>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => run("dry-run")}>
          {busy === "dry-run" ? "Running dry-run…" : "Dry-run"}
        </button>
        <button type="button" className="btn primary" disabled={busy !== null} onClick={() => run("execute")}>
          {busy === "execute" ? "Executing…" : "Execute import"}
        </button>
      </div>

      {error && (
        <div className="field full">
          <div className="banner" role="alert">
            {error}
          </div>
        </div>
      )}

      {result && (
        <div className="field full">
          <p className="foundationnote">
            {result.batchRef ? `Batch ${result.batchRef} - ${result.status ?? "unknown status"}` : "Dry-run only - nothing was written."} · {result.totalRows} row(s) parsed.
          </p>
          <ul className="checklist">
            {Object.entries(result.counts)
              .filter(([, count]) => count > 0)
              .map(([classification, count]) => (
                <li key={classification}>
                  {classification}: {count}
                </li>
              ))}
          </ul>
          {result.sourceSheetInventory.length > 0 && (
            <p className="foundationnote">Sheets: {result.sourceSheetInventory.map((s) => `${s.sheetName} (${s.recognizedAs}, ${s.rowCount} rows)`).join("; ")}</p>
          )}
          {result.safeErrorSummary.length > 0 && (
            <ul className="checklist">
              {result.safeErrorSummary.map((message, i) => (
                <li key={i}>{message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { Icon } from "@/ui/icons";
import { LocalTabs } from "@/ui/LocalTabs";
import { Pill } from "@/ui/Badge";

import { dryRunImport, executeImport, previewImportFile, resumeAnalyticsImport, type ImportModuleArg } from "./api-client";
import { classificationLabel, batchStatusLabel, ERROR_CATEGORY_LABELS, MODULE_DESCRIPTIONS, MODULE_LABELS, outcomeLabel, outcomeTone } from "./copy";
import type { ClassifiedImportError, ImportFilePreviewResult, ImportRunResult } from "./types";

// Import Center Completion - the real governed flow:
// Choose Data -> Upload -> File/Sheet Preview -> Mapping (conditional) ->
// Validation & Diff / Review -> Import -> Results. History lives in the
// sibling ImportHistoryPanel (a separate tab on the host page).
//
// Non-mutation discipline: only handleExecute ever calls the execute
// API. Every earlier step (preview, dry-run) is read-only, and the
// Import button itself is disabled unless the actor has both (a)
// explicitly acknowledged the Review counts AND (b) not changed the
// selected file since that review ran (`reviewedSignature` below) - a
// changed file always forces a brand-new dry-run before Import
// re-enables. The server independently re-validates/re-authorizes on
// execute regardless (see import-service.ts) - this is a UX guard, not
// the actual safety boundary.

type Step = "choose" | "upload" | "preview" | "mapping" | "review" | "results";
const STEP_ORDER: Step[] = ["choose", "upload", "preview", "mapping", "review", "results"];
const STEP_LABELS: Record<Step, string> = { choose: "Choose data", upload: "Upload", preview: "Preview", mapping: "Mapping", review: "Review", results: "Results" };

function fileSignature(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function ErrorBanner({ error }: { error: ClassifiedImportError }) {
  return (
    <div className="banner" role="alert">
      <strong>{ERROR_CATEGORY_LABELS[error.category]}: </strong>
      {error.message}
      {!error.correctable && <span> This is not something you can fix by changing the file - contact support if it continues.</span>}
    </div>
  );
}

function CountsSummary({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  if (entries.length === 0) return <p className="foundationnote">No rows counted.</p>;
  return (
    <div className="fields">
      {entries.map(([key, count]) => (
        <div className="field" key={key}>
          <Pill tone={outcomeTone(key)}>
            {outcomeLabel(key) !== key ? outcomeLabel(key) : classificationLabel(key)}: {count}
          </Pill>
        </div>
      ))}
    </div>
  );
}

function RowsTable({ rows, rowsTruncated }: { rows: NonNullable<ImportRunResult["rows"]>; rowsTruncated?: boolean }) {
  const [filter, setFilter] = useState<string | null>(null);
  const outcomes = useMemo(() => [...new Set(rows.map((r) => r.outcome))], [rows]);
  const visible = filter ? rows.filter((r) => r.outcome === filter) : rows;

  if (rows.length === 0) return <p className="foundationnote">No row-level detail to show.</p>;

  return (
    <div>
      <div className="toolbar" role="group" aria-label="Filter rows by outcome">
        <button type="button" className={filter === null ? "btn primary" : "btn"} onClick={() => setFilter(null)}>
          All ({rows.length})
        </button>
        {outcomes.map((outcome) => (
          <button key={outcome} type="button" className={filter === outcome ? "btn primary" : "btn"} onClick={() => setFilter(outcome)}>
            {outcomeLabel(outcome) !== outcome ? outcomeLabel(outcome) : classificationLabel(outcome)} ({rows.filter((r) => r.outcome === outcome).length})
          </button>
        ))}
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Sheet</th>
              <th>Row</th>
              <th>Outcome</th>
              <th>Identity</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => (
              <tr key={`${row.sheetName}-${row.sourceRowNumber}-${i}`}>
                <td>{row.sheetName}</td>
                <td>{row.sourceRowNumber}</td>
                <td>
                  <Pill tone={outcomeTone(row.outcome)}>{outcomeLabel(row.outcome) !== row.outcome ? outcomeLabel(row.outcome) : classificationLabel(row.outcome)}</Pill>
                </td>
                <td>{row.identityLabel ?? "—"}</td>
                <td>{row.detail ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rowsTruncated && <p className="foundationnote">Showing a bounded sample of rows - the counts above cover every row in the file.</p>}
    </div>
  );
}

function SheetPreviewView({ preview }: { preview: ImportFilePreviewResult }) {
  return (
    <div>
      {preview.warnings.length > 0 && (
        <ul className="checklist">
          {preview.warnings.map((w, i) => (
            <li key={i}>
              <Icon name="alert" /> {w}
            </li>
          ))}
        </ul>
      )}
      {preview.sheets.map((sheet) => (
        <div key={sheet.sheetName} className="field full">
          <p>
            <strong>{sheet.sheetName}</strong> · {sheet.rowCount} row(s) · {sheet.headers.length} column(s)
            {sheet.emptyRowCount > 0 && ` · ${sheet.emptyRowCount} blank row(s)`}
          </p>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  {sheet.headers.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.sampleRows.map((row, i) => (
                  <tr key={i}>
                    {sheet.headers.map((h) => (
                      <td key={h}>{row[h] === null || row[h] === undefined ? "—" : String(row[h])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sheet.sampleRowsTruncated && <p className="foundationnote">Showing the first {sheet.sampleRows.length} row(s) of {sheet.rowCount}.</p>}
        </div>
      ))}
    </div>
  );
}

export function ImportCenterWizard() {
  const [moduleKey, setModuleKey] = useState<ImportModuleArg>("analytics");
  const [targetKind, setTargetKind] = useState<"campaign_content" | "channel_account">("campaign_content");
  const [channelPlatform, setChannelPlatform] = useState("instagram");
  const [defaultRegionId, setDefaultRegionId] = useState("");

  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("choose");
  const [maxReachedIndex, setMaxReachedIndex] = useState(0);

  const [previewResult, setPreviewResult] = useState<ImportFilePreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<ClassifiedImportError | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const [dryRunResult, setDryRunResult] = useState<ImportRunResult | null>(null);
  const [dryRunError, setDryRunError] = useState<ClassifiedImportError | null>(null);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [reviewedSignature, setReviewedSignature] = useState<string | null>(null);
  const [acknowledgedReview, setAcknowledgedReview] = useState(false);

  const [executeResult, setExecuteResult] = useState<ImportRunResult | null>(null);
  const [executeError, setExecuteError] = useState<ClassifiedImportError | null>(null);
  const [executeBusy, setExecuteBusy] = useState(false);

  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState<ClassifiedImportError | null>(null);

  const options = useMemo(() => {
    if (moduleKey === "analytics") return { targetKind, ...(targetKind === "channel_account" ? { channelPlatform } : {}) };
    return { ...(defaultRegionId ? { defaultRegionId } : {}) };
  }, [moduleKey, targetKind, channelPlatform, defaultRegionId]);

  function goTo(next: Step) {
    const index = STEP_ORDER.indexOf(next);
    setStep(next);
    setMaxReachedIndex((current) => Math.max(current, index));
  }

  function resetDownstreamOfFile() {
    setPreviewResult(null);
    setPreviewError(null);
    setDryRunResult(null);
    setDryRunError(null);
    setReviewedSignature(null);
    setAcknowledgedReview(false);
    setExecuteResult(null);
    setExecuteError(null);
  }

  function handleFileChosen(next: File | null) {
    setFile(next);
    resetDownstreamOfFile();
  }

  const handleStartUpload = useCallback(() => {
    goTo("upload");
  }, []);

  async function handleRunPreview() {
    if (!file) return;
    setPreviewBusy(true);
    setPreviewError(null);
    const result = await previewImportFile(file);
    setPreviewBusy(false);
    if (!result.ok) {
      setPreviewError(result.error);
      return;
    }
    setPreviewResult(result.data);
    goTo("preview");
  }

  async function handleRunValidation() {
    if (!file) return;
    setDryRunBusy(true);
    setDryRunError(null);
    const result = await dryRunImport(moduleKey, file, options);
    setDryRunBusy(false);
    if (!result.ok) {
      setDryRunError(result.error);
      return;
    }
    setDryRunResult(result.data);
    setReviewedSignature(fileSignature(file));
    setAcknowledgedReview(false);

    const mappingNeeded = result.data.sourceSheetInventory.some((s) => s.recognizedAs === "unrecognized") || result.data.safeErrorSummary.some((m) => m.toLowerCase().includes("ignored unsupported column"));
    goTo(mappingNeeded ? "mapping" : "review");
  }

  async function handleExecute() {
    if (!file) return;
    setExecuteBusy(true);
    setExecuteError(null);
    const result = await executeImport(moduleKey, file, options);
    setExecuteBusy(false);
    if (!result.ok) {
      setExecuteError(result.error);
      return;
    }
    setExecuteResult(result.data);
    goTo("results");
  }

  async function handleResume() {
    if (!resumeFile || !executeResult?.batchRef) return;
    setResumeBusy(true);
    setResumeError(null);
    const result = await resumeAnalyticsImport(executeResult.batchRef, resumeFile, options);
    setResumeBusy(false);
    if (!result.ok) {
      setResumeError(result.error);
      return;
    }
    setExecuteResult(result.data);
  }

  const isStale = file && reviewedSignature !== fileSignature(file);
  const hasUnrecognizedSheet = dryRunResult?.sourceSheetInventory.some((s) => s.recognizedAs === "unrecognized") ?? false;
  const canImport = Boolean(dryRunResult) && !isStale && acknowledgedReview && !executeBusy && !hasUnrecognizedSheet;

  return (
    <div>
      <LocalTabs
        tabs={STEP_ORDER.map((s) => ({ key: s, label: STEP_LABELS[s] }))}
        active={step}
        onChange={(key) => {
          const index = STEP_ORDER.indexOf(key as Step);
          if (index <= maxReachedIndex) setStep(key as Step);
        }}
      />

      {step === "choose" && (
        <div className="fields">
          <div className="field full">
            <label htmlFor="import-module">Import target</label>
            <select
              id="import-module"
              value={moduleKey}
              onChange={(e) => {
                setModuleKey(e.target.value as ImportModuleArg);
                handleFileChosen(null);
              }}
            >
              <option value="analytics">{MODULE_LABELS.analytics}</option>
              <option value="contract_bundle">{MODULE_LABELS.contract_bundle}</option>
            </select>
            <small>{MODULE_DESCRIPTIONS[moduleKey]}</small>
          </div>

          {moduleKey === "analytics" && (
            <>
              <div className="field">
                <label htmlFor="import-target-kind">What kind of data is this?</label>
                <select id="import-target-kind" value={targetKind} onChange={(e) => setTargetKind(e.target.value as typeof targetKind)}>
                  <option value="campaign_content">Campaign / Content (posts)</option>
                  <option value="channel_account">Channel / Account (snapshots)</option>
                </select>
              </div>
              {targetKind === "channel_account" && (
                <div className="field">
                  <label htmlFor="import-channel-platform">Platform</label>
                  <input id="import-channel-platform" type="text" value={channelPlatform} onChange={(e) => setChannelPlatform(e.target.value)} placeholder="instagram" />
                  <small>Used only for a row that carries no platform column of its own.</small>
                </div>
              )}
              <div className="scopebox">Accepted formats: .xlsx, .xls, .csv (max 10 MB). Matched deterministically against canonical Content and Partner Account records - never merged on display name alone.</div>
            </>
          )}

          {moduleKey === "contract_bundle" && (
            <>
              <div className="field">
                <label htmlFor="import-default-region">Default region (optional)</label>
                <input id="import-default-region" type="text" value={defaultRegionId} onChange={(e) => setDefaultRegionId(e.target.value)} placeholder="Used for a row with no Region column of its own" />
              </div>
              <div className="scopebox">
                One Partner Account per row. A sheet containing any restricted payee/KYC-looking column (PAN, Aadhaar, bank/IFSC, GSTIN, UPI, passport, etc.) is rejected outright - KYC is captured separately, per Agreement, through the secure KYC flow. A row with a likely-duplicate match is never force-created; it is
                reported for manual review through the ordinary Agreement-led onboarding screen.
              </div>
            </>
          )}

          <div className="field full">
            <button type="button" className="btn primary" onClick={handleStartUpload}>
              Continue to upload
            </button>
          </div>
        </div>
      )}

      {step === "upload" && (
        <div className="fields">
          <div
            className="field full"
            style={{ border: dragOver ? "2px dashed var(--accent, #4a7dff)" : "2px dashed var(--border, #ccc)", borderRadius: 8, padding: 24, textAlign: "center" }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) handleFileChosen(dropped);
            }}
          >
            <Icon name="upload" />
            <p>Drag a file here, or</p>
            <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
              Choose file
            </button>
            <input id="import-file" ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={(e) => handleFileChosen(e.target.files?.[0] ?? null)} />
            <p className="foundationnote">Accepted: .xlsx, .xls, .csv - max 10 MB.</p>
          </div>

          {file && (
            <div className="field full">
              <p>
                <Icon name="file" /> <strong>{file.name}</strong> · {(file.size / 1024).toFixed(1)} KB
                <button type="button" className="btn" style={{ marginLeft: 12 }} onClick={() => handleFileChosen(null)}>
                  Remove
                </button>
              </p>
            </div>
          )}

          {previewError && (
            <div className="field full">
              <ErrorBanner error={previewError} />
            </div>
          )}

          <div className="field full">
            <button type="button" className="btn primary" disabled={!file || previewBusy} onClick={handleRunPreview}>
              {previewBusy ? "Reading file…" : "Continue to preview"}
            </button>
          </div>
        </div>
      )}

      {step === "preview" && previewResult && (
        <div>
          <SheetPreviewView preview={previewResult} />
          {dryRunError && <ErrorBanner error={dryRunError} />}
          <div className="field full" style={{ marginTop: 16 }}>
            <button type="button" className="btn primary" disabled={dryRunBusy} onClick={handleRunValidation}>
              {dryRunBusy ? "Validating…" : "Continue to validation"}
            </button>
          </div>
        </div>
      )}

      {step === "mapping" && dryRunResult && (
        <div>
          <h3>Detected columns</h3>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Sheet</th>
                  <th>Rows</th>
                  <th>Recognized as</th>
                </tr>
              </thead>
              <tbody>
                {dryRunResult.sourceSheetInventory.map((s) => (
                  <tr key={s.sheetName}>
                    <td>{s.sheetName}</td>
                    <td>{s.rowCount}</td>
                    <td>
                      {s.recognizedAs === "unrecognized" ? (
                        <Pill tone="red">Not recognized</Pill>
                      ) : (
                        <Pill tone="blue">{s.recognizedAs}</Pill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasUnrecognizedSheet ? (
            <div className="banner" role="alert">
              One or more sheets could not be matched to a known template, so this file cannot be mapped automatically. This Import Center does not support manual column remapping - go back, fix the sheet&rsquo;s headers to match a supported template, and re-upload.
            </div>
          ) : (
            dryRunResult.safeErrorSummary.length > 0 && (
              <ul className="checklist">
                {dryRunResult.safeErrorSummary.map((m, i) => (
                  <li key={i}>
                    <Icon name="alert" /> {m}
                  </li>
                ))}
              </ul>
            )
          )}
          <div className="field full" style={{ marginTop: 16, display: "flex", gap: 10 }}>
            <button type="button" className="btn" onClick={() => goTo("upload")}>
              Back to upload
            </button>
            {!hasUnrecognizedSheet && (
              <button type="button" className="btn primary" onClick={() => goTo("review")}>
                Continue to review
              </button>
            )}
          </div>
        </div>
      )}

      {step === "review" && dryRunResult && (
        <div>
          <p className="foundationnote">{dryRunResult.totalRows} row(s) parsed · nothing has been written yet.</p>
          <CountsSummary counts={dryRunResult.counts} />
          {dryRunResult.safeErrorSummary.length > 0 && (
            <ul className="checklist">
              {dryRunResult.safeErrorSummary.map((m, i) => (
                <li key={i}>
                  <Icon name="alert" /> {m}
                </li>
              ))}
            </ul>
          )}
          {dryRunResult.rows && <RowsTable rows={dryRunResult.rows} rowsTruncated={dryRunResult.rowsTruncated} />}

          {isStale && <div className="banner" role="alert">The selected file has changed since this review ran. Go back and re-validate before importing.</div>}
          {executeError && <ErrorBanner error={executeError} />}

          <div className="field full" style={{ marginTop: 16 }}>
            <label>
              <input type="checkbox" checked={acknowledgedReview} onChange={(e) => setAcknowledgedReview(e.target.checked)} disabled={Boolean(isStale)} /> I have reviewed the counts and row outcomes above.
            </label>
          </div>
          <div className="field full" style={{ display: "flex", gap: 10 }}>
            <button type="button" className="btn" onClick={() => goTo(hasUnrecognizedSheet ? "mapping" : "preview")}>
              Back
            </button>
            <button type="button" className="btn primary" disabled={!canImport} onClick={handleExecute}>
              {executeBusy ? "Importing…" : "Import"}
            </button>
          </div>
        </div>
      )}

      {step === "results" && executeResult && (
        <div>
          <p>
            <Pill tone={executeResult.status === "COMPLETED" ? "blue" : executeResult.status === "FAILED" ? "red" : "orange"}>{batchStatusLabel(executeResult.status)}</Pill>{" "}
            {executeResult.batchRef ? `Batch ${executeResult.batchRef.slice(0, 8)}…` : ""} · {executeResult.totalRows} row(s)
            {executeResult.idempotentReplay && " · this file was already imported (no-op replay)"}
          </p>
          <CountsSummary counts={executeResult.counts} />
          {executeResult.rows && <RowsTable rows={executeResult.rows} rowsTruncated={executeResult.rowsTruncated} />}

          {moduleKey === "analytics" && (executeResult.quarantinedRows ?? 0) > 0 && (
            <div className="field full" style={{ marginTop: 16 }}>
              <div className="scopebox">
                {executeResult.quarantinedRows} row(s) failed to commit and are quarantined - retryable without re-processing rows already committed. Re-upload the EXACT same file to resume.
              </div>
              <input id="import-resume-file" type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setResumeFile(e.target.files?.[0] ?? null)} />
              <button type="button" className="btn" disabled={!resumeFile || resumeBusy} onClick={handleResume}>
                {resumeBusy ? "Resuming…" : "Resume quarantined rows"}
              </button>
              {resumeError && <ErrorBanner error={resumeError} />}
            </div>
          )}

          <div className="field full" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setFile(null);
                resetDownstreamOfFile();
                setExecuteResult(null);
                setMaxReachedIndex(0);
                setStep("choose");
              }}
            >
              Start a new import
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

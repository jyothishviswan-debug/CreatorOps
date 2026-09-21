"use client";

// Step 14B intake, section 2 `Contract source`: upload the signed Agreement PDF, read it (`Extract from Agreement`) and - only by an
// explicit second click - add the proposals to the draft (`Attach extracted values to draft`, as PENDING, never accepted).
// Extraction suggests values only; nothing here confirms, verifies or writes master data.
import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";

import { StatusChip } from "../components/StatusChip";
import { CONTRACT_SOURCE_COPY, DISABLED_BUTTON_STYLE, formatFileSize, formatInstant } from "../format";
import { extractionAnnouncement, pickContractFile, summarizeExtraction, contractControls, type FilePick } from "./contract-source-logic";
import { INTAKE_BUSY, useIntake } from "./intake-context";
import { SectionCard } from "./SectionCard";

export function ContractSourceSection() {
  const intake = useIntake();
  const { flags, artifact, extraction, extractionAttached, extractionPhase, isBusy, extractFromFile, attachExtraction } = intake;
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const focusResultRef = useRef(false);
  const [pick, setPick] = useState<FilePick>({ file: null, error: null });

  const busy = isBusy();
  const extracting = extractionPhase !== "idle";
  const attaching = isBusy(INTAKE_BUSY.attach);
  const controls = contractControls({ canExtract: flags.canExtract, hasFile: pick.file !== null, busy, extraction, attached: extractionAttached });
  const summary = extraction ? summarizeExtraction(extraction) : null;
  const announcement = extractionAnnouncement({ phase: extractionPhase, extraction, attached: extractionAttached, fileName: pick.file?.name ?? null });

  // After the person's own extraction finishes, move focus to the result so keyboard / screen-reader users land on it.
  const runRef = extraction?.run.runRef ?? null;
  useEffect(() => {
    if (!runRef || !focusResultRef.current) return;
    focusResultRef.current = false;
    resultRef.current?.focus();
  }, [runRef]);

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    setPick(pickContractFile(event.target.files?.[0]));
  };

  const onExtract = async () => {
    if (!pick.file || busy) return;
    focusResultRef.current = true;
    const result = await extractFromFile(pick.file);
    if (!result.ok) focusResultRef.current = false;
    else if (fileInputRef.current) fileInputRef.current.value = "";
    if (result.ok) setPick({ file: null, error: null });
  };

  const onAttach = async () => {
    if (!controls.canAttach) return;
    await attachExtraction();
  };

  const extractLabel = extractionPhase === "uploading" ? "Uploading…" : extractionPhase === "extracting" ? "Reading Agreement…" : "Extract from Agreement";

  return (
    <SectionCard sectionKey="contract_source" description={CONTRACT_SOURCE_COPY}>
      <div className="fields">
        {controls.showUpload && (
          <div className="field full">
            <label htmlFor={inputId}>Agreement PDF</label>
            <input ref={fileInputRef} id={inputId} type="file" accept="application/pdf,.pdf" onChange={onFile} disabled={busy} aria-describedby={pick.error ? `${hintId} ${errorId}` : hintId} aria-invalid={pick.error ? true : undefined} style={{ width: "100%" }} />
            <small id={hintId}>PDF only · up to 10 MB</small>
            {pick.error && (
              <small id={errorId} role="alert" style={{ color: "var(--red)" }}>
                {pick.error}
              </small>
            )}
            {pick.file && (
              <small data-testid="selected-file" style={{ overflowWrap: "anywhere" }}>
                Selected: <b>{pick.file.name}</b> · {formatFileSize(pick.file.size)}
              </small>
            )}
          </div>
        )}
      </div>

      {controls.showUpload && (
        <div className="actions" style={{ marginTop: 14, alignItems: "center" }}>
          <button type="button" className="btn primary" onClick={onExtract} disabled={!controls.canRun} aria-disabled={!controls.canRun} style={!controls.canRun ? DISABLED_BUTTON_STYLE : undefined} data-testid="extract-from-agreement">
            {extractLabel}
          </button>
          {!pick.file && !extracting && <small className="muted">Choose a PDF to enable extraction.</small>}
        </div>
      )}

      {/* Progress and results are announced politely; the region exists from the start so the first message is heard. */}
      <div role="status" aria-live="polite" style={announcement ? { marginTop: 12 } : { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)" }} data-testid="extraction-status">
        {announcement && <small style={{ color: announcement.tone === "warning" ? "#80623f" : undefined }}>{announcement.text}</small>}
      </div>

      {artifact && (
        <div className="scopebox" style={{ marginTop: 12 }} data-testid="contract-artifact">
          <b style={{ display: "block", marginBottom: 2, overflowWrap: "anywhere" }}>{artifact.fileName}</b>
          <span className="muted">
            PDF · {formatFileSize(artifact.sizeBytes)} · uploaded {formatInstant(artifact.uploadedAt)}
          </span>
        </div>
      )}

      {extraction && summary && (
        <div ref={resultRef} tabIndex={-1} style={{ marginTop: 14, outline: "none" }} data-testid="extraction-result">
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <b style={{ fontSize: 12 }}>Extraction result</b>
            <StatusChip chip={summary.chip} status={extraction.run.status} testId="extraction-status-chip" />
            <small className="muted">
              {extraction.run.pageCount} {extraction.run.pageCount === 1 ? "page" : "pages"} · {summary.proposalCount} {summary.proposalCount === 1 ? "value" : "values"} proposed
            </small>
          </div>
          {summary.scanMessage && (
            <div className="banner" role="status" style={{ margin: "10px 0 0" }}>
              <span>{summary.scanMessage}</span>
            </div>
          )}
          {summary.warnings.length > 0 && (
            <ul style={{ margin: "10px 0 0 18px", padding: 0, fontSize: 11, color: "var(--muted)", display: "grid", gap: 4 }} aria-label="Extraction warnings">
              {summary.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          {controls.showAttach && (
            <div className="actions" style={{ marginTop: 12, alignItems: "center" }}>
              <button type="button" className="btn primary" onClick={onAttach} disabled={!controls.canAttach} aria-disabled={!controls.canAttach} style={!controls.canAttach ? DISABLED_BUTTON_STYLE : undefined} data-testid="attach-extracted">
                {attaching ? "Attaching…" : "Attach extracted values to draft"}
              </button>
              <small className="muted">Adds the proposals to the draft as pending values. You decide each one below.</small>
            </div>
          )}
          {extractionAttached && (
            <p className="foundationnote" style={{ marginTop: 10 }} data-testid="extraction-attached">
              <StatusChip label="Attached as pending" tone="gray" /> The proposed values are in the draft. None of them is accepted until you decide it.
            </p>
          )}
        </div>
      )}

      <p className="foundationnote" style={{ marginTop: 14 }}>
        {summary?.note ?? "Extraction suggests values only. Review every field before confirming the Agreement."}
      </p>
      {!flags.canExtract && !extraction && !artifact && <p className="foundationnote">{flags.readOnlyReason ?? "No Agreement PDF has been added to this draft."}</p>}
    </SectionCard>
  );
}

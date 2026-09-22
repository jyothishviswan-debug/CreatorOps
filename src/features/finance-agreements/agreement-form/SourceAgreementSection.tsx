"use client";

// Step 14C.3, IA section 2 "Source Agreement": the exact original signed PDF, extraction, and a truthful, human-worded
// extraction result - no raw backend internals, no per-field breakdown here (that lives beside each field once it exists).
import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";

import { CONTRACT_SOURCE_COPY, DISABLED_BUTTON_STYLE, formatFileSize, formatInstant } from "../format";
import { extractionAnnouncement, pickContractFile, summarizeExtraction, contractControls, type FilePick } from "../agreement-intake-logic/contract-source-logic";
import { INTAKE_BUSY, useIntake } from "../agreement-intake-logic/intake-context";

import { SectionCard } from "./SectionCard";

export function SourceAgreementSection() {
  const intake = useIntake();
  const { flags, artifact, extraction, extractionAttached, extractionPhase, isBusy, extractFromFile, attachExtraction } = intake;
  const inputId = useId();
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

  const runRef = extraction?.run.runRef ?? null;
  useEffect(() => {
    if (!runRef || !focusResultRef.current) return;
    focusResultRef.current = false;
    resultRef.current?.focus();
  }, [runRef]);

  const onFile = (event: ChangeEvent<HTMLInputElement>) => setPick(pickContractFile(event.target.files?.[0]));

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
    <SectionCard sectionKey="source" title="Source Agreement" description={CONTRACT_SOURCE_COPY}>
      {controls.showUpload && (
        <div className="field">
          <label htmlFor={inputId}>Original signed Agreement PDF</label>
          <input ref={fileInputRef} id={inputId} type="file" accept="application/pdf,.pdf" onChange={onFile} disabled={busy} style={{ width: "100%" }} />
          <small>PDF only · up to 10 MB. This exact file is what gets stored - never a generated replacement.</small>
          {pick.error && (
            <small role="alert" style={{ color: "var(--red)" }}>
              {pick.error}
            </small>
          )}
          {pick.file && (
            <small style={{ overflowWrap: "anywhere" }}>
              Selected: <b>{pick.file.name}</b> · {formatFileSize(pick.file.size)}
            </small>
          )}
        </div>
      )}

      {controls.showUpload && (
        <div className="actions" style={{ marginTop: 12, alignItems: "center" }}>
          <button type="button" className="btn primary" onClick={onExtract} disabled={!controls.canRun} style={!controls.canRun ? DISABLED_BUTTON_STYLE : undefined}>
            {extractLabel}
          </button>
          {!pick.file && !extracting && <small className="muted">Choose a PDF to enable extraction.</small>}
        </div>
      )}

      <div role="status" aria-live="polite" style={{ marginTop: announcement ? 12 : 0 }}>
        {announcement && <small style={{ color: announcement.tone === "warning" ? "var(--orange)" : undefined }}>{announcement.text}</small>}
      </div>

      {artifact && (
        <div className="field" style={{ marginTop: 12 }}>
          <b style={{ overflowWrap: "anywhere", fontSize: 13 }}>{artifact.fileName}</b>
          <small className="muted">
            PDF · {formatFileSize(artifact.sizeBytes)} · uploaded {formatInstant(artifact.uploadedAt)}
          </small>
        </div>
      )}

      {extraction && summary && (
        <div ref={resultRef} tabIndex={-1} style={{ marginTop: 14, outline: "none" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <b style={{ fontSize: 13 }}>Extraction result</b>
            <small className="muted">
              {summary.chip.label} · {extraction.run.pageCount} {extraction.run.pageCount === 1 ? "page" : "pages"} · {summary.proposalCount} {summary.proposalCount === 1 ? "value" : "values"} proposed
            </small>
          </div>
          {summary.scanMessage && (
            <div className="banner" role="status" style={{ margin: "10px 0 0" }}>
              <span>{summary.scanMessage}</span>
            </div>
          )}
          {controls.showAttach && (
            <div className="actions" style={{ marginTop: 12, alignItems: "center" }}>
              <button type="button" className="btn primary" onClick={onAttach} disabled={!controls.canAttach} style={!controls.canAttach ? DISABLED_BUTTON_STYLE : undefined}>
                {attaching ? "Attaching…" : "Add proposed values to draft"}
              </button>
              <small className="muted">Adds the proposals to the draft as pending values, reviewed in Identity review and Agreement terms below. Nothing is accepted yet.</small>
            </div>
          )}
          {extractionAttached && <p className="foundationnote" style={{ marginTop: 10 }}>The proposed values are in the draft. None of them is accepted until you decide it, field by field, below.</p>}
        </div>
      )}

      <p className="foundationnote" style={{ marginTop: 14 }}>
        {summary?.note ?? "Extraction suggests values only. Review every field before confirming the Agreement."}
      </p>
      {!flags.canExtract && !extraction && !artifact && <p className="foundationnote">{flags.readOnlyReason ?? "No Agreement PDF has been added to this draft."}</p>}
    </SectionCard>
  );
}

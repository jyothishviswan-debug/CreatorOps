"use client";

// Onboarding wizard, step 1: the signed Agreement PDF and `Extract from Agreement` (an EPHEMERAL preview - nothing is saved), then the EXTRACTED
// AGREEMENT VALUES: what the reader found, each still needing a human decision. Identity details show as presence only. Extraction suggests
// values only.
import { useEffect, useId, useRef, type ChangeEvent } from "react";

import type { OnboardingPreviewDto } from "@/server/finance-agreements/onboarding-dto";

import { ConfidenceBadge } from "../../components/ConfidenceBadge";
import { StatusChip } from "../../components/StatusChip";
import { DISABLED_BUTTON_STYLE, formatFileSize, NEEDS_CONFIRMATION_LABEL, NO_VALUE_TEXT } from "../../format";
import { INTAKE_BUSY, useIntake } from "../intake-context";
import { useMediaQuery } from "../use-media-query";
import { ONBOARDING_STEP_ANCHORS } from "./onboarding-progress";
import { agreementFacts, commercialFoundLabels, detectedPlatformText, IDENTITY_FOUND_NOTE, identityFoundLines, previewAnnouncement, previewRows, safeSnippets, summarizePreview } from "./preview-view";
import { VISUALLY_HIDDEN, WizardBlock } from "./WizardBlock";

const WRAP = { overflowWrap: "anywhere", minWidth: 0 } as const;
// The four-column values table needs room; below this width each value is a stacked card (the accepted stylesheet has no table -> card rule).
const NARROW_QUERY = "(max-width: 700px)";

export function WizardUploadBlock() {
  const { onboarding, isBusy } = useIntake();
  const { state, gates } = onboarding;
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const focusResultRef = useRef(false);

  const previewing = state.preview.status === "loading" || isBusy(INTAKE_BUSY.onboardPreview);
  const busy = isBusy();
  const preview = state.preview.status === "ready" ? state.preview.data : null;
  const failure = state.preview.status === "error" ? state.preview.message : null;
  const summary = preview ? summarizePreview(preview) : null;
  const announcement = previewAnnouncement({ loading: previewing, preview, failure, fileName: state.file?.name ?? null });
  const runnable = gates.canPreview && !busy;
  const narrow = useMediaQuery(NARROW_QUERY) === true;

  // After the person's own extraction finishes, move focus to the result so keyboard / screen-reader users land on it.
  const previewStatus = state.preview.status;
  useEffect(() => {
    if (previewStatus !== "ready" || !focusResultRef.current) return;
    focusResultRef.current = false;
    resultRef.current?.focus();
  }, [previewStatus]);

  const onFile = (event: ChangeEvent<HTMLInputElement>) => onboarding.pickFile(event.target.files?.[0]);
  const onExtract = async () => {
    if (!runnable) return;
    focusResultRef.current = true;
    await onboarding.extractPreview();
  };

  return (
    <WizardBlock anchorId={ONBOARDING_STEP_ANCHORS.upload} number={1} title="Signed Agreement" description="Upload the signed Agreement to read the details it states. Nothing is saved or created at this step.">
      <div className="fields">
        <div className="field full">
          <label htmlFor={inputId}>Agreement PDF</label>
          <input ref={fileInputRef} id={inputId} type="file" accept="application/pdf,.pdf" onChange={onFile} disabled={busy || gates.locked} aria-describedby={state.fileError ? `${hintId} ${errorId}` : hintId} aria-invalid={state.fileError ? true : undefined} style={{ width: "100%" }} data-testid="onboarding-file" />
          <small id={hintId}>PDF only · up to 10 MB</small>
          {state.fileError && (
            <small id={errorId} role="alert" style={{ color: "var(--red)" }}>
              {state.fileError}
            </small>
          )}
          {state.file && (
            <small data-testid="onboarding-selected-file" style={WRAP}>
              Selected: <b>{state.file.name}</b> · {formatFileSize(state.file.size)}
            </small>
          )}
        </div>
      </div>

      <div className="actions" style={{ marginTop: 14, alignItems: "center" }}>
        <button type="button" className="btn primary" onClick={onExtract} disabled={!runnable} aria-disabled={!runnable} style={!runnable ? DISABLED_BUTTON_STYLE : undefined} data-testid="onboarding-extract">
          {previewing ? "Reading Agreement…" : "Extract from Agreement"}
        </button>
        {!state.file && !previewing && <small className="muted">Choose a PDF to enable extraction.</small>}
      </div>

      {/* Progress and results are announced politely; the region exists from the start so the first message is heard. */}
      <div role="status" aria-live="polite" style={announcement ? { marginTop: 12 } : VISUALLY_HIDDEN} data-testid="onboarding-preview-status">
        {announcement && <small style={{ color: announcement.tone === "warning" ? "#80623f" : announcement.tone === "error" ? "var(--red)" : undefined }}>{announcement.text}</small>}
      </div>

      {preview && summary && (
        <div ref={resultRef} tabIndex={-1} style={{ marginTop: 14, outline: "none" }} data-testid="onboarding-preview-result">
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <b style={{ fontSize: 12 }}>Extracted Agreement values</b>
            <StatusChip chip={summary.chip} status={preview.extraction.status} testId="onboarding-extraction-chip" />
            {summary.pageCount !== null && (
              <small className="muted">
                {summary.pageCount} {summary.pageCount === 1 ? "page" : "pages"}
              </small>
            )}
          </div>

          {summary.scanMessage && (
            <div className="banner" role="status" style={{ margin: "10px 0 0" }} data-testid="onboarding-scan-message">
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

          {summary.foundValues && narrow && (
            <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 8 }} aria-label="Values proposed from the Agreement for the new record" data-testid="onboarding-extracted-values">
              {previewRows(preview).map((row) => (
                <li key={row.key} data-field={row.key} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px", display: "grid", gap: 4, ...WRAP }}>
                  <b style={{ fontSize: 11, fontWeight: 550 }}>{row.label}</b>
                  {row.value !== null ? (
                    <>
                      <span style={WRAP}>{row.value}</span>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        <StatusChip label={NEEDS_CONFIRMATION_LABEL} tone="orange" />
                        {row.confidence && <ConfidenceBadge confidence={row.confidence} />}
                        {row.page !== null && <small className="muted">Page {row.page}</small>}
                      </div>
                      {row.warnings.length > 0 && (
                        <div style={{ fontSize: 10, color: "#80623f" }}>
                          <span aria-hidden="true">⚠ </span>
                          <span className="sr">Warning: </span>
                          {row.warnings.join(" ")}
                        </div>
                      )}
                      {row.key === "collaboratorPageLink" && detectedPlatformText(preview) && <div style={{ fontSize: 10 }}>{detectedPlatformText(preview)}</div>}
                    </>
                  ) : (
                    <span className="muted">Not found in the Agreement</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {summary.foundValues && !narrow && (
            <div className="tablewrap" style={{ border: "1px solid var(--line)", borderRadius: 8, marginTop: 10 }} data-testid="onboarding-extracted-values">
              <table className="compact">
                <caption className="sr">Values proposed from the Agreement for the new record. Each needs your confirmation.</caption>
                <thead>
                  <tr>
                    <th scope="col">Value</th>
                    <th scope="col">Found in the Agreement</th>
                    <th scope="col">Confidence</th>
                    <th scope="col">Page</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows(preview).map((row) => (
                    <tr key={row.key} data-field={row.key}>
                      <th scope="row" style={{ ...WRAP, background: "transparent", border: 0, borderBottom: "1px solid #edf0f3", color: "var(--ink)", fontWeight: 550, fontSize: 11, padding: "8px 18px", textAlign: "left" }}>
                        {row.label}
                      </th>
                      <td style={{ ...WRAP, maxWidth: 360 }}>
                        {row.value !== null ? (
                          <>
                            <span>{row.value}</span>
                            <div style={{ marginTop: 4 }}>
                              <StatusChip label={NEEDS_CONFIRMATION_LABEL} tone="orange" />
                            </div>
                            {row.warnings.length > 0 && (
                              <div style={{ marginTop: 4, fontSize: 10, color: "#80623f" }}>
                                <span aria-hidden="true">⚠ </span>
                                <span className="sr">Warning: </span>
                                {row.warnings.join(" ")}
                              </div>
                            )}
                            {row.key === "collaboratorPageLink" && detectedPlatformText(preview) && <div style={{ marginTop: 4, fontSize: 10 }}>{detectedPlatformText(preview)}</div>}
                          </>
                        ) : (
                          <span className="muted">Not found in the Agreement</span>
                        )}
                      </td>
                      <td>{row.confidence ? <ConfidenceBadge confidence={row.confidence} /> : NO_VALUE_TEXT}</td>
                      <td>{row.page ?? NO_VALUE_TEXT}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <AlsoFound preview={preview} />
          <p className="foundationnote" style={{ marginTop: 12 }}>
            {summary.note}
          </p>
        </div>
      )}
    </WizardBlock>
  );
}

// What else the Agreement states: its own number and dates, which commercial terms it covers (names only) and identity PRESENCE flags.
function AlsoFound({ preview }: { preview: OnboardingPreviewDto }) {
  const facts = agreementFacts(preview);
  const commercial = commercialFoundLabels(preview);
  const identity = identityFoundLines(preview);
  const snippets = safeSnippets(preview);
  if (facts.length === 0 && commercial.length === 0 && identity.length === 0 && snippets.length === 0) return null;
  return (
    <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
      {facts.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", columnGap: 24 }}>
          {facts.map((fact) => (
            <div className="kv" key={fact.label}>
              <span>{fact.label}</span>
              <b style={WRAP}>{fact.value}</b>
            </div>
          ))}
        </div>
      )}
      {commercial.length > 0 && (
        <div>
          <b style={{ fontSize: 11, fontWeight: 550 }}>Terms the Agreement states</b>
          <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "flex", gap: 6, flexWrap: "wrap" }} aria-label="Terms the Agreement states">
            {commercial.map((label) => (
              <li key={label}>
                <StatusChip label={label} tone="gray" />
              </li>
            ))}
          </ul>
          <small className="muted">They are reviewed on the Agreement once the record exists.</small>
        </div>
      )}
      {identity.length > 0 && (
        <div data-testid="onboarding-identity-found">
          <b style={{ fontSize: 11, fontWeight: 550 }}>Identity details</b>
          <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "flex", gap: 6, flexWrap: "wrap" }} aria-label="Identity details found in the Agreement">
            {identity.map((line) => (
              <li key={line}>
                <StatusChip label={line} tone="blue" />
              </li>
            ))}
          </ul>
          <small className="muted">{IDENTITY_FOUND_NOTE}</small>
        </div>
      )}
      {snippets.length > 0 && (
        <details>
          <summary style={{ fontSize: 10, cursor: "pointer" }}>Contract text</summary>
          <ul style={{ margin: "4px 0 0 18px", padding: 0, fontSize: 11, display: "grid", gap: 4 }}>
            {snippets.map((snippet) => (
              <li key={snippet.key} style={WRAP}>
                {snippet.page !== null ? `Page ${snippet.page}: ` : ""}
                {snippet.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

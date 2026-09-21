"use client";

import { useId, useState, type CSSProperties, type ReactNode } from "react";

import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import { ConfidenceBadge } from "../../components/ConfidenceBadge";
import { FieldDecisionControls } from "../../components/FieldDecisionControls";
import { SourceBadge } from "../../components/SourceBadge";
import { StatusChip } from "../../components/StatusChip";
import { fieldAnchorId } from "../../confirm-blockers";
import { confirmedFieldValue } from "../../field-values";
import type { FieldEditorKind } from "../../field-view-model";
import { DISABLED_BUTTON_STYLE, NEEDS_MAPPING_LABEL, decisionChip } from "../../format";
import { fieldBusyKey, useIntake } from "../intake-context";

import { resolveField } from "./commercial-logic";
import { FieldEditor } from "./FieldEditors";
import { hasValueEditor } from "./editor-state";
import { UNSAVED_CHIP, buildFieldRowView } from "./field-row-view";
import { valueLines } from "./value-lines";
import { useFieldEditor } from "./use-field-editor";

// Step 14B (intake): ONE registry field as a compact row - its label and status, what the Agreement holds now and where that came
// from, the unaccepted proposal (if any), the four decision controls, and the type-specific value editor when the person chooses
// to enter a value. Used by Commercial terms, Performance targets and Additional details. Raw markup, no new CSS classes.
const ROW_STYLE: CSSProperties = { borderTop: "1px solid #edf0f3", padding: "14px 0", display: "grid", gap: 8, minWidth: 0 };
const HEADER_STYLE: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, justifyContent: "space-between" };
const WRAP: CSSProperties = { overflowWrap: "anywhere", whiteSpace: "pre-wrap", margin: 0, fontSize: 12 };
const LONG_TEXT_LIMIT = 400;

export type FieldRowProps = {
  fieldKey: AgreementFieldKey;
  // A short note under the label (concise helper text).
  hint?: string;
  // Messages from rules that span fields (an amount needs a currency ...), shown under the row.
  notes?: readonly string[];
  // A rule that needs other fields (the termination date vs the effective date): a message or null.
  extraValidate?: (value: unknown) => string | null;
  // Replaces the plain list of value lines (targets add their `Monitoring only` statement per row).
  renderLines?: (lines: string[]) => ReactNode;
  // Text shown next to the controls.
  controlsNote?: string;
  // The value editor stays HIDDEN until the person states this (a checkbox with this label): used for LFC / SFC, which is recorded
  // only when the Agreement states the rule explicitly. Until then only Not applicable / Unavailable are offered.
  explicitGateLabel?: string;
};

function Lines({ lines }: { lines: string[] }) {
  return (
    <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
      {lines.map((line, index) =>
        line.length > LONG_TEXT_LIMIT ? (
          <details key={index}>
            <summary style={{ fontSize: 12, cursor: "pointer" }}>{`${line.slice(0, LONG_TEXT_LIMIT)}… Show full text`}</summary>
            <p style={{ ...WRAP, marginTop: 6 }}>{line}</p>
          </details>
        ) : (
          <p key={index} style={WRAP}>
            {line}
          </p>
        ),
      )}
    </div>
  );
}

export function FieldRow({ fieldKey, hint, notes, extraValidate, renderLines, controlsNote, explicitGateLabel }: FieldRowProps) {
  const intake = useIntake();
  const { getField, localEdits, flags, revisionDiff } = intake;
  const [open, setOpen] = useState(false);
  const [gateOpen, setGateOpen] = useState<boolean | null>(null);
  const gateId = useId();
  const model = getField(fieldKey);
  if (!model) return null;

  // A CONFIRMED version is frozen: show its confirmed terms (read-only) instead of the draft, which confirm clears.
  const frozenVersion = intake.version?.confirmed ? intake.version : null;
  if (frozenVersion) return <FrozenFieldRow fieldKey={fieldKey} label={model.label} version={frozenVersion} hint={hint} renderLines={renderLines} />;

  const pending = localEdits[fieldKey];
  const currencyResolved = resolveField("currency", getField("currency"), localEdits.currency);
  const currency = currencyResolved.state === "value" && typeof currencyResolved.value === "string" ? currencyResolved.value : null;
  const view = buildFieldRowView({ model, pending, currency, changes: revisionDiff });
  const editable = flags.canEdit;
  const pendingValue = pending !== undefined && pending.value !== undefined;
  // The explicit-rule gate is open once there is a value (saved, proposed or being typed) or the person ticked it.
  const gateIsOpen = gateOpen ?? (model.hasValue || pendingValue);
  const showEditor = editable && hasValueEditor(model.editorKind) && (open || pendingValue);
  const busy = intake.isBusy();
  const savingThis = intake.isBusy(fieldBusyKey(fieldKey));
  const entry = intake.getEntry(fieldKey);

  return (
    <div id={fieldAnchorId(fieldKey)} style={ROW_STYLE} data-field-row={fieldKey} aria-busy={savingThis || undefined}>
      <div style={HEADER_STYLE}>
        <span style={{ fontSize: 12, fontWeight: 600, minWidth: 0, overflowWrap: "anywhere" }}>
          {view.label}
          {view.requiredText && (
            <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 11 }}>
              {view.requiredText}
            </span>
          )}
        </span>
        <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <StatusChip chip={view.statusChip} status={pending?.decision ?? model.decision ?? "NONE"} />
          {view.unsaved && <StatusChip chip={UNSAVED_CHIP} />}
          {view.needsMapping && <StatusChip label={NEEDS_MAPPING_LABEL} tone="orange" />}
          {view.changedFromPrevious && <StatusChip label="Changed from previous version" tone="blue" />}
        </span>
      </div>

      {hint && <small className="muted">{hint}</small>}

      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        {renderLines && view.currentKind === "value" ? renderLines(view.currentLines) : <Lines lines={view.currentLines} />}
        <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {view.origin && <SourceBadge origin={view.origin} />}
          {view.sourceText && <small className="muted">{view.sourceText}</small>}
          {view.origin === "EXTRACTED" && view.page !== null && <small className="muted">{`page ${view.page}`}</small>}
          {view.origin === "EXTRACTED" && <ConfidenceBadge confidence={view.confidence} />}
        </span>
        {view.needsMapping && (
          <small style={{ color: "var(--orange)" }}>
            {view.extractedWording ? `The Agreement says “${view.extractedWording}”, which is not a supported unit. ` : ""}Choose Approved Content or Approved current link, or leave it Unavailable.
          </small>
        )}
        {view.agreementProposedLines && (
          <small className="muted" style={{ overflowWrap: "anywhere" }}>
            {`The Agreement proposed: ${view.agreementProposedLines.join("; ")}`}
          </small>
        )}
        {view.changedFromPrevious && (
          <small className="muted" style={{ overflowWrap: "anywhere" }}>
            {`Previous version: ${view.changedFromPrevious.beforeText}`}
          </small>
        )}
      </div>

      {editable && (
        <div style={{ display: "grid", gap: 6 }}>
          {explicitGateLabel && !gateIsOpen && (
            <div style={{ display: "grid", gap: 8 }}>
              <label htmlFor={`${gateId}-gate`} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12 }}>
                <input id={`${gateId}-gate`} type="checkbox" checked={false} disabled={busy} onChange={() => { setGateOpen(true); setOpen(true); }} style={{ marginTop: 2 }} />
                <span>{explicitGateLabel}</span>
              </label>
              <div className="segment" role="group" aria-label={`Decision for ${view.label}`} style={{ marginLeft: 0, flexWrap: "wrap", justifySelf: "start" }}>
                {(["NOT_APPLICABLE", "UNAVAILABLE"] as const).map((decision) => (
                  <button key={decision} type="button" className={(pending?.decision ?? model.decision) === decision ? "active" : undefined} aria-pressed={(pending?.decision ?? model.decision) === decision} disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} onClick={() => void intake.decideField({ fieldKey, decision })}>
                    {decision === "NOT_APPLICABLE" ? "Not applicable" : "Unavailable"}
                  </button>
                ))}
              </div>
            </div>
          )}
          {(!explicitGateLabel || gateIsOpen) && (
            <FieldDecisionControls
              fieldKey={fieldKey}
              label={view.label}
              decision={pending?.decision ?? model.decision}
              origin={model.origin}
              hasValue={view.canUseCandidate}
              busy={busy}
              showState={false}
              onDecide={(decision) => {
                setOpen(false);
                if (explicitGateLabel && decision !== "ACCEPTED") setGateOpen(false);
                void intake.decideField({ fieldKey, decision });
              }}
              onEnterValue={() => setOpen(true)}
            />
          )}
          {controlsNote && <small className="muted">{controlsNote}</small>}
        </div>
      )}

      {showEditor && (
        <FieldEditorPanel
          key={`${entry?.decidedAt ?? "none"}:${model.decision ?? "none"}`}
          fieldKey={fieldKey}
          label={view.label}
          kind={model.editorKind}
          currency={currency}
          extraValidate={extraValidate}
          busy={busy}
          onClose={() => setOpen(false)}
        />
      )}

      {notes && notes.length > 0 && (
        <div role="status" style={{ display: "grid", gap: 3 }}>
          {notes.map((note) => (
            <small key={note} style={{ color: "var(--red)" }}>
              {note}
            </small>
          ))}
        </div>
      )}
    </div>
  );
}

function FieldEditorPanel({ fieldKey, label, kind, currency, extraValidate, busy, onClose }: { fieldKey: AgreementFieldKey; label: string; kind: FieldEditorKind; currency: string | null; extraValidate?: (value: unknown) => string | null; busy: boolean; onClose: () => void }) {
  const editor = useFieldEditor({ fieldKey, kind, extraValidate });
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, display: "grid", gap: 10, background: "#fafbfc" }}>
      <FieldEditor fieldKey={fieldKey} kind={kind} label={label} state={editor.state} onChange={editor.update} onBlur={editor.commitNow} errors={editor.errors} disabled={busy} currency={currency} />
      <div className="actions">
        {/* onMouseDown keeps focus in the editor: the blur would commit the typed value, and the note that appears (`Recorded as ...`) can shift this
            button before the mouse is released - the click would then be lost. Keyboard activation is unaffected. */}
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          style={busy ? DISABLED_BUTTON_STYLE : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            void editor.saveNow().then((saved) => {
              if (saved) onClose();
            });
          }}
        >
          {`Save ${label.toLowerCase()}`}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          style={busy ? DISABLED_BUTTON_STYLE : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            editor.discard();
            onClose();
          }}
        >
          Cancel
        </button>
        <small className="muted">Or keep typing and use Save Draft to save everything at once.</small>
      </div>
    </div>
  );
}

type FrozenVersion = NonNullable<ReturnType<typeof useIntake>["version"]>;

// One field of a confirmed version: its frozen value, the decision that produced it and where it came from.
function FrozenFieldRow({ fieldKey, label, version, hint, renderLines }: { fieldKey: AgreementFieldKey; label: string; version: FrozenVersion; hint?: string; renderLines?: (lines: string[]) => ReactNode }) {
  const provenance = version.fieldProvenance?.[fieldKey] ?? null;
  const value = confirmedFieldValue(fieldKey, version.terms, version.contactSnapshot);
  const decision = provenance?.decision ?? null;
  const lines = decision === "UNAVAILABLE" ? ["Unavailable"] : decision === "NOT_APPLICABLE" ? ["Not applicable"] : valueLines(fieldKey, value, { currency: version.terms?.commercial.currency ?? null });
  return (
    <div id={fieldAnchorId(fieldKey)} style={ROW_STYLE} data-field-row={fieldKey}>
      <div style={HEADER_STYLE}>
        <span style={{ fontSize: 12, fontWeight: 600, minWidth: 0, overflowWrap: "anywhere" }}>{label}</span>
        <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <StatusChip label="Confirmed" tone="blue" />
          {decision && <StatusChip chip={decisionChip(decision)} status={decision} />}
        </span>
      </div>
      {hint && <small className="muted">{hint}</small>}
      {renderLines && decision !== "UNAVAILABLE" && decision !== "NOT_APPLICABLE" ? renderLines(lines) : <Lines lines={lines} />}
      {provenance && (
        <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <SourceBadge origin={provenance.origin} />
          {provenance.origin === "EXTRACTED" && provenance.provenance.page !== null && <small className="muted">{`page ${provenance.provenance.page}`}</small>}
        </span>
      )}
    </div>
  );
}

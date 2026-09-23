"use client";

// FINAL_BUILD_PROMPT Section 6: Screen 2 - Review & Verify, as a real comparison TABLE (Field | CreatorOps |
// Agreement | Final value | Status | Action), not a stack of boxed field-groups - the doc's own explicit ask,
// and a genuinely more scannable shape for "verify N extracted values against existing records" than a card
// per field. All of the underlying logic (grouping, the three-way Mismatch decision, the separate explicit
// master-data dialog, review-by-exception) is unchanged from the previous rebuild - reused as-is via
// buildCrossVerificationRows / groupCrossVerificationRows; only the presentation is new. A status legend sits in
// the panel head (Section 6 asks for the column meaning to be visible, not guessed from colour alone). Mobile
// (<=1050px) swaps the table for the same stacked comparison/decision cards used before (Section 6's own mobile
// rule: never squeeze the table horizontally).
import { useState } from "react";

import { buildCrossVerificationRows, type CrossVerificationAction, type CrossVerificationRow } from "../cross-verification";
import { buildMasterDataRequest, correctedValueSeed, groupCrossVerificationRows, validateCorrectedText, type CrossVerificationGroup } from "../agreement-intake-logic/cross-verification-ui";
import { useIntake } from "../agreement-intake-logic/intake-context";
import type { ChipSpec } from "../format";

import styles from "./AgreementCreatePage.module.css";

function legendOf(rows: readonly CrossVerificationRow[]): ChipSpec[] {
  const seen = new Map<string, ChipSpec>();
  for (const row of rows) if (!seen.has(row.stateChip.label)) seen.set(row.stateChip.label, row.stateChip);
  return [...seen.values()];
}

export function VerificationStep() {
  const { reconciliation, permissions } = useIntake();
  const rows = reconciliation ? buildCrossVerificationRows(reconciliation, { canManage: permissions.canManage }) : [];
  const groups = groupCrossVerificationRows(rows);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const legend = legendOf(rows);

  return (
    <section className="panel">
      <div className="panelhead">
        <div>
          <h2>Review &amp; Verify</h2>
          <p>Verify each field and correct if needed.</p>
        </div>
        {legend.length > 0 && (
          <div className={styles.legend}>
            {legend.map((chip) => (
              <span key={chip.label} className={`pill${chip.tone === "default" ? "" : ` ${chip.tone}`}`}>
                {chip.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="panelbody">
        {groups.length === 0 && <p className="muted">No reconciliation data yet - upload and extract the Agreement first.</p>}
        {groups.map((group) => (
          <VerificationGroupSection key={group.key} group={group} expanded={expanded[group.key] ?? false} onExpand={() => setExpanded((s) => ({ ...s, [group.key]: true }))} />
        ))}
      </div>
    </section>
  );
}

function VerificationGroupSection({ group, expanded, onExpand }: { group: CrossVerificationGroup; expanded: boolean; onExpand: () => void }) {
  const attention = group.rows.filter((r) => r.state === "MISMATCH" || r.state === "MISSING_IN_CREATOROPS" || r.needsResolution);
  const resolved = group.rows.filter((r) => !attention.includes(r));
  const visible = expanded ? group.rows : attention;

  return (
    <div style={{ marginBottom: 26 }}>
      <h3>{group.title}</h3>

      <div className={styles.verifyTable}>
        <div className="tablewrap" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>CreatorOps</th>
                <th>Agreement</th>
                <th>Final value</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <VerificationTableRow key={row.fieldKey} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={styles.verifyCards}>
        <div className="recordgrid" style={{ padding: 0, marginTop: 8 }}>
          {visible.map((row) => (
            <VerificationCard key={row.fieldKey} row={row} />
          ))}
        </div>
      </div>

      {resolved.length > 0 && !expanded && (
        <button type="button" className="btn ghost" style={{ marginTop: 8 }} onClick={onExpand}>
          Show all extracted fields ({resolved.length} matched/resolved)
        </button>
      )}
    </div>
  );
}

// The state and actions shared by the table row and the mobile card - only the markup differs.
function useVerificationRowController(row: CrossVerificationRow) {
  const { decideField, updateCounterpartyContact, applyExtractedKyc, isBusy, notify } = useIntake();
  const [correcting, setCorrecting] = useState(false);
  const [text, setText] = useState(() => correctedValueSeed(row));
  const [dialogAction, setDialogAction] = useState<CrossVerificationAction | null>(null);
  const [reason, setReason] = useState("");

  const run = async (action: CrossVerificationAction, value?: unknown) => {
    if (action.decision) {
      const result = await decideField({ fieldKey: row.fieldKey, decision: action.decision, value: value ?? action.value });
      if (!result.ok && !result.aborted) notify("error", result.message);
      return;
    }
    if (action.masterData) {
      const built = buildMasterDataRequest({ masterData: action.masterData }, { reason: action.masterData.requiresReason ? reason : null, expectedCounterpartyVersion: null });
      if (!built.ok) {
        notify("error", built.message);
        return;
      }
      const result = built.request.via === "contact" ? await updateCounterpartyContact(built.request.input) : await applyExtractedKyc(built.request.input);
      if (!result.ok && !result.aborted) notify("error", result.message);
      setDialogAction(null);
    }
  };

  const saveCorrected = () => {
    const checked = validateCorrectedText(row.fieldKey, text);
    if (!checked.ok) {
      notify("error", checked.errors[0]!);
      return;
    }
    void decideField({ fieldKey: row.fieldKey, decision: "CORRECTED", value: checked.value });
    setCorrecting(false);
  };

  return { correcting, setCorrecting, text, setText, dialogAction, setDialogAction, reason, setReason, run, saveCorrected, isBusy: isBusy() };
}

function ActionButtons({ row, ctrl }: { row: CrossVerificationRow; ctrl: ReturnType<typeof useVerificationRowController> }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {row.actions.map((action) =>
        action.kind === "ENTER_VALUE" ? (
          <button key={action.kind} type="button" className="btn" disabled={ctrl.isBusy} onClick={() => ctrl.setCorrecting(true)}>
            {action.label}
          </button>
        ) : action.requiresDialog ? (
          <button key={action.kind} type="button" className={`btn${action.primary ? " primary" : ""}`} disabled={ctrl.isBusy} onClick={() => ctrl.setDialogAction(action)}>
            {action.label}
          </button>
        ) : (
          <button key={action.kind} type="button" className={`btn${action.primary ? " primary" : ""}`} disabled={ctrl.isBusy} onClick={() => void ctrl.run(action)}>
            {action.label}
          </button>
        ),
      )}
    </div>
  );
}

function MasterDataDialogRow({ ctrl }: { ctrl: ReturnType<typeof useVerificationRowController> }) {
  if (!ctrl.dialogAction) return null;
  return (
    <div className="scopebox" style={{ marginTop: 8 }}>
      <p>{ctrl.dialogAction.label} on the Partner/Vendor record? This never happens automatically when you save the Agreement.</p>
      {ctrl.dialogAction.masterData?.requiresReason && <input value={ctrl.reason} onChange={(e) => ctrl.setReason(e.target.value)} placeholder="Reason" style={{ marginBottom: 8 }} />}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn primary" onClick={() => void ctrl.run(ctrl.dialogAction!)}>
          Confirm
        </button>
        <button type="button" className="btn ghost" onClick={() => ctrl.setDialogAction(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function CorrectionRow({ ctrl }: { ctrl: ReturnType<typeof useVerificationRowController> }) {
  if (!ctrl.correcting) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <input value={ctrl.text} onChange={(e) => ctrl.setText(e.target.value)} />
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button type="button" className="btn primary" onClick={ctrl.saveCorrected}>
          Save corrected value
        </button>
        <button type="button" className="btn ghost" onClick={() => ctrl.setCorrecting(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function VerificationTableRow({ row }: { row: CrossVerificationRow }) {
  const ctrl = useVerificationRowController(row);
  return (
    <>
      <tr style={row.highlight ? { boxShadow: "inset 3px 0 var(--red)" } : undefined}>
        <td><b>{row.label}</b></td>
        <td>
          {row.creatorOpsText}
          {row.creatorOpsNote && <><br /><small className="muted">{row.creatorOpsNote}</small></>}
        </td>
        <td>
          {row.agreementText}
          {row.agreementNote && <><br /><small className="muted">{row.agreementNote}</small></>}
        </td>
        <td>{row.confirmedText ?? "—"}</td>
        <td><span className={`pill${row.stateChip.tone === "default" ? "" : ` ${row.stateChip.tone}`}`}>{row.stateChip.label}</span></td>
        <td><ActionButtons row={row} ctrl={ctrl} /></td>
      </tr>
      {(ctrl.correcting || ctrl.dialogAction) && (
        <tr>
          <td colSpan={6} style={{ borderBottom: "1px solid #edf0f3" }}>
            <CorrectionRow ctrl={ctrl} />
            <MasterDataDialogRow ctrl={ctrl} />
          </td>
        </tr>
      )}
    </>
  );
}

function VerificationCard({ row }: { row: CrossVerificationRow }) {
  const ctrl = useVerificationRowController(row);
  return (
    <div className="record" style={{ borderColor: row.highlight ? "var(--red)" : undefined }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <b>{row.label}</b>
        <span className={`pill${row.stateChip.tone === "default" ? "" : ` ${row.stateChip.tone}`}`}>{row.stateChip.label}</span>
      </div>
      <div className="kv"><span>CreatorOps</span><b>{row.creatorOpsText}</b></div>
      <div className="kv"><span>Agreement</span><b>{row.agreementText}</b></div>
      {row.confirmedText && <div className="kv"><span>Final value</span><b>{row.confirmedText}</b></div>}
      <CorrectionRow ctrl={ctrl} />
      <div style={{ marginTop: 10 }}>
        <ActionButtons row={row} ctrl={ctrl} />
      </div>
      <MasterDataDialogRow ctrl={ctrl} />
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import type { FieldEditorKind } from "../../field-view-model";
import { buildLocalEdit, isRedundantEdit } from "../intake-logic";
import { useIntake } from "../intake-context";

import { editorStateToValue, initialEditorState, isEditorStateBlank, type FieldEditorState } from "./editor-state";

// Step 14B (intake): the local state of ONE open value editor and its bridge to the intake context.
//
// The editor keeps plain strings. After a short pause (or at once for a discrete control, or when focus leaves) the state is
// validated with the foundation validators and, when valid, BUFFERED with setLocalEdit - nothing is sent until the person saves the
// field or the draft. An invalid or blank state clears the buffered edit and shows its messages, so an invalid value can never be
// written. Cancel discards the edit; closing the editor never drops a pending, valid edit silently (it is committed first).
const COMMIT_DELAY_MS = 350;

export type UseFieldEditorOptions = {
  fieldKey: AgreementFieldKey;
  kind: FieldEditorKind;
  // A rule that needs other fields (the termination date vs the effective date): returns a message or null.
  extraValidate?: (value: unknown) => string | null;
};

export type FieldEditorHandle = {
  state: FieldEditorState;
  errors: string[];
  // A valid, non-blank value is ready to save.
  ready: boolean;
  update: (next: FieldEditorState, immediate?: boolean) => void;
  commitNow: () => void;
  // Validates, then writes THIS field immediately (an explicit save). Resolves true when the server accepted it.
  saveNow: () => Promise<boolean>;
  // Drops the buffered edit and any pending commit (the parent then closes the editor).
  discard: () => void;
};

export function useFieldEditor({ fieldKey, kind, extraValidate }: UseFieldEditorOptions): FieldEditorHandle {
  const { getField, getEntry, localEdits, setLocalEdit, clearLocalEdit, decideField } = useIntake();
  const model = getField(fieldKey);

  // Opens with the buffered edit if there is one, else the draft's own value (an unsupported qualifying unit opens blank).
  const [state, setState] = useState<FieldEditorState>(() => {
    const pending = localEdits[fieldKey];
    const source = pending && pending.value !== undefined ? pending.value : (model?.value ?? null);
    return initialEditorState(fieldKey, kind, source);
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  const stateRef = useRef(state);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const discarded = useRef(false);
  const extraRef = useRef(extraValidate);
  useEffect(() => {
    extraRef.current = extraValidate;
  });

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // Validate the CURRENT state; buffer it when valid. Returns the validated value (undefined when not ready).
  const validate = useCallback(
    (next: FieldEditorState, options: { showBlank: boolean }): { ok: true; value: unknown } | { ok: false } => {
      if (isEditorStateBlank(next)) {
        clearLocalEdit(fieldKey);
        setErrors(options.showBlank ? ["Enter a value, or choose Not applicable / Unavailable."] : []);
        setReady(false);
        return { ok: false };
      }
      const result = editorStateToValue(fieldKey, kind, next);
      const extra = result.ok ? (extraRef.current?.(result.value) ?? null) : null;
      if (!result.ok || extra) {
        clearLocalEdit(fieldKey);
        setErrors(result.ok ? [extra!] : result.errors);
        setReady(false);
        return { ok: false };
      }
      setErrors([]);
      setReady(true);
      const entry = getEntry(fieldKey);
      const edit = buildLocalEdit(fieldKey, result.value, entry);
      // A value the draft already holds (with the same decision) is not an edit.
      if (isRedundantEdit(edit, entry)) clearLocalEdit(fieldKey);
      else setLocalEdit(fieldKey, result.value, edit.decision);
      return { ok: true, value: result.value };
    },
    [clearLocalEdit, fieldKey, getEntry, kind, setLocalEdit],
  );

  const commitNow = useCallback(() => {
    clearTimer();
    validate(stateRef.current, { showBlank: false });
  }, [clearTimer, validate]);

  const update = useCallback(
    (next: FieldEditorState, immediate = false) => {
      stateRef.current = next;
      setState(next);
      clearTimer();
      if (immediate) validate(next, { showBlank: false });
      else timer.current = setTimeout(() => validate(stateRef.current, { showBlank: false }), COMMIT_DELAY_MS);
    },
    [clearTimer, validate],
  );

  // Closing the editor commits what is pending (unless the person discarded it).
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
        if (!discarded.current) validate(stateRef.current, { showBlank: false });
      }
    },
    [validate],
  );

  const saveNow = useCallback(async (): Promise<boolean> => {
    clearTimer();
    const checked = validate(stateRef.current, { showBlank: true });
    if (!checked.ok) return false;
    const entry = getEntry(fieldKey);
    const edit = buildLocalEdit(fieldKey, checked.value, entry);
    const result = await decideField({ fieldKey, decision: edit.decision, value: checked.value });
    if (!result.ok && !result.aborted) setErrors([result.message]);
    return result.ok;
  }, [clearTimer, decideField, fieldKey, getEntry, validate]);

  const discard = useCallback(() => {
    discarded.current = true;
    clearTimer();
    clearLocalEdit(fieldKey);
  }, [clearLocalEdit, clearTimer, fieldKey]);

  return useMemo(() => ({ state, errors, ready, update, commitNow, saveNow, discard }), [state, errors, ready, update, commitNow, saveNow, discard]);
}

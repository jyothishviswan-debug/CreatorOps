"use client";

// Step 14B: a searchable single-select (ARIA 1.2 combobox + listbox) for choosing ONE record from a server-side,
// scope-first search (the Partner / Vendor picker of the Agreement intake). Built from the accepted pieces of the
// Analytics / Partner Reviews selectors: the `.inputwrap` field + the `.searchresults` listbox + a `foundationnote`
// status line - NO new global CSS.
//
// Behavior (the pure parts are unit-tested in combobox-logic.ts):
//   - typing searches through `loadOptions` (debounced; the previous request's AbortSignal is aborted and a
//     stale response can never overwrite a newer one);
//   - keyboard: ArrowDown / ArrowUp move (ArrowDown opens), Enter picks the highlighted option, Escape closes
//     the list without leaving the field; focus ALWAYS stays in the input (aria-activedescendant);
//   - the dropdown is bounded and scrolls inside itself (never grows the page);
//   - loading / empty / error rows are announced through a polite status line; an error row offers "Try again".
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { DISABLED_BUTTON_STYLE } from "../format";

import { comboboxInputText, comboboxKeyAction, comboboxStatusText, createRequestGate, shouldSearch, type ComboboxOption, type ComboboxSearchResult, type ComboboxStatus } from "./combobox-logic";

export type { ComboboxOption, ComboboxSearchResult } from "./combobox-logic";

export type ComboboxProps = {
  // Accessible name of the field (also the placeholder's default subject).
  label: string;
  // Singular noun for status copy: "Partner" -> "No matching Partners in your authorized scope".
  noun: string;
  value: ComboboxOption | null;
  onChange: (option: ComboboxOption | null) => void;
  // Async, server-side options. Receives the trimmed query and an AbortSignal that fires when the request is stale.
  loadOptions: (query: string, signal: AbortSignal) => Promise<ComboboxSearchResult>;
  placeholder?: string;
  // Minimum trimmed characters before a search runs (0 = list on open). Default 0.
  minChars?: number;
  debounceMs?: number;
  disabled?: boolean;
  // Show a clear (x) button while a value is selected. Default true.
  clearable?: boolean;
  // Max height of the dropdown list in px. Default 240.
  maxListHeight?: number;
  id?: string;
  "aria-describedby"?: string;
};

export function Combobox({ label, noun, value, onChange, loadOptions, placeholder, minChars = 0, debounceMs = 250, disabled = false, clearable = true, maxListHeight = 240, id, "aria-describedby": describedBy }: ComboboxProps) {
  const generatedId = useId();
  const baseId = id ?? generatedId;
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const gateRef = useRef(createRequestGate());
  const loadRef = useRef(loadOptions);
  const inputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<ComboboxOption[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<ComboboxStatus>("idle");
  const [errorText, setErrorText] = useState<string | undefined>(undefined);
  const [active, setActive] = useState(-1);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    loadRef.current = loadOptions;
  });

  const trimmed = query.trim();
  const searchable = shouldSearch(trimmed, minChars);
  const shownOptions = open && searchable ? options : [];
  const enabledIndexes = shownOptions.flatMap((option, index) => (option.disabled ? [] : [index]));

  useEffect(() => {
    if (!open || !searchable) return;
    const controller = new AbortController();
    const gate = gateRef.current;
    const token = gate.next();
    const timer = setTimeout(
      async () => {
        let result: ComboboxSearchResult;
        try {
          result = await loadRef.current(trimmed, controller.signal);
        } catch {
          result = { ok: false };
        }
        if (controller.signal.aborted || !gate.isCurrent(token)) return;
        if (!result.ok) {
          setOptions([]);
          setHasMore(false);
          setErrorText(result.message);
          setStatus("error");
          return;
        }
        setOptions(result.options);
        setHasMore(result.hasMore === true);
        setActive(-1);
        setStatus("ready");
      },
      trimmed.length === 0 ? 0 : debounceMs,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
      gate.invalidate();
    };
  }, [open, searchable, trimmed, debounceMs, retry]);

  function close() {
    setOpen(false);
    setEditing(false);
    setQuery("");
    setActive(-1);
  }

  function choose(option: ComboboxOption) {
    if (option.disabled) return;
    onChange(option);
    close();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const action = comboboxKeyAction(event.key, { open, activeIndex: active, optionCount: shownOptions.length, enabledIndexes });
    if (action.type === "none") return;
    event.preventDefault();
    if (action.type === "open") {
      setOpen(true);
      if (searchable) setStatus("loading");
      setActive(action.activeIndex);
    } else if (action.type === "move") {
      setActive(action.activeIndex);
    } else if (action.type === "select") {
      const option = shownOptions[action.activeIndex];
      if (option) choose(option);
    } else if (action.type === "close") {
      // The Escape belongs to the list (not to an enclosing dialog) while it is open.
      event.stopPropagation();
      close();
    }
  }

  const statusText = comboboxStatusText({ status, optionCount: shownOptions.length, hasMore, noun, belowMinChars: !searchable, minChars, errorText });
  const showClear = clearable && value !== null && !disabled;

  return (
    <div style={{ position: "relative", minWidth: 0 }} data-combobox={noun}>
      <div className="inputwrap" style={{ maxWidth: "none" }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <circle cx="10" cy="10" r="6" />
          <path d="m15 15 6 6" />
        </svg>
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-label={label}
          aria-describedby={describedBy}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
          autoComplete="off"
          disabled={disabled}
          placeholder={placeholder ?? `Search ${noun}s by name…`}
          value={comboboxInputText({ editing, query, selectedLabel: value?.label ?? null })}
          style={{ paddingRight: showClear ? 32 : undefined, ...(disabled ? { cursor: "not-allowed" } : {}) }}
          onChange={(event) => {
            setEditing(true);
            setQuery(event.target.value);
            setOpen(true);
            setActive(-1);
            if (shouldSearch(event.target.value.trim(), minChars)) setStatus("loading");
          }}
          onFocus={() => {
            if (disabled) return;
            setOpen(true);
            if (shouldSearch("", minChars)) setStatus("loading");
          }}
          onBlur={close}
          onKeyDown={onKeyDown}
        />
        {showClear && (
          <button
            type="button"
            aria-label={`Clear ${noun}`}
            onClick={() => {
              onChange(null);
              close();
              inputRef.current?.focus();
            }}
            style={{ position: "absolute", right: 6, top: 6, padding: "0 6px", fontSize: 15, lineHeight: "22px", color: "var(--muted)" }}
          >
            ×
          </button>
        )}
      </div>
      {open && (
        <div
          onMouseDown={(event) => event.preventDefault()}
          style={{ position: "absolute", zIndex: 5, left: 0, right: 0, background: "white", border: "1px solid var(--line)", borderRadius: 8, padding: 6, marginTop: 4, boxShadow: "var(--shadow)" }}
        >
          <div id={listId} role="listbox" aria-label={`${noun} search results`} className="searchresults" style={{ marginTop: 0, maxHeight: maxListHeight, overflowY: "auto" }}>
            {shownOptions.map((option, index) => (
              <button
                key={option.id}
                id={optionId(index)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={value?.id === option.id}
                aria-disabled={option.disabled || undefined}
                onClick={() => choose(option)}
                style={{ display: "block", width: "100%", minWidth: 0, overflowWrap: "anywhere", background: index === active ? "var(--tint)" : undefined, ...(option.disabled ? DISABLED_BUTTON_STYLE : {}) }}
              >
                <b style={{ display: "block" }}>{option.label}</b>
                {option.description && <small className="muted">{option.description}</small>}
              </button>
            ))}
          </div>
          <p className="foundationnote" role="status" style={{ margin: "6px 0 0" }}>
            {statusText}
            {status === "error" && searchable && (
              <>
                {" "}
                <button
                  type="button"
                  className="textlink"
                  onClick={() => {
                    setStatus("loading");
                    setRetry((count) => count + 1);
                  }}
                >
                  Try again
                </button>
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

// Step 14B: the pure behavior of the searchable single-select Combobox (ARIA 1.2 combobox + listbox with
// aria-activedescendant, focus staying in the input). Everything decidable without a DOM lives here so it can
// be unit-tested: the keyboard state machine, the status line, the stale-request gate and the search trigger.

export type ComboboxOption = { id: string; label: string; description?: string; disabled?: boolean };

export type ComboboxSearchResult = { ok: true; options: ComboboxOption[]; hasMore?: boolean } | { ok: false; message?: string };

// --- Keyboard ---------------------------------------------------------------------------------------------------------------------
export type ComboboxKeyState = { open: boolean; activeIndex: number; optionCount: number; enabledIndexes?: readonly number[] };

export type ComboboxKeyAction =
  | { type: "none" }
  | { type: "open"; activeIndex: number; preventDefault: true }
  | { type: "close"; preventDefault: true }
  | { type: "move"; activeIndex: number; preventDefault: true }
  | { type: "select"; activeIndex: number; preventDefault: true };

const NONE: ComboboxKeyAction = { type: "none" };

// The next enabled option index in a direction; never wraps (ArrowDown stops on the last, ArrowUp on the first).
// `enabledIndexes` (ascending) lets disabled options be skipped; absent = every option is enabled.
export function stepActiveIndex(current: number, direction: 1 | -1, optionCount: number, enabledIndexes?: readonly number[]): number {
  if (optionCount <= 0) return -1;
  const enabled = enabledIndexes ?? Array.from({ length: optionCount }, (_, index) => index);
  if (enabled.length === 0) return -1;
  if (direction === 1) return enabled.find((index) => index > current) ?? (enabled.includes(current) ? current : enabled[enabled.length - 1]!);
  if (current < 0) return enabled[0]!;
  const previous = [...enabled].reverse().find((index) => index < current);
  return previous ?? (enabled.includes(current) ? current : enabled[0]!);
}

// ArrowDown opens a closed list (highlighting the first enabled option) and then moves down; ArrowUp moves up;
// Enter selects the highlighted option (and only then swallows the key, so a surrounding form is not submitted
// by an Enter that chose nothing); Escape closes an open list (and only then swallows the key, so an enclosing
// dialog is not closed by it). Every other key is left to the text input.
export function comboboxKeyAction(key: string, state: ComboboxKeyState): ComboboxKeyAction {
  const { open, activeIndex, optionCount, enabledIndexes } = state;
  if (key === "ArrowDown") {
    if (!open) return { type: "open", activeIndex: optionCount > 0 ? stepActiveIndex(-1, 1, optionCount, enabledIndexes) : -1, preventDefault: true };
    return { type: "move", activeIndex: stepActiveIndex(activeIndex, 1, optionCount, enabledIndexes), preventDefault: true };
  }
  if (key === "ArrowUp") {
    if (!open) return NONE;
    return { type: "move", activeIndex: stepActiveIndex(activeIndex, -1, optionCount, enabledIndexes), preventDefault: true };
  }
  if (key === "Enter") {
    if (open && activeIndex >= 0 && activeIndex < optionCount && (!enabledIndexes || enabledIndexes.includes(activeIndex))) return { type: "select", activeIndex, preventDefault: true };
    return NONE;
  }
  if (key === "Escape") return open ? { type: "close", preventDefault: true } : NONE;
  return NONE;
}

// --- Search trigger / status line -----------------------------------------------------------------------------------------------------
// A search runs only once the trimmed query reaches `minChars` (0 = list on open).
export function shouldSearch(query: string, minChars: number): boolean {
  return query.trim().length >= Math.max(0, minChars);
}

export type ComboboxStatus = "idle" | "loading" | "ready" | "error";

// The polite status line under the list ("Searching…", "No matching Partners ...", "Showing the first N ...").
export function comboboxStatusText(input: { status: ComboboxStatus; optionCount: number; hasMore: boolean; noun: string; belowMinChars?: boolean; minChars?: number; errorText?: string }): string {
  const { status, optionCount, hasMore, noun, belowMinChars, minChars, errorText } = input;
  if (belowMinChars) return `Type at least ${minChars ?? 1} character${(minChars ?? 1) === 1 ? "" : "s"} to search`;
  if (status === "loading") return "Searching…";
  if (status === "error") return errorText ?? `Couldn’t search ${noun}s. Try again.`;
  if (status === "ready" && optionCount === 0) return `No matching ${noun}s in your authorized scope`;
  if (status === "ready" && hasMore) return `Showing the first ${optionCount} matches — keep typing to narrow`;
  if (status === "ready") return `${optionCount} ${noun}${optionCount === 1 ? "" : "s"} found`;
  return "";
}

// --- Stale-request gate -----------------------------------------------------------------------------------------------------------------
// Each search takes a token; only the LATEST token may commit its result. (The component also aborts the previous
// request's AbortSignal - this gate is the belt to that pair of braces, and what the unit tests exercise.)
export type RequestGate = { next: () => number; isCurrent: (token: number) => boolean; invalidate: () => void };

export function createRequestGate(): RequestGate {
  let latest = 0;
  return {
    next: () => ++latest,
    isCurrent: (token) => token === latest,
    invalidate: () => {
      latest += 1;
    },
  };
}

// The text an input shows: while the user is editing, their query; otherwise the selected option's label.
export function comboboxInputText(input: { editing: boolean; query: string; selectedLabel: string | null }): string {
  return input.editing ? input.query : (input.selectedLabel ?? "");
}

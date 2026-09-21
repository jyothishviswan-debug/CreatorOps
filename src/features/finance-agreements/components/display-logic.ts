import { RESTRICTED_VALUE_TEXT, type PillTone } from "../format";

// Step 14B: the pure rules behind the small presentational components (kept out of the .tsx files so they
// are unit-testable without a DOM).

// The class list of a status chip: the existing `.pill` + tone class (default tone = the green base style).
export function pillClassName(tone: PillTone | undefined): string {
  return tone === undefined || tone === "default" ? "pill" : `pill ${tone}`;
}

// A restricted value is NEVER rendered: whatever the caller passes as `value` is ignored when `restricted`.
// Returns the text to show and whether it is masked.
export function resolveMaskedValue(input: { restricted: boolean; value?: string | number | null; emptyText?: string; restrictedText?: string }): { text: string; masked: boolean } {
  if (input.restricted) return { text: input.restrictedText ?? RESTRICTED_VALUE_TEXT, masked: true };
  const value = input.value;
  if (value === null || value === undefined || (typeof value === "string" && value.trim().length === 0)) return { text: input.emptyText ?? "—", masked: false };
  return { text: String(value), masked: false };
}

export type ChipListItem = string | { label: string; tone?: PillTone };

// Windowing for a chip list: at most `max` chips, the rest summarized as "+N more".
export function chipListWindow(items: readonly ChipListItem[], max: number): { visible: Array<{ label: string; tone?: PillTone }>; hiddenCount: number } {
  const normalized = items.map((item) => (typeof item === "string" ? { label: item } : item));
  const limit = Math.max(0, Math.floor(max));
  return { visible: normalized.slice(0, limit), hiddenCount: Math.max(0, normalized.length - limit) };
}

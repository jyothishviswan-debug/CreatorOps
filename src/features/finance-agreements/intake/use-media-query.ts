"use client";

import { useSyncExternalStore } from "react";

// Step 14B (intake): a tiny SSR-safe media-query hook. The Cross-verification section is a table on wide screens and stacked
// cards on narrow ones; the accepted stylesheet has no table -> card rule, so the switch is made here (no new global CSS).
// The server snapshot is `null` = "not known yet": the section renders a neutral placeholder for that first frame instead of guessing a
// layout (a wrong guess was a visible flash - stacked cards, then the table - and it re-created every control, dropping keyboard focus).
// The browser value takes over right after hydration.
export function useMediaQuery(query: string): boolean | null {
  return useSyncExternalStore<boolean | null>(
    (onChange) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false),
    () => null,
  );
}

// >= 1051px: the width at which the four-column comparison table is comfortably usable.
export const WIDE_TABLE_QUERY = "(min-width: 1051px)";
export const useWideTableLayout = (): boolean | null => useMediaQuery(WIDE_TABLE_QUERY);

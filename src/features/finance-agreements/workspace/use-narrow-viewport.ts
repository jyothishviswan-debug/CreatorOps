"use client";

import { useSyncExternalStore } from "react";

// The width at and below which the workspace defaults to stacked cards (the accepted <= 760px breakpoint of the shell).
export const NARROW_VIEWPORT_QUERY = "(max-width: 760px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const list = window.matchMedia(NARROW_VIEWPORT_QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW_VIEWPORT_QUERY).matches : false;
}

// Server / hydration snapshot: NOT KNOWN (null). The list renders a neutral placeholder for that first frame instead of guessing: a
// guessed table on a phone (then cards) or cards on a desktop (then the table) is a visible flash and re-creates every row. The browser
// value takes over right after hydration (useSyncExternalStore reconciles the difference without a hydration mismatch).
function getServerSnapshot(): boolean | null {
  return null;
}

export function useNarrowViewport(): boolean | null {
  return useSyncExternalStore<boolean | null>(subscribe, getSnapshot, getServerSnapshot);
}

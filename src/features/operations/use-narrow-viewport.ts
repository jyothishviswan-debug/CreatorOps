"use client";

import { useSyncExternalStore } from "react";

// Mirrors src/features/finance-payments/workspace/use-narrow-viewport.ts exactly (the accepted
// <=760px breakpoint at which every workspace in this app switches from a table to stacked cards).
// Shared here rather than re-implemented per Operations feature.
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

function getServerSnapshot(): boolean | null {
  return null;
}

export function useNarrowViewport(): boolean | null {
  return useSyncExternalStore<boolean | null>(subscribe, getSnapshot, getServerSnapshot);
}

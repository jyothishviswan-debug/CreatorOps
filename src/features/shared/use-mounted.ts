"use client";

import { useSyncExternalStore } from "react";

// Production hardening (base spec section 26): the shared, React-idiomatic way to know "has this
// component finished its first client (post-hydration) render" without ever causing a
// server/client markup mismatch. Mirrors the same useSyncExternalStore shape already established by
// @/features/operations/use-narrow-viewport.ts (and its sibling copies) for the identical class of
// problem - a value that is legitimately different between the server render and the browser.
//
// getSnapshot returns the constant `true` (never a fresh/changing value on every call - that would
// cause useSyncExternalStore's own tearing-consistency check to re-render forever, which is exactly
// why this hook does NOT just return `new Date()` or similar directly). getServerSnapshot returns
// `false`, which both the real SSR pass and React's hydration reconciliation use for the very first
// client render - so that first render is always guaranteed to match the server's HTML byte-for-byte
// on this value, eliminating the mismatch. Once hydration completes, React re-renders with the true
// client snapshot (`true`), and everything gated on `useMounted()` becomes live from then on -
// exactly the same two-phase shape React's own docs recommend for this exact class of hydration risk.
function subscribe(): () => void {
  return () => undefined;
}

function getSnapshot(): boolean {
  return true;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useMounted(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// Step 14C section 3: a neutral, module-agnostic registry of Partner / Vendor DEPENDENCY GUARDS.
//
// The owning modules (Partners, Vendors) decide whether a Partner / Vendor may be archived or blacklisted. Other modules (today:
// Finance Agreements) hold records that must not be orphaned by that decision, but the owning modules must NOT import them
// (Finance already depends on Partners / Vendors; the reverse edge would be a cycle and would break their boundary tests). This
// registry is the seam: the owning lifecycle services call `checkCounterpartyDependencyGuards` from inside their existing
// dependency check, and the server composition point (`registerServerProviders`) registers each dependent module's guard.
//
// Vocabulary (identical to the owning modules' own dependency result): `clear` | `blocked` | `unknown`. UNKNOWN BLOCKS - a guard
// that cannot prove the counterparty is safe (lookup failure, bad shape, thrown error) never yields `clear`.
//
// The registry is backed by a `globalThis` slot (Symbol.for) so that it is one registry per server process even when the bundler
// gives the instrumentation hook and the route handlers separate module instances. It is EMPTY by default: with nothing
// registered the aggregate is `clear`, so the owning modules' own suites behave exactly as before.

export type GuardedCounterpartyType = "PARTNER" | "VENDOR";
export type CounterpartyDependencyAction = "archive" | "blacklist";

export type CounterpartyDependencyGuardResult = { status: "clear" } | { status: "blocked"; reason: string } | { status: "unknown"; reason?: string };

export type CounterpartyDependencyGuard = {
  // Stable identity: registering the SAME id again REPLACES the earlier registration (HMR-safe, idempotent composition).
  id: string;
  counterpartyType: GuardedCounterpartyType;
  // `ref` is the counterparty's own partnerRef / vendorRef. `context.action` lets a guard word its reason precisely.
  check: (ref: string, context: { action: CounterpartyDependencyAction }) => Promise<CounterpartyDependencyGuardResult>;
};

export type CounterpartyDependencyGuardsOutcome = { status: "clear" | "blocked" | "unknown"; reasons: string[] };

const REGISTRY_KEY = Symbol.for("creatorops.shared.counterpartyDependencyGuards");
const MAX_REASONS = 5;
const MAX_REASON_LENGTH = 300;
const UNKNOWN_REASON = "A dependency lookup failed - cannot confirm this record is safe to archive or blacklist.";

type GlobalWithRegistry = typeof globalThis & { [REGISTRY_KEY]?: Map<string, CounterpartyDependencyGuard> };

function registry(): Map<string, CounterpartyDependencyGuard> {
  const holder = globalThis as GlobalWithRegistry;
  holder[REGISTRY_KEY] ??= new Map();
  return holder[REGISTRY_KEY];
}

export function registerCounterpartyDependencyGuard(guard: CounterpartyDependencyGuard): void {
  if (!guard.id || (guard.counterpartyType !== "PARTNER" && guard.counterpartyType !== "VENDOR") || typeof guard.check !== "function") {
    throw new Error("A counterparty dependency guard needs an id, a PARTNER|VENDOR counterpartyType and a check function.");
  }
  registry().set(guard.id, guard);
}

export function unregisterCounterpartyDependencyGuard(id: string): void {
  registry().delete(id);
}

export function listCounterpartyDependencyGuardIds(): string[] {
  return [...registry().keys()].sort();
}

// Test seam only (the owning modules' suites run with an empty registry; a suite that registers guards clears them afterwards).
export function clearCounterpartyDependencyGuardsForTests(): void {
  registry().clear();
}

function boundedReason(reason: unknown, fallback: string): string {
  const text = typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : fallback;
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 1)}…` : text;
}

// Runs every guard registered for the counterparty type and aggregates: `blocked` if any guard blocks, else `unknown` if any guard
// is unknown / throws / returns an unrecognised shape, else `clear`. Reasons of every non-clear guard are kept (deduplicated,
// bounded). NEVER throws - a misbehaving guard degrades to `unknown`, which blocks.
export async function checkCounterpartyDependencyGuards(counterpartyType: GuardedCounterpartyType, ref: string, context: { action: CounterpartyDependencyAction }): Promise<CounterpartyDependencyGuardsOutcome> {
  const guards = [...registry().values()].filter((guard) => guard.counterpartyType === counterpartyType).sort((a, b) => a.id.localeCompare(b.id));
  const outcomes = await Promise.all(
    guards.map(async (guard): Promise<CounterpartyDependencyGuardResult> => {
      try {
        const result = await guard.check(ref, context);
        if (result && result.status === "clear") return { status: "clear" };
        if (result && result.status === "blocked") return { status: "blocked", reason: boundedReason(result.reason, "This record has a dependency that must be resolved first.") };
        if (result && result.status === "unknown") return { status: "unknown", reason: boundedReason(result.reason, UNKNOWN_REASON) };
        return { status: "unknown", reason: UNKNOWN_REASON };
      } catch {
        return { status: "unknown", reason: UNKNOWN_REASON };
      }
    }),
  );

  const reasons: string[] = [];
  const add = (reason: string | undefined) => {
    if (reason && !reasons.includes(reason) && reasons.length < MAX_REASONS) reasons.push(reason);
  };
  for (const outcome of outcomes) if (outcome.status === "blocked") add(outcome.reason);
  for (const outcome of outcomes) if (outcome.status === "unknown") add(outcome.reason);

  const status = outcomes.some((outcome) => outcome.status === "blocked") ? "blocked" : outcomes.some((outcome) => outcome.status === "unknown") ? "unknown" : "clear";
  return { status, reasons };
}

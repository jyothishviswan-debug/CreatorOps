import { afterEach, describe, expect, it } from "vitest";

import {
  checkCounterpartyDependencyGuards,
  type CounterpartyDependencyGuard,
  clearCounterpartyDependencyGuardsForTests,
  listCounterpartyDependencyGuardIds,
  registerCounterpartyDependencyGuard,
  unregisterCounterpartyDependencyGuard,
  type CounterpartyDependencyGuardResult,
} from "./counterparty-dependency-guards";

const ARCHIVE = { action: "archive" } as const;
const guard = (id: string, counterpartyType: "PARTNER" | "VENDOR", result: CounterpartyDependencyGuardResult | CounterpartyDependencyGuard["check"]): CounterpartyDependencyGuard => ({
  id,
  counterpartyType,
  check: typeof result === "function" ? result : async () => result,
});

afterEach(() => clearCounterpartyDependencyGuardsForTests());

describe("counterparty dependency guard registry", () => {
  it("is empty by default and an empty registry is clear", async () => {
    expect(listCounterpartyDependencyGuardIds()).toEqual([]);
    expect(await checkCounterpartyDependencyGuards("PARTNER", "p-1", ARCHIVE)).toEqual({ status: "clear", reasons: [] });
  });

  it("aggregates clear / blocked / unknown with blocked > unknown > clear precedence and keeps every non-clear reason", async () => {
    registerCounterpartyDependencyGuard(guard("a", "PARTNER", { status: "clear" }));
    expect(await checkCounterpartyDependencyGuards("PARTNER", "p-1", ARCHIVE)).toEqual({ status: "clear", reasons: [] });

    registerCounterpartyDependencyGuard(guard("b", "PARTNER", { status: "unknown", reason: "could not look" }));
    expect(await checkCounterpartyDependencyGuards("PARTNER", "p-1", ARCHIVE)).toEqual({ status: "unknown", reasons: ["could not look"] });

    registerCounterpartyDependencyGuard(guard("c", "PARTNER", { status: "blocked", reason: "has an Agreement" }));
    expect(await checkCounterpartyDependencyGuards("PARTNER", "p-1", ARCHIVE)).toEqual({ status: "blocked", reasons: ["has an Agreement", "could not look"] });
  });

  it("only runs guards registered for that counterparty type, and passes the ref and the action through", async () => {
    const seen: Array<[string, string]> = [];
    registerCounterpartyDependencyGuard(guard("p", "PARTNER", async (ref, context) => (seen.push([ref, context.action]), { status: "blocked", reason: "partner-only" })));
    registerCounterpartyDependencyGuard(guard("v", "VENDOR", { status: "clear" }));
    expect(await checkCounterpartyDependencyGuards("VENDOR", "v-1", ARCHIVE)).toEqual({ status: "clear", reasons: [] });
    expect(seen).toEqual([]);
    expect((await checkCounterpartyDependencyGuards("PARTNER", "p-9", { action: "blacklist" })).status).toBe("blocked");
    expect(seen).toEqual([["p-9", "blacklist"]]);
  });

  it("re-registering the same id REPLACES the earlier guard (idempotent composition); unregister removes it", async () => {
    registerCounterpartyDependencyGuard(guard("same", "PARTNER", { status: "blocked", reason: "old" }));
    registerCounterpartyDependencyGuard(guard("same", "PARTNER", { status: "clear" }));
    expect(listCounterpartyDependencyGuardIds()).toEqual(["same"]);
    expect(await checkCounterpartyDependencyGuards("PARTNER", "p-1", ARCHIVE)).toEqual({ status: "clear", reasons: [] });
    unregisterCounterpartyDependencyGuard("same");
    expect(listCounterpartyDependencyGuardIds()).toEqual([]);
  });

  it("a guard that throws, rejects or returns garbage is UNKNOWN (which blocks) - the aggregate never throws and never reports clear", async () => {
    registerCounterpartyDependencyGuard({ id: "throws", counterpartyType: "PARTNER", check: () => { throw new Error("boom internal detail"); } });
    registerCounterpartyDependencyGuard({ id: "rejects", counterpartyType: "PARTNER", check: () => Promise.reject(new Error("nope")) });
    registerCounterpartyDependencyGuard({ id: "garbage", counterpartyType: "PARTNER", check: async () => ({ status: "fine" }) as unknown as CounterpartyDependencyGuardResult });
    registerCounterpartyDependencyGuard({ id: "nullish", counterpartyType: "PARTNER", check: async () => null as unknown as CounterpartyDependencyGuardResult });
    const outcome = await checkCounterpartyDependencyGuards("PARTNER", "p-1", ARCHIVE);
    expect(outcome.status).toBe("unknown");
    expect(outcome.reasons).toHaveLength(1); // all four collapse to the one generic reason
    expect(outcome.reasons.join(" ")).not.toMatch(/boom|internal detail/);
  });

  it("bounds and de-duplicates reasons", async () => {
    for (let i = 0; i < 8; i += 1) registerCounterpartyDependencyGuard(guard(`g${i}`, "VENDOR", { status: "blocked", reason: `reason ${i}` }));
    registerCounterpartyDependencyGuard(guard("dup", "VENDOR", { status: "blocked", reason: "reason 0" }));
    registerCounterpartyDependencyGuard(guard("long", "VENDOR", { status: "blocked", reason: "x".repeat(1000) }));
    const outcome = await checkCounterpartyDependencyGuards("VENDOR", "v-1", ARCHIVE);
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasons.length).toBeLessThanOrEqual(5);
    expect(new Set(outcome.reasons).size).toBe(outcome.reasons.length);
    for (const reason of outcome.reasons) expect(reason.length).toBeLessThanOrEqual(300);
  });

  it("rejects a malformed registration", () => {
    expect(() => registerCounterpartyDependencyGuard({ id: "", counterpartyType: "PARTNER", check: async () => ({ status: "clear" }) })).toThrow();
    expect(() => registerCounterpartyDependencyGuard({ id: "x", counterpartyType: "CAMPAIGN" as never, check: async () => ({ status: "clear" }) })).toThrow();
  });

  it("is a process-wide (globalThis) slot, so a duplicated module instance still sees the same registrations", async () => {
    registerCounterpartyDependencyGuard(guard("shared", "PARTNER", { status: "blocked", reason: "shared" }));
    const slot = (globalThis as Record<symbol, unknown>)[Symbol.for("creatorops.shared.counterpartyDependencyGuards")] as Map<string, unknown>;
    expect(slot.has("shared")).toBe(true);
  });
});

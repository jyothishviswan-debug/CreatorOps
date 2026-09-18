import type { ActorContext } from "@/server/authz/types";

// Step 12A: a small, extensible registry of Import Center "targets" - the
// generic /imports?module=<key> UX owner this file exists for is meant
// to host more than one domain's import eventually; Analytics is the
// first and, for now, the only real registrant (see
// @/server/analytics/import-service.ts's registerAnalyticsImportTarget
// call). The registry itself stays completely domain-agnostic - it knows
// nothing about "targetKind", metric registries, adapters, or matching;
// those are all Analytics' own internal import OPTIONS, passed through
// `options` untouched.
export type ImportDryRunResult = {
  batchRef: string | null; // null in dry-run mode - nothing is persisted
  totalRows: number;
  counts: Record<string, number>;
  safeErrorSummary: string[];
  sourceSheetInventory: Array<{ sheetName: string; rowCount: number; recognizedAs: string }>;
};

export type ImportExecuteResult = ImportDryRunResult & {
  batchRef: string;
  status: string;
};

export type ImportTargetAdapter = {
  kind: string;
  label: string;
  dryRun: (actor: ActorContext | null, file: { buffer: Buffer; filename: string; mimeType: string }, options: Record<string, unknown>, requestId: string) => Promise<ImportDryRunResult>;
  execute: (actor: ActorContext | null, file: { buffer: Buffer; filename: string; mimeType: string }, options: Record<string, unknown>, requestId: string) => Promise<ImportExecuteResult>;
};

const REGISTRY = new Map<string, ImportTargetAdapter>();

// Idempotent by design - re-registering the same kind (e.g. a hot-reload
// in dev) simply overwrites the prior entry rather than throwing.
export function registerImportTarget(adapter: ImportTargetAdapter): void {
  REGISTRY.set(adapter.kind, adapter);
}

export function getImportTarget(kind: string): ImportTargetAdapter | null {
  return REGISTRY.get(kind) ?? null;
}

export function listImportTargets(): ImportTargetAdapter[] {
  return [...REGISTRY.values()];
}

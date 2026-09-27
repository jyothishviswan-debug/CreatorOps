import type { ActorContext } from "@/server/authz/types";
import type { ClassifiedImportError } from "./error-taxonomy";

// Step 12A: a small, extensible registry of Import Center "targets" - the
// generic /imports?module=<key> UX owner this file exists for is meant
// to host more than one domain's import eventually; Analytics is the
// first and, for now, the only real registrant (see
// @/server/analytics/import-service.ts's registerAnalyticsImportTarget
// call). The registry itself stays completely domain-agnostic - it knows
// nothing about "targetKind", metric registries, adapters, or matching;
// those are all Analytics' own internal import OPTIONS, passed through
// `options` untouched.
// Import Center Completion (spec section 5/10): a generic, domain-
// agnostic per-row outcome summary - every adapter maps its OWN
// classification vocabulary into these plain strings (Analytics maps its
// nine/ten AnalyticsRowClassification values; a future adapter maps its
// own). The registry itself never interprets these strings.
export type ImportRowOutcomeSummary = {
  sheetName: string;
  sourceRowNumber: number;
  classification: string;
  outcome: string;
  identityLabel: string | null;
  detail?: string | null;
};

export type ImportDryRunResult = {
  batchRef: string | null; // null in dry-run mode - nothing is persisted
  totalRows: number;
  counts: Record<string, number>;
  safeErrorSummary: string[];
  sourceSheetInventory: Array<{ sheetName: string; rowCount: number; recognizedAs: string }>;
  rows?: ImportRowOutcomeSummary[];
  rowsTruncated?: boolean;
};

export type ImportExecuteResult = ImportDryRunResult & {
  batchRef: string;
  status: string;
};

// Thrown by an adapter's dryRun/execute to carry a full classified error
// (spec section 6) across the generic registry boundary - a caller that
// dispatches through getImportTarget() (rather than a bespoke per-domain
// route, as Analytics's own routes still do for precise, pre-existing
// error-code mapping) catches this specifically to preserve category/
// code/correctable instead of collapsing every failure into a plain
// Error message.
export class ImportAdapterError extends Error {
  constructor(public readonly classified: ClassifiedImportError) {
    super(classified.message);
  }
}

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

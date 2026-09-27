// Import Center Completion - browser-safe shapes mirroring the server
// DTOs (src/server/imports/*, src/server/analytics/import-service.ts,
// src/server/imports/contract-bundle-import.ts). Kept intentionally
// loose/duplicated-by-hand rather than importing server modules into
// client code (this codebase's own client/server boundary discipline).

export type ImportErrorCategory = "FILE" | "STRUCTURE" | "ROW" | "AUTHORIZATION" | "SYSTEM";

export type ClassifiedImportError = {
  category: ImportErrorCategory;
  code: string;
  message: string;
  correctable: boolean;
};

export type ImportModuleKey = "analytics" | "contract_bundle";

export type ImportSheetPreview = {
  sheetName: string;
  headers: string[];
  rowCount: number;
  sampleRows: Array<Record<string, unknown>>;
  sampleRowsTruncated: boolean;
  duplicateHeaders: string[];
  emptyHeaderCount: number;
  emptyRowCount: number;
  trailingEmptyRowCount: number;
};

export type ImportFilePreviewResult = { sheets: ImportSheetPreview[]; totalRowCount: number; warnings: string[] };

export type ImportRowOutcomeSummary = {
  sheetName: string;
  sourceRowNumber: number;
  classification: string;
  outcome: string;
  identityLabel: string | null;
  detail?: string | null;
};

export type ImportSheetInventoryEntry = { sheetName: string; rowCount: number; recognizedAs: string };

export type ImportRunResult = {
  batchRef: string | null;
  totalRows: number;
  counts: Record<string, number>;
  safeErrorSummary: string[];
  sourceSheetInventory: ImportSheetInventoryEntry[];
  rows?: ImportRowOutcomeSummary[];
  rowsTruncated?: boolean;
  status?: string | null;
  quarantinedRows?: number;
  attempts?: number;
  attemptHistory?: Array<{ attemptNumber: number; kind: "EXECUTE" | "RESUME"; at: string; status: string; totalRows: number; quarantinedRows: number }>;
  idempotentReplay?: boolean;
};

export const IMPORT_OUTCOME_GROUPS = ["CREATE", "UNCHANGED", "WARNING", "ERROR", "AMBIGUOUS", "QUARANTINED", "AUTHORIZATION"] as const;
export type ImportOutcomeGroup = (typeof IMPORT_OUTCOME_GROUPS)[number];

import { getStorage } from "firebase-admin/storage";

import { getAdminApp } from "@/server/firebase/admin";

import type { ReportArtifactFormat } from "../types";

// Reports Final-Master (spec section 2): where report artifact BYTES live. Mirrors
// src/server/exports/artifact-store.ts's exact PATTERN (same bucket, same write-once
// ifGenerationMatch:0 idiom, same opaque-server-only-locator discipline, same in-memory test double +
// getX/setXForTests seam) with Reports' own prefix/format union - the disclosed "reuse the pattern,
// not the module" decision (see the task's own recon item 6: Export's module is hardwired to its own
// ExportFormat/prefix and is not directly importable here).
//
// SECURITY: a "locator" is an opaque, SERVER-ONLY string - never placed in a DTO, event, log line, or
// error message returned to a client. The client-facing handle is the separate opaque `artifactRef`
// (see ids.ts's generateArtifactRef) on the ReportArtifactDoc; the actual Storage locator is derived
// from it ONLY inside this module.
const MIME_TYPE_BY_FORMAT: Record<ReportArtifactFormat, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
};
const FILE_EXTENSION_BY_FORMAT: Record<ReportArtifactFormat, string> = { pdf: "pdf", xlsx: "xlsx", csv: "csv" };

export const REPORT_ARTIFACT_OBJECT_PREFIX = "report-artifacts/";
const ARTIFACT_REF_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const LOCATOR_PATTERN = /^report-artifacts\/[A-Za-z0-9_-]{1,100}\.(csv|xlsx|pdf)$/;

export type ReportArtifactPutInput = { artifactRef: string; bytes: Uint8Array; format: ReportArtifactFormat };

export interface ReportArtifactStore {
  put(input: ReportArtifactPutInput): Promise<string>;
  get(locator: string): Promise<Uint8Array>;
  exists?(locator: string): Promise<boolean>;
}

export class ReportArtifactStoreError extends Error {
  constructor(
    readonly code: "invalid_artifact_ref" | "invalid_locator" | "unsupported_format" | "already_exists" | "not_found" | "not_configured",
    message: string,
  ) {
    super(message);
    this.name = "ReportArtifactStoreError";
  }
}

function assertPutInput(input: ReportArtifactPutInput): void {
  if (!ARTIFACT_REF_PATTERN.test(input.artifactRef)) throw new ReportArtifactStoreError("invalid_artifact_ref", "artifactRef is not a valid artifact reference.");
  if (!(input.format in MIME_TYPE_BY_FORMAT)) throw new ReportArtifactStoreError("unsupported_format", "Unsupported report artifact format.");
}

export function locatorForReportArtifactRef(artifactRef: string, format: ReportArtifactFormat): string {
  return `${REPORT_ARTIFACT_OBJECT_PREFIX}${artifactRef}.${FILE_EXTENSION_BY_FORMAT[format]}`;
}

function assertLocator(locator: string): void {
  if (!LOCATOR_PATTERN.test(locator)) throw new ReportArtifactStoreError("invalid_locator", "Not a report artifact locator.");
}

function isPreconditionFailure(error: unknown): boolean {
  const code = (error as { code?: number | string } | null)?.code;
  return code === 412 || code === "412";
}
function isNotFound(error: unknown): boolean {
  const code = (error as { code?: number | string } | null)?.code;
  return code === 404 || code === "404";
}

function resolveBucketName(): string {
  const name = process.env.FIREBASE_STORAGE_BUCKET ?? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  if (!name) throw new ReportArtifactStoreError("not_configured", "FIREBASE_STORAGE_BUCKET (or NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET) is not set.");
  return name;
}

export function createFirebaseStorageReportArtifactStore(): ReportArtifactStore {
  const bucket = () => getStorage(getAdminApp()).bucket(resolveBucketName());
  return {
    async put(input) {
      assertPutInput(input);
      const locator = locatorForReportArtifactRef(input.artifactRef, input.format);
      const file = bucket().file(locator);
      const [alreadyThere] = await file.exists();
      if (alreadyThere) throw new ReportArtifactStoreError("already_exists", "A report artifact with this reference already exists.");
      try {
        await file.save(Buffer.from(input.bytes), { resumable: false, contentType: MIME_TYPE_BY_FORMAT[input.format], preconditionOpts: { ifGenerationMatch: 0 }, metadata: { cacheControl: "private, no-store" } });
      } catch (error) {
        if (isPreconditionFailure(error)) throw new ReportArtifactStoreError("already_exists", "A report artifact with this reference already exists.");
        throw error;
      }
      return locator;
    },
    async get(locator) {
      assertLocator(locator);
      try {
        const [contents] = await bucket().file(locator).download();
        return new Uint8Array(contents);
      } catch (error) {
        if (isNotFound(error)) throw new ReportArtifactStoreError("not_found", "Report artifact bytes were not found.");
        throw error;
      }
    },
    async exists(locator) {
      assertLocator(locator);
      const [found] = await bucket().file(locator).exists();
      return found;
    },
  };
}

export function createInMemoryReportArtifactStore(): ReportArtifactStore & { readonly size: number } {
  const objects = new Map<string, Uint8Array>();
  return {
    get size() {
      return objects.size;
    },
    async put(input) {
      assertPutInput(input);
      const locator = locatorForReportArtifactRef(input.artifactRef, input.format);
      if (objects.has(locator)) throw new ReportArtifactStoreError("already_exists", "A report artifact with this reference already exists.");
      objects.set(locator, new Uint8Array(input.bytes));
      return locator;
    },
    async get(locator) {
      assertLocator(locator);
      const found = objects.get(locator);
      if (!found) throw new ReportArtifactStoreError("not_found", "Report artifact bytes were not found.");
      return new Uint8Array(found);
    },
    async exists(locator) {
      assertLocator(locator);
      return objects.has(locator);
    },
  };
}

export { MIME_TYPE_BY_FORMAT as REPORT_ARTIFACT_MIME_TYPE_BY_FORMAT };

let defaultStore: ReportArtifactStore | null = null;
let storeOverride: ReportArtifactStore | null = null;

export function getReportArtifactStore(): ReportArtifactStore {
  if (storeOverride) return storeOverride;
  defaultStore ??= createFirebaseStorageReportArtifactStore();
  return defaultStore;
}

export function setReportArtifactStoreForTests(store: ReportArtifactStore | null): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) throw new Error("setReportArtifactStoreForTests may only be called from a test run.");
  storeOverride = store;
}

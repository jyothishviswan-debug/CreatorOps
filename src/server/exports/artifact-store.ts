import { getStorage } from "firebase-admin/storage";

import { getAdminApp } from "@/server/firebase/admin";

import { FILE_EXTENSION_BY_FORMAT, MIME_TYPE_BY_FORMAT } from "./generate";
import type { ExportFormat } from "./types";

// Where export artifact BYTES live - a structural sibling of
// src/server/finance-agreements/contract-artifacts/store.ts, generalized for the three export
// formats (that store only ever handles one fixed PDF mime type; this one handles csv/xlsx/pdf).
//
// SECURITY: a "locator" is an opaque, SERVER-ONLY string. It must never appear in any DTO, event,
// log line, error message returned to a client, or Firestore doc a non-restricted reader can see. It
// is deliberately typed as a plain string here; this module exports no DTO type that carries one, and
// never mints a signed URL, public URL or bucket name for a caller. The client-facing handle is the
// separate, opaque `artifactRef` (see ids.ts's generateExportArtifactRef) that export-service.ts puts
// on the job DTO - the actual Storage locator is derived from it ONLY inside this module.

export type ExportArtifactPutInput = {
  artifactRef: string;
  bytes: Uint8Array;
  format: ExportFormat;
};

export interface ExportArtifactStore {
  // Stores the bytes and returns the opaque locator. Refuses to overwrite an existing artifact (an
  // artifactRef is written exactly once).
  put(input: ExportArtifactPutInput): Promise<string>;
  get(locator: string): Promise<Uint8Array>;
  exists?(locator: string): Promise<boolean>;
}

export class ExportArtifactStoreError extends Error {
  constructor(
    readonly code: "invalid_artifact_ref" | "invalid_locator" | "unsupported_format" | "already_exists" | "not_found" | "not_configured",
    message: string,
  ) {
    super(message);
    this.name = "ExportArtifactStoreError";
  }
}

const ARTIFACT_REF_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
export const EXPORT_OBJECT_PREFIX = "export-artifacts/";
const LOCATOR_PATTERN = /^export-artifacts\/[A-Za-z0-9_-]{1,100}\.(csv|xlsx|pdf)$/;

function assertPutInput(input: ExportArtifactPutInput): void {
  if (!ARTIFACT_REF_PATTERN.test(input.artifactRef)) {
    throw new ExportArtifactStoreError("invalid_artifact_ref", "artifactRef is not a valid artifact reference.");
  }
  if (!(input.format in MIME_TYPE_BY_FORMAT)) {
    throw new ExportArtifactStoreError("unsupported_format", "Unsupported export format.");
  }
}

function locatorForRef(artifactRef: string, format: ExportFormat): string {
  return `${EXPORT_OBJECT_PREFIX}${artifactRef}.${FILE_EXTENSION_BY_FORMAT[format]}`;
}

// Exported so export-service.ts's own re-authorized delivery path derives the SAME locator this
// module would, without duplicating the string-building rule in a second place.
export { locatorForRef as locatorForExportRef };

function assertLocator(locator: string): void {
  if (!LOCATOR_PATTERN.test(locator)) {
    throw new ExportArtifactStoreError("invalid_locator", "Not an export artifact locator.");
  }
}

function mimeTypeForLocator(locator: string): string {
  if (locator.endsWith(".csv")) return MIME_TYPE_BY_FORMAT.csv;
  if (locator.endsWith(".xlsx")) return MIME_TYPE_BY_FORMAT.xlsx;
  return MIME_TYPE_BY_FORMAT.pdf;
}

// --- Firebase Storage adapter (the local emulator in dev/test - never real Google Drive/production
// Storage in an automated test run) ------------------------------------------------------------------

function resolveBucketName(): string {
  const name = process.env.FIREBASE_STORAGE_BUCKET ?? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  if (!name) {
    throw new ExportArtifactStoreError("not_configured", "FIREBASE_STORAGE_BUCKET (or NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET) is not set.");
  }
  return name;
}

function isPreconditionFailure(error: unknown): boolean {
  const code = (error as { code?: number | string } | null)?.code;
  return code === 412 || code === "412";
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: number | string } | null)?.code;
  return code === 404 || code === "404";
}

export function createFirebaseStorageArtifactStore(): ExportArtifactStore {
  const bucket = () => getStorage(getAdminApp()).bucket(resolveBucketName());

  return {
    async put(input) {
      assertPutInput(input);
      const locator = locatorForRef(input.artifactRef, input.format);
      const file = bucket().file(locator);
      const [alreadyThere] = await file.exists();
      if (alreadyThere) throw new ExportArtifactStoreError("already_exists", "An export artifact with this reference already exists.");
      try {
        await file.save(Buffer.from(input.bytes), {
          resumable: false,
          contentType: MIME_TYPE_BY_FORMAT[input.format],
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: { cacheControl: "private, no-store" },
        });
      } catch (error) {
        if (isPreconditionFailure(error)) {
          throw new ExportArtifactStoreError("already_exists", "An export artifact with this reference already exists.");
        }
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
        if (isNotFound(error)) throw new ExportArtifactStoreError("not_found", "Export artifact bytes were not found.");
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

// --- In-memory store (unit tests) --------------------------------------------------------------------

export function createInMemoryExportArtifactStore(): ExportArtifactStore & { readonly size: number } {
  const objects = new Map<string, Uint8Array>();
  return {
    get size() {
      return objects.size;
    },
    async put(input) {
      assertPutInput(input);
      const locator = locatorForRef(input.artifactRef, input.format);
      if (objects.has(locator)) throw new ExportArtifactStoreError("already_exists", "An export artifact with this reference already exists.");
      objects.set(locator, new Uint8Array(input.bytes));
      return locator;
    },
    async get(locator) {
      assertLocator(locator);
      const found = objects.get(locator);
      if (!found) throw new ExportArtifactStoreError("not_found", "Export artifact bytes were not found.");
      return new Uint8Array(found);
    },
    async exists(locator) {
      assertLocator(locator);
      return objects.has(locator);
    },
  };
}

export { mimeTypeForLocator };

// --- Module-level default + test seam -------------------------------------

let defaultStore: ExportArtifactStore | null = null;
let storeOverride: ExportArtifactStore | null = null;

export function getExportArtifactStore(): ExportArtifactStore {
  if (storeOverride) return storeOverride;
  defaultStore ??= createFirebaseStorageArtifactStore();
  return defaultStore;
}

export function setExportArtifactStoreForTests(store: ExportArtifactStore | null): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
    throw new Error("setExportArtifactStoreForTests may only be called from a test run.");
  }
  storeOverride = store;
}

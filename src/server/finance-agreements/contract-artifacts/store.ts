import { getStorage } from "firebase-admin/storage";

import { getAdminApp } from "@/server/firebase/admin";

import { CONTRACT_PDF_MIME_TYPE } from "./validation";

// Step 14A: where contract PDF BYTES live. Firestore holds only restricted
// artifact METADATA; the bytes sit behind this interface.
//
// SECURITY: a "locator" is an opaque, SERVER-ONLY string. It must never appear
// in any DTO, event, log line, error message returned to a client, or Firestore
// doc that a non-restricted reader can see. It is deliberately typed as a plain
// string here (the artifact metadata store persists it in a server-only field);
// this module exports no DTO type that carries one, and never mints a signed
// URL, public URL or bucket name for a caller.

export type ContractArtifactPutInput = {
  artifactRef: string;
  bytes: Uint8Array;
  mimeType: string;
};

export interface ContractArtifactStore {
  // Stores the bytes and returns the opaque locator. Refuses to overwrite an
  // existing artifact (an artifactRef is written exactly once).
  put(input: ContractArtifactPutInput): Promise<string>;
  get(locator: string): Promise<Uint8Array>;
  exists?(locator: string): Promise<boolean>;
}

export class ContractArtifactStoreError extends Error {
  constructor(
    readonly code: "invalid_artifact_ref" | "invalid_locator" | "unsupported_mime_type" | "already_exists" | "not_found" | "not_configured",
    message: string,
  ) {
    super(message);
    this.name = "ContractArtifactStoreError";
  }
}

// artifactRef is `ca_` + hex in production, but the store only needs "safe as
// an object-key segment": no slashes, dots or traversal.
const ARTIFACT_REF_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
export const CONTRACT_OBJECT_PREFIX = "finance-contracts/";
const LOCATOR_PATTERN = /^finance-contracts\/[A-Za-z0-9_-]{1,100}\.pdf$/;

function assertPutInput(input: ContractArtifactPutInput): void {
  if (!ARTIFACT_REF_PATTERN.test(input.artifactRef)) {
    throw new ContractArtifactStoreError("invalid_artifact_ref", "artifactRef is not a valid artifact reference.");
  }
  if (input.mimeType !== CONTRACT_PDF_MIME_TYPE) {
    throw new ContractArtifactStoreError("unsupported_mime_type", "Only application/pdf can be stored.");
  }
}

function locatorForRef(artifactRef: string): string {
  return `${CONTRACT_OBJECT_PREFIX}${artifactRef}.pdf`;
}

function assertLocator(locator: string): void {
  if (!LOCATOR_PATTERN.test(locator)) {
    throw new ContractArtifactStoreError("invalid_locator", "Not a contract artifact locator.");
  }
}

// --- Firebase Storage adapter --------------------------------------------

function resolveBucketName(): string {
  const name = process.env.FIREBASE_STORAGE_BUCKET ?? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  if (!name) {
    throw new ContractArtifactStoreError("not_configured", "FIREBASE_STORAGE_BUCKET (or NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET) is not set.");
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

export function createFirebaseStorageArtifactStore(): ContractArtifactStore {
  // Resolved lazily so importing this module never touches Storage/env.
  const bucket = () => getStorage(getAdminApp()).bucket(resolveBucketName());

  return {
    async put(input) {
      assertPutInput(input);
      const locator = locatorForRef(input.artifactRef);
      const file = bucket().file(locator);
      // The Storage emulator ignores ifGenerationMatch, so the write-once rule
      // is enforced by an explicit existence check as well (racy on its own;
      // real GCS additionally enforces the precondition below atomically).
      const [alreadyThere] = await file.exists();
      if (alreadyThere) throw new ContractArtifactStoreError("already_exists", "A contract artifact with this reference already exists.");
      try {
        await file.save(Buffer.from(input.bytes), {
          resumable: false,
          contentType: CONTRACT_PDF_MIME_TYPE,
          // Write-once: fail (412) if the object already exists.
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: { cacheControl: "private, no-store" },
        });
      } catch (error) {
        if (isPreconditionFailure(error)) {
          throw new ContractArtifactStoreError("already_exists", "A contract artifact with this reference already exists.");
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
        if (isNotFound(error)) throw new ContractArtifactStoreError("not_found", "Contract artifact bytes were not found.");
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

// --- In-memory store (tests) ----------------------------------------------

export function createInMemoryArtifactStore(): ContractArtifactStore & { readonly size: number } {
  const objects = new Map<string, Uint8Array>();
  return {
    get size() {
      return objects.size;
    },
    async put(input) {
      assertPutInput(input);
      const locator = locatorForRef(input.artifactRef);
      if (objects.has(locator)) throw new ContractArtifactStoreError("already_exists", "A contract artifact with this reference already exists.");
      objects.set(locator, new Uint8Array(input.bytes));
      return locator;
    },
    async get(locator) {
      assertLocator(locator);
      const found = objects.get(locator);
      if (!found) throw new ContractArtifactStoreError("not_found", "Contract artifact bytes were not found.");
      return new Uint8Array(found);
    },
    async exists(locator) {
      assertLocator(locator);
      return objects.has(locator);
    },
  };
}

// --- Module-level default + test seam -------------------------------------

let defaultStore: ContractArtifactStore | null = null;
let storeOverride: ContractArtifactStore | null = null;

export function getContractArtifactStore(): ContractArtifactStore {
  if (storeOverride) return storeOverride;
  defaultStore ??= createFirebaseStorageArtifactStore();
  return defaultStore;
}

export function setContractArtifactStoreForTests(store: ContractArtifactStore | null): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
    throw new Error("setContractArtifactStoreForTests may only be called from a test run.");
  }
  storeOverride = store;
}

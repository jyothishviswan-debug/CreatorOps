import { getStorage } from "firebase-admin/storage";

import { getAdminApp } from "@/server/firebase/admin";

// Notes/Meetings Completion (spec section 13): where attachment BYTES live. A structural sibling of
// src/server/exports/artifact-store.ts (chosen over Finance Agreement's fuller
// document-storage/{types,index,in-memory,google-drive,guard}.ts split - that module's own extra
// files exist to choose between a REAL Google Drive adapter and a fake one; Notes/Meetings never
// wires real Drive at all, so there is no adapter choice to make, only Storage-emulator-vs-in-memory,
// exactly the shape artifact-store.ts already solved).
//
// SECURITY: a "locator" is an opaque, SERVER-ONLY string - never in a DTO, event, log line, or error.
// The client-facing handle is the separate opaque `attachmentRef` (ids.ts's generateAttachmentRef);
// the Storage locator is derived from it ONLY inside this module. No public URL, no signed URL, no
// raw bucket path is ever minted for a caller - delivery is always a re-authorized server route
// (attachment-service.ts's getAttachmentBytes) that streams bytes back to an already-authorized actor.

export type AttachmentPutInput = { attachmentRef: string; bytes: Uint8Array; mimeType: string };

export interface AttachmentBytesStore {
  put(input: AttachmentPutInput): Promise<string>;
  get(locator: string): Promise<Uint8Array>;
}

export class AttachmentStoreError extends Error {
  constructor(
    readonly code: "invalid_ref" | "invalid_locator" | "already_exists" | "not_found" | "not_configured",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentStoreError";
  }
}

const ATTACHMENT_REF_PATTERN = /^att_[0-9a-f]{20}$/;
export const ATTACHMENT_OBJECT_PREFIX = "notes-meetings-attachments/";
const LOCATOR_PATTERN = /^notes-meetings-attachments\/att_[0-9a-f]{20}$/;

function assertPutInput(input: AttachmentPutInput): void {
  if (!ATTACHMENT_REF_PATTERN.test(input.attachmentRef)) throw new AttachmentStoreError("invalid_ref", "attachmentRef is not a valid attachment reference.");
}

function locatorForRef(attachmentRef: string): string {
  return `${ATTACHMENT_OBJECT_PREFIX}${attachmentRef}`;
}

function assertLocator(locator: string): void {
  if (!LOCATOR_PATTERN.test(locator)) throw new AttachmentStoreError("invalid_locator", "Not a Notes/Meetings attachment locator.");
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: number | string } | null)?.code;
  return code === 404 || code === "404";
}
function isPreconditionFailure(error: unknown): boolean {
  const code = (error as { code?: number | string } | null)?.code;
  return code === 412 || code === "412";
}

function resolveBucketName(): string {
  const name = process.env.FIREBASE_STORAGE_BUCKET ?? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  if (!name) throw new AttachmentStoreError("not_configured", "FIREBASE_STORAGE_BUCKET is not set.");
  return name;
}

// --- Firebase Storage adapter (the local emulator in dev/test - never real Google Drive/production
// Storage in an automated test run; see attachment-service.ts's own upload path, which never runs
// this in NODE_ENV=test/VITEST) --------------------------------------------------------------------
export function createFirebaseStorageAttachmentStore(): AttachmentBytesStore {
  const bucket = () => getStorage(getAdminApp()).bucket(resolveBucketName());
  return {
    async put(input) {
      assertPutInput(input);
      const locator = locatorForRef(input.attachmentRef);
      const file = bucket().file(locator);
      const [alreadyThere] = await file.exists();
      if (alreadyThere) throw new AttachmentStoreError("already_exists", "An attachment with this reference already exists.");
      try {
        await file.save(Buffer.from(input.bytes), { resumable: false, contentType: input.mimeType, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { cacheControl: "private, no-store" } });
      } catch (error) {
        if (isPreconditionFailure(error)) throw new AttachmentStoreError("already_exists", "An attachment with this reference already exists.");
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
        if (isNotFound(error)) throw new AttachmentStoreError("not_found", "Attachment bytes were not found.");
        throw error;
      }
    },
  };
}

// --- In-memory store (unit tests) --------------------------------------------------------------------
export function createInMemoryAttachmentStore(): AttachmentBytesStore & { readonly size: number } {
  const objects = new Map<string, Uint8Array>();
  return {
    get size() {
      return objects.size;
    },
    async put(input) {
      assertPutInput(input);
      const locator = locatorForRef(input.attachmentRef);
      if (objects.has(locator)) throw new AttachmentStoreError("already_exists", "An attachment with this reference already exists.");
      objects.set(locator, new Uint8Array(input.bytes));
      return locator;
    },
    async get(locator) {
      assertLocator(locator);
      const found = objects.get(locator);
      if (!found) throw new AttachmentStoreError("not_found", "Attachment bytes were not found.");
      return new Uint8Array(found);
    },
  };
}

// --- Module-level default + test seam -------------------------------------
let defaultStore: AttachmentBytesStore | null = null;
let storeOverride: AttachmentBytesStore | null = null;

export function getAttachmentStore(): AttachmentBytesStore {
  if (storeOverride) return storeOverride;
  defaultStore ??= createFirebaseStorageAttachmentStore();
  return defaultStore;
}

export function setAttachmentStoreForTests(store: AttachmentBytesStore | null): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) throw new Error("setAttachmentStoreForTests may only be called from a test run.");
  storeOverride = store;
}

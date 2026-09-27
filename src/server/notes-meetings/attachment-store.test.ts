import { describe, expect, it } from "vitest";

import { AttachmentStoreError, createInMemoryAttachmentStore } from "./attachment-store";

describe("createInMemoryAttachmentStore (spec section 13: opaque locator, no public URL)", () => {
  it("stores and retrieves bytes by a generated opaque locator, never a raw path derived from the file name", () => {
    const store = createInMemoryAttachmentStore();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    return store.put({ attachmentRef: "att_00000000000000000000", bytes, mimeType: "application/pdf" }).then(async (locator) => {
      expect(locator).not.toMatch(/\.(pdf|png)$/); // no extension derived from an untrusted file name
      expect(locator).toMatch(/^notes-meetings-attachments\/att_[0-9a-f]{20}$/);
      const readBack = await store.get(locator);
      expect([...readBack]).toEqual([1, 2, 3, 4]);
    });
  });

  it("refuses a malformed attachmentRef (invalid_ref) and a malformed locator on read (invalid_locator)", async () => {
    const store = createInMemoryAttachmentStore();
    await expect(store.put({ attachmentRef: "not-a-real-ref", bytes: new Uint8Array([1]), mimeType: "application/pdf" })).rejects.toMatchObject({ code: "invalid_ref" });
    await expect(store.get("not/a/real/locator")).rejects.toMatchObject({ code: "invalid_locator" });
  });

  it("refuses to overwrite an existing attachmentRef (already_exists) - an attachment is written exactly once", async () => {
    const store = createInMemoryAttachmentStore();
    const input = { attachmentRef: "att_11111111111111111111", bytes: new Uint8Array([9]), mimeType: "application/pdf" };
    await store.put(input);
    await expect(store.put(input)).rejects.toMatchObject({ code: "already_exists" });
  });

  it("reports not_found for bytes that were never stored", async () => {
    const store = createInMemoryAttachmentStore();
    await expect(store.get("notes-meetings-attachments/att_22222222222222222222")).rejects.toBeInstanceOf(AttachmentStoreError);
  });

  it("returns a genuine private copy of the bytes, never a shared reference an outside caller could mutate", async () => {
    const store = createInMemoryAttachmentStore();
    const original = new Uint8Array([5, 6, 7]);
    const locator = await store.put({ attachmentRef: "att_33333333333333333333", bytes: original, mimeType: "application/pdf" });
    original[0] = 99; // mutate the caller's own copy after storing
    const readBack = await store.get(locator);
    expect(readBack[0]).toBe(5); // unaffected by the later mutation
  });
});

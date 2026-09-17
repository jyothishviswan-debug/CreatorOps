import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Step 8A.1: certifies that firestore.indexes.json actually declares the
// exact composite index every active Partner/Vendor/VendorPartnerLink/
// PartnerAccount query shape needs (derived from the real query
// construction in partners/firestore.ts and vendors/firestore.ts, never
// from a comment) - not merely that some string mentioning the
// collection name is present somewhere in the file. A local Firestore
// emulator never enforces these, so nothing else in the test suite would
// catch a missing or wrong composite index before a real deployment did.
type IndexField = { fieldPath: string; order?: "ASCENDING" | "DESCENDING"; arrayConfig?: "CONTAINS" };
type FirestoreIndex = { collectionGroup: string; queryScope: string; fields: IndexField[] };

const indexesFile: { indexes: FirestoreIndex[] } = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../firestore.indexes.json"), "utf8"));

function hasIndex(collectionGroup: string, fields: IndexField[]): boolean {
  return indexesFile.indexes.some(
    (index) =>
      index.collectionGroup === collectionGroup &&
      index.queryScope === "COLLECTION" &&
      index.fields.length === fields.length &&
      index.fields.every((field, i) => field.fieldPath === fields[i]!.fieldPath && field.order === fields[i]!.order && field.arrayConfig === fields[i]!.arrayConfig),
  );
}

const createdAtDesc: IndexField = { fieldPath: "createdAt", order: "DESCENDING" };
const displayNameLowerAsc: IndexField = { fieldPath: "displayNameLower", order: "ASCENDING" };

describe("firestore.indexes.json - Partners", () => {
  // listPartnerDocs's {SELF, REGION, TEAM} scope branches x {createdAt-desc order} -
  // see src/server/partners/firestore.ts's listPartnerDocs.
  it("has the SELF/REGION/TEAM scope-branch x createdAt-desc grid", () => {
    expect(hasIndex("partners", [{ fieldPath: "ownerUid", order: "ASCENDING" }, createdAtDesc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "regionIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "teamIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
  });

  // Same grid, but with a `status` filter also applied.
  it("has the status + scope-branch x createdAt-desc grid", () => {
    expect(hasIndex("partners", [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "ownerUid", order: "ASCENDING" }, createdAtDesc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "regionIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "teamIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
  });

  // Standalone secondary filters (tier / targetAudience / pendingPartnerAccountSetup), each + createdAt-desc.
  it("has a standalone createdAt-desc index for tier, targetAudience, and pendingPartnerAccountSetup", () => {
    expect(hasIndex("partners", [{ fieldPath: "tier", order: "ASCENDING" }, createdAtDesc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "targetAudience", order: "ASCENDING" }, createdAtDesc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "pendingPartnerAccountSetup", order: "ASCENDING" }, createdAtDesc])).toBe(true);
  });

  // The displayNamePrefix search order mode, same scope-branch grid.
  it("has the SELF/REGION/TEAM scope-branch x displayNameLower-asc grid (search order)", () => {
    expect(hasIndex("partners", [{ fieldPath: "ownerUid", order: "ASCENDING" }, displayNameLowerAsc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "regionIds", arrayConfig: "CONTAINS" }, displayNameLowerAsc])).toBe(true);
    expect(hasIndex("partners", [{ fieldPath: "teamIds", arrayConfig: "CONTAINS" }, displayNameLowerAsc])).toBe(true);
  });
});

describe("firestore.indexes.json - Vendors", () => {
  // listVendorDocs's {SELF, REGION, TEAM} scope branches x {createdAt-desc order} -
  // see src/server/vendors/firestore.ts's listVendorDocs.
  it("has the SELF/REGION/TEAM scope-branch x createdAt-desc grid", () => {
    expect(hasIndex("vendors", [{ fieldPath: "ownerUid", order: "ASCENDING" }, createdAtDesc])).toBe(true);
    expect(hasIndex("vendors", [{ fieldPath: "regionIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
    expect(hasIndex("vendors", [{ fieldPath: "teamIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
  });

  it("has the status + scope-branch x createdAt-desc grid", () => {
    expect(hasIndex("vendors", [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "ownerUid", order: "ASCENDING" }, createdAtDesc])).toBe(true);
    expect(hasIndex("vendors", [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "regionIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
    expect(hasIndex("vendors", [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "teamIds", arrayConfig: "CONTAINS" }, createdAtDesc])).toBe(true);
  });

  it("has a standalone createdAt-desc index for vendorType", () => {
    expect(hasIndex("vendors", [{ fieldPath: "vendorType", order: "ASCENDING" }, createdAtDesc])).toBe(true);
  });

  it("has the SELF/REGION/TEAM scope-branch x displayNameLower-asc grid (search order)", () => {
    expect(hasIndex("vendors", [{ fieldPath: "ownerUid", order: "ASCENDING" }, displayNameLowerAsc])).toBe(true);
    expect(hasIndex("vendors", [{ fieldPath: "regionIds", arrayConfig: "CONTAINS" }, displayNameLowerAsc])).toBe(true);
    expect(hasIndex("vendors", [{ fieldPath: "teamIds", arrayConfig: "CONTAINS" }, displayNameLowerAsc])).toBe(true);
  });
});

describe("firestore.indexes.json - VendorPartnerLinks and PartnerAccounts", () => {
  // listVendorPartnerLinkDocsForVendor / ForPartner - see
  // src/server/vendors/firestore.ts. Each is a single equality filter
  // combined with an orderBy on a DIFFERENT field, which always needs a
  // dedicated composite index.
  it("has vendorRef+createdAt and partnerRef+createdAt for vendorPartnerLinks", () => {
    expect(hasIndex("vendorPartnerLinks", [{ fieldPath: "vendorRef", order: "ASCENDING" }, { fieldPath: "createdAt", order: "ASCENDING" }])).toBe(true);
    expect(hasIndex("vendorPartnerLinks", [{ fieldPath: "partnerRef", order: "ASCENDING" }, { fieldPath: "createdAt", order: "ASCENDING" }])).toBe(true);
  });

  // checkVendorDependencies's vendorRef==+status=="ACTIVE" check has no
  // orderBy - Firestore's automatic per-field indexes merge-join
  // equality-only queries, so this deliberately does NOT get a composite
  // index (removed as speculative Step 8A.1 - it was never a real query
  // requirement).
  it("does not carry a speculative vendorRef+status composite index", () => {
    expect(hasIndex("vendorPartnerLinks", [{ fieldPath: "vendorRef", order: "ASCENDING" }, { fieldPath: "status", order: "ASCENDING" }])).toBe(false);
  });

  // listPartnerAccountDocs - see src/server/partners/firestore.ts. Same
  // "equality + orderBy on a different field" shape as the
  // vendorPartnerLinks pair above.
  it("has partnerRef+createdAt for partnerAccounts", () => {
    expect(hasIndex("partnerAccounts", [{ fieldPath: "partnerRef", order: "ASCENDING" }, { fieldPath: "createdAt", order: "ASCENDING" }])).toBe(true);
  });
});

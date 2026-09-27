import { describe, expect, it } from "vitest";

import { buildRowInput, findRestrictedHeaders, resolveRow, rowClientRequestId } from "./contract-bundle-import";

describe("normalizeHeader / resolveRow", () => {
  it("matches a header alias case-insensitively and with extra whitespace", () => {
    const resolved = resolveRow({ "  Display   Name ": "Acme Creator", "Region ID": "APAC", Type: "Partner" });
    expect(resolved.displayName).toBe("Acme Creator");
    expect(resolved.regionId).toBe("APAC");
    expect(resolved.type).toBe("Partner");
  });

  it("ignores a column with no matching alias", () => {
    const resolved = resolveRow({ "Some Unrelated Column": "value" });
    expect(resolved.displayName).toBeUndefined();
  });
});

describe("findRestrictedHeaders - never a silent pass-through for KYC-like columns", () => {
  it.each(["PAN", "Aadhaar Number", "Bank Account No", "IFSC Code", "GSTIN", "UPI ID", "KYC Status"])("flags a %s-looking header", (header) => {
    const hit = findRestrictedHeaders([{ sheetName: "Bundle", headers: [header, "Display Name"], rows: [] }]);
    expect(hit).toContain(header);
  });

  it("does not flag an ordinary business header", () => {
    const hit = findRestrictedHeaders([{ sheetName: "Bundle", headers: ["Display Name", "Email", "Phone", "Platform", "Handle"], rows: [] }]);
    expect(hit).toHaveLength(0);
  });
});

describe("buildRowInput - Partner/Account/Agreement stay conceptually distinct, never one permissive row model", () => {
  const sourceHash = "abc123";

  it("builds a valid CREATE_NEW Partner input with one Partner Account", () => {
    const raw = resolveRow({ Type: "Partner", "Display Name": "Acme Creator", Region: "apac", Platform: "instagram", Handle: "acmecreator" });
    const result = buildRowInput("Bundle", 2, raw, sourceHash, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.type).toBe("PARTNER");
    expect(result.input.accounts).toHaveLength(1);
    expect(result.input.duplicateDecision.kind).toBe("CREATE_NEW");
    // A bulk import never supplies an acknowledgement on the actor's
    // behalf - a duplicate always needs a human decision.
    expect((result.input.duplicateDecision as { acknowledgedDuplicates: boolean }).acknowledgedDuplicates).toBe(false);
  });

  it("rejects a Vendor row that also carries Partner Account columns (no accidental identity collapse)", () => {
    const raw = resolveRow({ Type: "Vendor", "Display Name": "Acme Agency", "Vendor Type": "AGENCY", Region: "apac", Platform: "instagram", Handle: "x" });
    const result = buildRowInput("Bundle", 2, raw, sourceHash, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.row.outcome).toBe("ERROR");
  });

  it("requires a region - falls back to the default only when the row omits its own", () => {
    const raw = resolveRow({ Type: "Partner", "Display Name": "Acme Creator" });
    const withoutDefault = buildRowInput("Bundle", 2, raw, sourceHash, null);
    expect(withoutDefault.ok).toBe(false);

    const withDefault = buildRowInput("Bundle", 2, raw, sourceHash, "apac");
    expect(withDefault.ok).toBe(true);
  });

  it("rejects an invalid Vendor Type rather than guessing one", () => {
    const raw = resolveRow({ Type: "Vendor", "Display Name": "Acme Agency", "Vendor Type": "NOT_A_REAL_TYPE", Region: "apac" });
    const result = buildRowInput("Bundle", 2, raw, sourceHash, null);
    expect(result.ok).toBe(false);
  });

  it("produces a stable, deterministic clientRequestId for the same row, and a different one for a different row", () => {
    const a = rowClientRequestId(sourceHash, "Bundle", 2);
    const b = rowClientRequestId(sourceHash, "Bundle", 2);
    const c = rowClientRequestId(sourceHash, "Bundle", 3);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^bundle:[a-f0-9]{40}$/);
  });
});

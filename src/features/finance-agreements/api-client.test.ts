import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FINANCE_DENIED_MESSAGE,
  FINANCE_NETWORK_MESSAGE,
  activateAgreementVersion,
  addKycLinkEvidence,
  applyExtractedKyc,
  attachExtractionProposals,
  confirmAgreementVersion,
  createAgreementDraft,
  createAgreementRevision,
  decideField,
  endAgreement,
  errorKindForStatus,
  extractContract,
  getAgreementDetail,
  getAgreementKycStatus,
  getAgreementReconciliation,
  getCounterpartyPreview,
  getExtractionResult,
  getFinancePermissions,
  isStaleMessage,
  listAgreementEvents,
  listAgreementVersions,
  listAgreementsForCounterparty,
  loadAgreementsWorkspace,
  resumeAgreement,
  searchCounterparties,
  suspendAgreement,
  updateCounterpartyContact,
  uploadContractArtifact,
  uploadKycEvidenceFile,
} from "./api-client";

type Call = { url: string; init: RequestInit };

function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const REF = "agr_0123456789abcdef0123";

afterEach(() => vi.unstubAllGlobals());

describe("request wiring - every /api/finance route, method, query and body", () => {
  const cases: Array<{ name: string; call: () => Promise<unknown>; method: "GET" | "POST"; url: string; body?: unknown }> = [
    { name: "createAgreementDraft", call: () => createAgreementDraft({ clientRequestId: "req-12345678", counterparty: { type: "VENDOR", vendorRef: "v_1" } }), method: "POST", url: "/api/finance/agreements", body: { clientRequestId: "req-12345678", counterparty: { type: "VENDOR", vendorRef: "v_1" } } },
    { name: "listAgreementsForCounterparty", call: () => listAgreementsForCounterparty("PARTNER", "p_1"), method: "GET", url: "/api/finance/agreements?counterpartyType=PARTNER&ref=p_1" },
    { name: "getAgreementDetail (default version)", call: () => getAgreementDetail(REF), method: "GET", url: `/api/finance/agreements/${REF}` },
    { name: "getAgreementDetail (version)", call: () => getAgreementDetail(REF, { version: 2 }), method: "GET", url: `/api/finance/agreements/${REF}?version=2` },
    { name: "listAgreementVersions", call: () => listAgreementVersions(REF), method: "GET", url: `/api/finance/agreements/${REF}/versions` },
    { name: "listAgreementEvents", call: () => listAgreementEvents(REF, { limit: 25 }), method: "GET", url: `/api/finance/agreements/${REF}/events?limit=25` },
    { name: "decideField", call: () => decideField(REF, { version: 1, expectedDocVersion: 3, fieldKey: "paymentCycle", decision: "CORRECTED", value: "MONTHLY" }), method: "POST", url: `/api/finance/agreements/${REF}/fields`, body: { version: 1, expectedDocVersion: 3, fieldKey: "paymentCycle", decision: "CORRECTED", value: "MONTHLY" } },
    { name: "confirmAgreementVersion", call: () => confirmAgreementVersion(REF, { version: 1, expectedDocVersion: 4 }), method: "POST", url: `/api/finance/agreements/${REF}/confirm`, body: { version: 1, expectedDocVersion: 4 } },
    { name: "activateAgreementVersion", call: () => activateAgreementVersion(REF, { version: 1, expectedDocVersion: 2 }), method: "POST", url: `/api/finance/agreements/${REF}/activate`, body: { version: 1, expectedDocVersion: 2 } },
    { name: "createAgreementRevision", call: () => createAgreementRevision(REF, { expectedDocVersion: 5 }), method: "POST", url: `/api/finance/agreements/${REF}/revise`, body: { expectedDocVersion: 5 } },
    { name: "suspendAgreement", call: () => suspendAgreement(REF, { expectedDocVersion: 5, reason: "Paused" }), method: "POST", url: `/api/finance/agreements/${REF}/suspend`, body: { expectedDocVersion: 5, reason: "Paused" } },
    { name: "resumeAgreement", call: () => resumeAgreement(REF, { expectedDocVersion: 6 }), method: "POST", url: `/api/finance/agreements/${REF}/resume`, body: { expectedDocVersion: 6 } },
    { name: "endAgreement", call: () => endAgreement(REF, { expectedDocVersion: 7, reason: "Terminated" }), method: "POST", url: `/api/finance/agreements/${REF}/end`, body: { expectedDocVersion: 7, reason: "Terminated" } },
    { name: "extractContract", call: () => extractContract({ agreementRef: REF, version: 1, artifactRef: "ca_0123456789abcdef0123" }), method: "POST", url: "/api/finance/contracts/extract", body: { agreementRef: REF, version: 1, artifactRef: "ca_0123456789abcdef0123" } },
    { name: "getExtractionResult (latest)", call: () => getExtractionResult(REF), method: "GET", url: `/api/finance/agreements/${REF}/extraction` },
    { name: "getExtractionResult (run)", call: () => getExtractionResult(REF, { runRef: "run_0123456789abcdef0123" }), method: "GET", url: `/api/finance/agreements/${REF}/extraction?runRef=run_0123456789abcdef0123` },
    { name: "attachExtractionProposals", call: () => attachExtractionProposals(REF, { version: 1, expectedDocVersion: 2, extractionRunRef: "run_0123456789abcdef0123" }), method: "POST", url: `/api/finance/agreements/${REF}/extraction/attach`, body: { version: 1, expectedDocVersion: 2, extractionRunRef: "run_0123456789abcdef0123" } },
    { name: "getAgreementReconciliation", call: () => getAgreementReconciliation(REF, { version: 1 }), method: "GET", url: `/api/finance/agreements/${REF}/reconciliation?version=1` },
    { name: "getAgreementKycStatus", call: () => getAgreementKycStatus(REF), method: "GET", url: `/api/finance/agreements/${REF}/kyc-status` },
    { name: "updateCounterpartyContact", call: () => updateCounterpartyContact(REF, { version: 1, fieldKey: "emailAddress", mode: "FILL_MISSING", expectedCounterpartyVersion: 9 }), method: "POST", url: `/api/finance/agreements/${REF}/master-data`, body: { version: 1, fieldKey: "emailAddress", mode: "FILL_MISSING", expectedCounterpartyVersion: 9 } },
    { name: "applyExtractedKyc", call: () => applyExtractedKyc(REF, { version: 1, components: ["pan"], mode: "FILL_MISSING" }), method: "POST", url: `/api/finance/agreements/${REF}/kyc`, body: { version: 1, components: ["pan"], mode: "FILL_MISSING" } },
    { name: "loadAgreementsWorkspace (empty)", call: () => loadAgreementsWorkspace(), method: "GET", url: "/api/finance/agreements/workspace" },
    { name: "loadAgreementsWorkspace (filters, nulls omitted)", call: () => loadAgreementsWorkspace({ lifecycle: "ACTIVE", counterpartyType: null, q: "  ", platform: "instagram", period: "2026-09", discrepancy: "open", cursor: "abc", limit: 10 }), method: "GET", url: "/api/finance/agreements/workspace?lifecycle=ACTIVE&platform=instagram&period=2026-09&discrepancy=open&cursor=abc&limit=10" },
    { name: "searchCounterparties", call: () => searchCounterparties({ counterpartyType: "VENDOR", q: "Acme & Co", limit: 8 }), method: "GET", url: "/api/finance/counterparties/search?counterpartyType=VENDOR&q=Acme+%26+Co&limit=8" },
    { name: "getCounterpartyPreview", call: () => getCounterpartyPreview({ counterpartyType: "PARTNER", ref: "p_1" }), method: "GET", url: "/api/finance/counterparties/preview?counterpartyType=PARTNER&ref=p_1" },
    { name: "getFinancePermissions (none)", call: () => getFinancePermissions(), method: "GET", url: "/api/finance/permissions" },
    { name: "getFinancePermissions (type)", call: () => getFinancePermissions({ counterpartyType: "VENDOR" }), method: "GET", url: "/api/finance/permissions?counterpartyType=VENDOR" },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} -> ${testCase.method} ${testCase.url}`, async () => {
      const calls = mockFetch(() => json({ ok: 1 }));
      const result = await testCase.call();
      expect(result).toEqual({ ok: true, status: 200, data: { ok: 1 } });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(testCase.url);
      expect(calls[0]!.init.method).toBe(testCase.method);
      if (testCase.body !== undefined) {
        expect(JSON.parse(String(calls[0]!.init.body))).toEqual(testCase.body);
        expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      } else {
        expect(calls[0]!.init.body).toBeUndefined();
      }
    });
  }

  it("percent-encodes an agreementRef path segment", async () => {
    const calls = mockFetch(() => json({}));
    await getAgreementDetail("agr/../x");
    expect(calls[0]!.url).toBe("/api/finance/agreements/agr%2F..%2Fx");
  });

  it("passes the AbortSignal through to fetch", async () => {
    const calls = mockFetch(() => json({}));
    const controller = new AbortController();
    await getAgreementDetail(REF, {}, { signal: controller.signal });
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });
});

describe("contract upload (multipart)", () => {
  it("posts FormData with file, counterpartyType and counterpartyRef and lets the browser set the content type", async () => {
    const calls = mockFetch(() => json({ artifactRef: "ca_0123456789abcdef0123" }, 201));
    const file = new File(["%PDF-1.4 test"], "Signed Agreement.pdf", { type: "application/pdf" });
    const result = await uploadContractArtifact({ file, counterpartyType: "PARTNER", counterpartyRef: "p_1" });

    expect(result).toEqual({ ok: true, status: 201, data: { artifactRef: "ca_0123456789abcdef0123" } });
    expect(calls[0]!.url).toBe("/api/finance/contracts/upload");
    expect(calls[0]!.init.method).toBe("POST");
    const form = calls[0]!.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("counterpartyType")).toBe("PARTNER");
    expect(form.get("counterpartyRef")).toBe("p_1");
    expect((form.get("file") as File).name).toBe("Signed Agreement.pdf");
    expect(Object.keys(calls[0]!.init.headers as Record<string, string>).map((k) => k.toLowerCase())).not.toContain("content-type");
  });

  it("maps 413 and 415 to invalid with the server message", async () => {
    mockFetch(() => json({ error: "The upload is larger than the 10 MB contract limit." }, 413));
    const result = await uploadContractArtifact({ file: new File(["x"], "a.pdf"), counterpartyType: "VENDOR", counterpartyRef: "v_1" });
    expect(result).toMatchObject({ ok: false, status: 413, kind: "invalid", message: "The upload is larger than the 10 MB contract limit." });
    mockFetch(() => json({ error: "Upload the contract as multipart/form-data." }, 415));
    expect(await uploadContractArtifact({ file: new File(["x"], "a.pdf"), counterpartyType: "VENDOR", counterpartyRef: "v_1" })).toMatchObject({ kind: "invalid", status: 415 });
  });
});

describe("failure mapping (never throws, always a discriminated result)", () => {
  it("maps every status to its kind", () => {
    expect(errorKindForStatus(0)).toBe("network");
    expect(errorKindForStatus(401)).toBe("unauthorized");
    expect(errorKindForStatus(403)).toBe("forbidden");
    expect(errorKindForStatus(404)).toBe("not_found");
    expect(errorKindForStatus(400)).toBe("invalid");
    expect(errorKindForStatus(413)).toBe("invalid");
    expect(errorKindForStatus(415)).toBe("invalid");
    expect(errorKindForStatus(409, { hasBlockers: true })).toBe("not_ready");
    expect(errorKindForStatus(409, { message: "This agreement was changed elsewhere. Reload and try again." })).toBe("stale");
    expect(errorKindForStatus(409, { message: "Version 1 is confirmed or is not the open version and can no longer be changed." })).toBe("conflict");
    expect(errorKindForStatus(409)).toBe("conflict");
    expect(errorKindForStatus(500)).toBe("error");
    expect(errorKindForStatus(503)).toBe("error");
    expect(isStaleMessage("This Partner was changed elsewhere. Reload and try again.")).toBe(true);
  });

  it("401 -> unauthorized and 403 -> forbidden, both with the one neutral message", async () => {
    mockFetch(() => json({ error: "Forbidden." }, 401));
    expect(await getAgreementDetail(REF)).toEqual({ ok: false, status: 401, kind: "unauthorized", message: FINANCE_DENIED_MESSAGE });
    mockFetch(() => json({ error: "Forbidden." }, 403));
    expect(await getAgreementDetail(REF)).toEqual({ ok: false, status: 403, kind: "forbidden", message: FINANCE_DENIED_MESSAGE });
  });

  it("404 -> not_found with the neutral text", async () => {
    mockFetch(() => json({ error: "Not found." }, 404));
    expect(await getAgreementDetail(REF)).toEqual({ ok: false, status: 404, kind: "not_found", message: "Not found." });
  });

  it("400 -> invalid with the server's message", async () => {
    mockFetch(() => json({ error: "Invalid value for Payment cycle." }, 400));
    expect(await decideField(REF, { version: 1, expectedDocVersion: 1, fieldKey: "paymentCycle", decision: "CORRECTED", value: "X" })).toEqual({ ok: false, status: 400, kind: "invalid", message: "Invalid value for Payment cycle." });
  });

  it("409 with blockers -> not_ready and the blockers are carried through (sanitized)", async () => {
    mockFetch(() => json({ error: "This agreement is not ready to confirm.", blockers: [{ code: "field_pending", message: "State is awaiting a decision.", fieldKey: "state" }, { code: "required_field_missing", message: "Effective date is required." }, { nope: 1 }, "junk"] }, 409));
    const result = await confirmAgreementVersion(REF, { version: 1, expectedDocVersion: 1 });
    expect(result).toEqual({
      ok: false,
      status: 409,
      kind: "not_ready",
      message: "This agreement is not ready to confirm.",
      blockers: [
        { code: "field_pending", message: "State is awaiting a decision.", fieldKey: "state" },
        { code: "required_field_missing", message: "Effective date is required." },
      ],
    });
  });

  it("409 without blockers -> stale for 'changed elsewhere', conflict otherwise", async () => {
    mockFetch(() => json({ error: "This agreement was changed elsewhere. Reload and try again." }, 409));
    expect(await activateAgreementVersion(REF, { version: 1, expectedDocVersion: 1 })).toMatchObject({ ok: false, kind: "stale" });
    mockFetch(() => json({ error: "This clientRequestId was already used for a different agreement request." }, 409));
    expect(await createAgreementDraft({ clientRequestId: "req-12345678", counterparty: { type: "VENDOR", vendorRef: "v_1" } })).toMatchObject({ ok: false, kind: "conflict" });
  });

  it("500 -> error", async () => {
    mockFetch(() => json({ error: "Something went wrong." }, 500));
    expect(await getAgreementDetail(REF)).toMatchObject({ ok: false, status: 500, kind: "error", message: "Something went wrong." });
  });

  it("a failure with no JSON body still yields a typed result with a generic message", async () => {
    mockFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await getAgreementDetail(REF)).toEqual({ ok: false, status: 502, kind: "error", message: "Something went wrong." });
  });

  it("a 200 with a non-JSON body is an error result, not a throw", async () => {
    mockFetch(() => new Response("not json", { status: 200 }));
    expect(await getAgreementDetail(REF)).toEqual({ ok: false, status: 200, kind: "error", message: "Unexpected response from the server." });
  });

  it("a network failure (fetch rejects) -> network, never a throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await getAgreementDetail(REF)).toEqual({ ok: false, status: 0, kind: "network", message: FINANCE_NETWORK_MESSAGE });
  });

  it("a fetch that throws synchronously is also contained", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("boom");
    });
    expect(await getAgreementDetail(REF)).toMatchObject({ ok: false, kind: "network" });
  });
});

describe("AbortSignal", () => {
  it("an already-aborted signal never calls fetch and resolves as aborted", async () => {
    const calls = mockFetch(() => json({}));
    const controller = new AbortController();
    controller.abort();
    const result = await getAgreementDetail(REF, {}, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, status: 0, kind: "network", aborted: true });
    expect(calls).toHaveLength(0);
  });

  it("an abort while in flight resolves as aborted (not as a plain network error)", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        controller.abort();
        expect(init.signal).toBe(controller.signal);
        throw new DOMException("The operation was aborted.", "AbortError");
      }),
    );
    const result = await searchCounterparties({ counterpartyType: "PARTNER", q: "a" }, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, kind: "network", aborted: true });
  });

  it("a genuine network failure is not flagged aborted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const result = await searchCounterparties({ counterpartyType: "PARTNER", q: "a" }, { signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: false, kind: "network" });
    expect((result as { aborted?: boolean }).aborted).toBeUndefined();
  });
});

describe("201 vs 200 on create / upload is exposed through status", () => {
  it("createAgreementDraft: created = 201, idempotent retry = 200", async () => {
    mockFetch(() => json({ head: {} }, 201));
    expect(await createAgreementDraft({ clientRequestId: "req-12345678", counterparty: { type: "VENDOR", vendorRef: "v_1" } })).toMatchObject({ ok: true, status: 201 });
    mockFetch(() => json({ head: {} }, 200));
    expect(await createAgreementDraft({ clientRequestId: "req-12345678", counterparty: { type: "VENDOR", vendorRef: "v_1" } })).toMatchObject({ ok: true, status: 200 });
  });
});

describe("KYC evidence through the owning module (reused Partner / Vendor client functions)", () => {
  it("adds a Partner link evidence through /api/partners/.../restricted-identity/evidence", async () => {
    const calls = mockFetch(() => json({ version: 4, evidence: { docType: "pan", kind: "link", url: "https://x.example/p", fileName: null, addedAt: "2026-09-21T00:00:00.000Z", addedByUserRef: "u_1" } }));
    const result = await addKycLinkEvidence({ counterpartyType: "PARTNER", ref: "p_1", docType: "pan", url: "https://x.example/p", expectedVersion: 3 });
    expect(result).toMatchObject({ ok: true, status: 200, data: { version: 4 } });
    expect(calls[0]!.url).toBe("/api/partners/p_1/restricted-identity/evidence");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ docType: "pan", url: "https://x.example/p", expectedVersion: 3 });
  });

  it("adds a Vendor link evidence through /api/vendors/.../restricted-identity/evidence", async () => {
    const calls = mockFetch(() => json({ version: 2, evidence: {} }));
    await addKycLinkEvidence({ counterpartyType: "VENDOR", ref: "v_1", docType: "gst", url: "https://x.example/g", expectedVersion: 1 });
    expect(calls[0]!.url).toBe("/api/vendors/v_1/restricted-identity/evidence");
  });

  it("uploads a Partner / Vendor document as multipart to the owning route", async () => {
    const calls = mockFetch(() => json({ version: 5, evidence: {} }));
    const file = new File(["%PDF-1.4"], "pan.pdf", { type: "application/pdf" });
    await uploadKycEvidenceFile({ counterpartyType: "PARTNER", ref: "p_1", docType: "pan", file, expectedVersion: 4 });
    await uploadKycEvidenceFile({ counterpartyType: "VENDOR", ref: "v_1", docType: "bank", file, expectedVersion: 4 });
    expect(calls.map((c) => c.url)).toEqual(["/api/partners/p_1/restricted-identity/evidence", "/api/vendors/v_1/restricted-identity/evidence"]);
    const form = calls[0]!.init.body as FormData;
    expect(form.get("docType")).toBe("pan");
    expect(form.get("expectedVersion")).toBe("4");
    expect((form.get("file") as File).name).toBe("pan.pdf");
  });

  it("maps an owning-module denial to the neutral forbidden result and a stale write to conflict", async () => {
    mockFetch(() => json({ error: "Forbidden." }, 403));
    expect(await addKycLinkEvidence({ counterpartyType: "PARTNER", ref: "p_1", docType: "pan", url: "https://x.example/p", expectedVersion: 3 })).toEqual({ ok: false, status: 403, kind: "forbidden", message: FINANCE_DENIED_MESSAGE });
    mockFetch(() => json({ error: "This record was changed elsewhere. Reload and try again." }, 409));
    expect(await addKycLinkEvidence({ counterpartyType: "PARTNER", ref: "p_1", docType: "pan", url: "https://x.example/p", expectedVersion: 3 })).toMatchObject({ ok: false, kind: "stale" });
  });

  it("refuses Aadhaar evidence for a Vendor without any request, and honours a pre-aborted signal", async () => {
    const calls = mockFetch(() => json({}));
    expect(await addKycLinkEvidence({ counterpartyType: "VENDOR", ref: "v_1", docType: "aadhaar", url: "https://x.example/a", expectedVersion: 1 })).toMatchObject({ ok: false, kind: "invalid" });
    expect(await uploadKycEvidenceFile({ counterpartyType: "VENDOR", ref: "v_1", docType: "aadhaar", file: new File(["x"], "a.pdf"), expectedVersion: 1 })).toMatchObject({ ok: false, kind: "invalid" });
    const controller = new AbortController();
    controller.abort();
    expect(await addKycLinkEvidence({ counterpartyType: "PARTNER", ref: "p_1", docType: "pan", url: "https://x.example/p", expectedVersion: 1 }, { signal: controller.signal })).toMatchObject({ aborted: true });
    expect(calls).toHaveLength(0);
  });
});

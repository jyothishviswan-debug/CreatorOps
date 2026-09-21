import { describe, expect, it, vi } from "vitest";

import type { AttachExtractionOutcome } from "@/server/finance-agreements/agreement-service";
import type { ContractArtifactDto, ExtractionResultDto } from "@/server/finance-agreements/client-dto";

import type { FinanceApiResult } from "../../api-client";
import { describeReupload, hasAttachableProposals, holdOnboardingHandoff, peekOnboardingHandoff, reuploadAgreement, takeOnboardingHandoff, type ReuploadDeps } from "./handoff";

const FILE = { name: "signed.pdf", size: 1234, type: "application/pdf" } as unknown as File;
const ok = <T,>(data: T): FinanceApiResult<T> => ({ ok: true, status: 200, data });
const fail = (message = "Server said no."): FinanceApiResult<never> => ({ ok: false, status: 500, kind: "error", message });
const ARTIFACT = { artifactRef: "ca_0123456789abcdef0123", fileName: "signed.pdf" } as ContractArtifactDto;
const extraction = (fields: Array<{ valueState: "VISIBLE" | "RESTRICTED" }>, status: "EXTRACTED" | "MANUAL_REVIEW_REQUIRED" = "EXTRACTED") => ({ run: { runRef: "run_0123456789abcdef0123", status }, fields }) as unknown as ExtractionResultDto;
const ATTACHED = { attachedCount: 7, keptDecisionCount: 0, skippedCount: 0, agreement: {} } as unknown as AttachExtractionOutcome;

function deps(over: Partial<ReuploadDeps> = {}): ReuploadDeps & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    upload: over.upload ?? (async () => (order.push("upload"), ok(ARTIFACT))),
    extract: over.extract ?? (async () => (order.push("extract"), ok(extraction([{ valueState: "VISIBLE" }])))),
    attach: over.attach ?? (async () => (order.push("attach"), ok(ATTACHED))),
  };
}

describe("re-upload orchestration", () => {
  it("runs upload -> extract -> attach, in that order, each with the previous step's result", async () => {
    const calls: string[] = [];
    const result = await reuploadAgreement(FILE, {
      upload: async (file) => (calls.push(`upload:${file.name}`), ok(ARTIFACT)),
      extract: async (artifactRef) => (calls.push(`extract:${artifactRef}`), ok(extraction([{ valueState: "VISIBLE" }]))),
      attach: async (runRef) => (calls.push(`attach:${runRef}`), ok(ATTACHED)),
    });
    expect(calls).toEqual(["upload:signed.pdf", "extract:ca_0123456789abcdef0123", "attach:run_0123456789abcdef0123"]);
    expect(result).toMatchObject({ ok: true, attached: true, attachedCount: 7 });
  });

  it("stops at the first failure and names the stage; later steps never run", async () => {
    const upload = deps({ upload: async () => fail() });
    expect(await reuploadAgreement(FILE, upload)).toMatchObject({ ok: false, stage: "upload", artifact: null });
    expect(upload.order).toEqual([]);

    const extractFails = deps({ extract: async () => fail("Could not read it.") });
    const extractResult = await reuploadAgreement(FILE, extractFails);
    expect(extractResult).toMatchObject({ ok: false, stage: "extract", artifact: ARTIFACT, extraction: null });
    expect(extractFails.order).toEqual(["upload"]);

    const attachFails = deps({ attach: async () => fail() });
    const attachResult = await reuploadAgreement(FILE, attachFails);
    expect(attachResult).toMatchObject({ ok: false, stage: "attach", artifact: ARTIFACT });
    expect(attachFails.order).toEqual(["upload", "extract"]);
  });

  it("a scanned Agreement (nothing attachable) is uploaded and extracted but not attached - not a failure", async () => {
    const attach = vi.fn();
    const result = await reuploadAgreement(FILE, deps({ extract: async () => ok(extraction([], "MANUAL_REVIEW_REQUIRED")), attach }));
    expect(result).toMatchObject({ ok: true, attached: false, attachedCount: 0 });
    expect(attach).not.toHaveBeenCalled();
    expect(hasAttachableProposals(extraction([{ valueState: "RESTRICTED" }]))).toBe(false);
    expect(hasAttachableProposals(extraction([{ valueState: "RESTRICTED" }, { valueState: "VISIBLE" }]))).toBe(true);
  });

  it("describes each ending honestly and points at the next section", async () => {
    const attached = describeReupload(await reuploadAgreement(FILE, deps()));
    expect(attached).toMatchObject({ tone: "success", nextSection: "cross_verification" });
    expect(attached.message).toMatch(/7 extracted values were attached to the draft as pending/);
    const scanned = describeReupload(await reuploadAgreement(FILE, deps({ extract: async () => ok(extraction([], "MANUAL_REVIEW_REQUIRED")) })));
    expect(scanned).toMatchObject({ tone: "warning", nextSection: "cross_verification" });
    const failed = describeReupload(await reuploadAgreement(FILE, deps({ upload: async () => fail("Too big.") })));
    expect(failed).toMatchObject({ tone: "error", nextSection: "contract_source" });
    expect(failed.message).toMatch(/draft was created, but the signed Agreement could not be uploaded\. Too big\./);
    expect(describeReupload(await reuploadAgreement(FILE, deps({ extract: async () => fail() }))).message).toMatch(/was uploaded, but could not be read/);
    expect(describeReupload(await reuploadAgreement(FILE, deps({ attach: async () => fail() }))).message).toMatch(/could not be attached/);
  });
});

describe("the hand-off holder", () => {
  it("is consumed once, only by the form of the matching Agreement", () => {
    holdOnboardingHandoff({ agreementRef: "agr_a", file: FILE, announcement: "Created." });
    expect(peekOnboardingHandoff()?.file).toBe(FILE);
    expect(takeOnboardingHandoff("agr_other")).toBeNull();
    expect(takeOnboardingHandoff(null)).toBeNull();
    expect(peekOnboardingHandoff()).not.toBeNull();
    expect(takeOnboardingHandoff("agr_a")).toMatchObject({ agreementRef: "agr_a", file: FILE, announcement: "Created." });
    expect(takeOnboardingHandoff("agr_a")).toBeNull();
  });

  it("a newer hand-off replaces an older one, and a missing file (after a reload) is representable", () => {
    holdOnboardingHandoff({ agreementRef: "agr_old", file: FILE, announcement: "old" });
    holdOnboardingHandoff({ agreementRef: "agr_new", file: null, announcement: "new" });
    expect(takeOnboardingHandoff("agr_old")).toBeNull();
    expect(takeOnboardingHandoff("agr_new")).toEqual({ agreementRef: "agr_new", file: null, announcement: "new" });
  });
});

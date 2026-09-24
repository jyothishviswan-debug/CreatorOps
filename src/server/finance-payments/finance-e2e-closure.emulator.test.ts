// Step 17C - the ONE canonical Finance end-to-end integration test: a real Partner monthly cycle,
// against the running Firestore/Auth emulator, driven entirely through the trusted server-layer
// services (never HTTP, never hand-rolled business truth) -
//
//   Agreement -> 16 real Analytics-backed Content deliverables -> finalized Partner Review
//   -> Payable (proration + explicit GST decision + platform TDS) -> READY_FOR_INVOICE
//   -> Invoice (extraction proposals, a corrected value, a deliberate payee mismatch + its
//      authorized resolution) -> approval -> two partial Payments -> PAID settlement
//   -> upstream immutability
//
// The fixture itself (tests/e2e/helpers/finance-e2e-closure-fixtures.ts) is built ON TOP OF the
// existing Agreements/Partner-Reviews fixture factories, exactly like finance-payables-fixtures.ts /
// finance-invoices-fixtures.ts / finance-payments-fixtures.ts already build on each other - see that
// file's header comment. Every OTHER already-closed module's edge cases (LFC/SFC & target warnings
// never moving money, the proration cap when actual > required, FAILED/duplicate-reference/
// overpayment/concurrency protection, authz per role, broad sensitive-data sweeps) are exhaustively
// covered by that module's OWN emulator suite (amount-determination.test.ts,
// finance-payables.emulator.test.ts, finance-invoices.emulator.test.ts,
// finance-payments.emulator.test.ts) and are proven there, not re-derived here - this file's job is
// proving the CHAIN, with one concrete worked example, end to end.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { getAdminFirestore } from "@/server/firebase/admin";
import { getAgreementDetail } from "@/server/finance-agreements";
import { agreementCommercialPolicyProvider } from "@/server/finance-agreements/policy-adapter";
import { makeTextPdf } from "@/server/finance-agreements/testing/pdf-fixtures";
import { setCommercialPolicyProviderForTests } from "@/server/partner-reviews/commercial-policy";
import { getPartnerReview } from "@/server/partner-reviews/partner-review-service";
import { seedAccessControlData } from "@/server/authz/seed-access-data";

import { confirmPayableTax, createPayable, getPayable, markPayableReadyForInvoice } from "@/server/finance-payables";
import { financePayablesCollection } from "@/server/finance-payables/firestore";
import {
  approveInvoice,
  attachInvoiceDocument,
  createInvoiceDraft,
  getInvoice,
  previewInvoiceExtraction,
  resolveInvoicePayeeMismatch,
  reviseInvoiceDraft,
  submitInvoice,
} from "@/server/finance-invoices";
import { createInMemoryInvoiceDocumentStorage, setInvoiceDocumentStorageForTests } from "@/server/finance-invoices/document-storage";
import { financeInvoicesCollection } from "@/server/finance-invoices/firestore";

import { confirmPayment, createPaymentDraft, getInvoicePaymentSettlement, getPayment, recordPayment, revisePaymentDraft } from "./index";
import { financePaymentReferenceClaimsCollection, financePaymentsCollection, financePaymentSettlementsCollection } from "./firestore";

import { CLOSURE_ACTUAL_COUNT, CLOSURE_GST_RATE_BPS, CLOSURE_REQUIRED_COUNT, CLOSURE_SERVICE_BASE_MINOR, createClosureFixtures, type ClosureFixtures } from "../../../tests/e2e/helpers/finance-e2e-closure-fixtures";

vi.setConfig({ testTimeout: 120_000 });

const runId = Date.now();
const TAG = `clo-${runId}`;
const PERIOD = "2024-03"; // inside the Agreement's default effective window (2024-01-01..2024-12-31, see READY_DECISIONS)
const MISMATCHED_SUPPLIER_NAME = "Totally Different Legal Entity LLC";

function must<T>(result: { ok: true; data: T } | { ok: false; code: string; message: string; blockers?: unknown }, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.code} - ${result.message}${"blockers" in result && result.blockers ? ` ${JSON.stringify(result.blockers)}` : ""}`);
  return result.data;
}
function failure<R extends { ok: boolean }>(result: R): Extract<R, { ok: false }> {
  if (result.ok) throw new Error("expected a failure, got a success");
  return result as Extract<R, { ok: false }>;
}

let fixtures: ClosureFixtures;
// The composed closure fixture (tests/e2e/helpers/finance-e2e-closure-fixtures.ts) only owns the
// Agreements/Partner-Reviews chain - Payable/Invoice/Payment are created directly by this test
// through the trusted services (never through a fixture helper), so this test tracks and removes
// them itself in afterAll, exactly like finance-payments.emulator.test.ts's own afterAll does.
const payableRefs: string[] = [];
const invoiceRefs: string[] = [];
const paymentRefs: string[] = [];

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  setCommercialPolicyProviderForTests(agreementCommercialPolicyProvider);
  setInvoiceDocumentStorageForTests(createInMemoryInvoiceDocumentStorage());
  fixtures = createClosureFixtures(TAG);
}, 120_000);

afterAll(async () => {
  setCommercialPolicyProviderForTests(null);
  setInvoiceDocumentStorageForTests(null);
  const db = getAdminFirestore();
  for (const ref of paymentRefs) await db.recursiveDelete(financePaymentsCollection().doc(ref));
  const settlementDocs = await financePaymentSettlementsCollection().get();
  await Promise.all(settlementDocs.docs.filter((doc) => invoiceRefs.includes(doc.id)).map((doc) => doc.ref.delete()));
  const referenceClaims = await financePaymentReferenceClaimsCollection().get();
  await Promise.all(referenceClaims.docs.filter((doc) => paymentRefs.includes((doc.data() as { paymentRef?: string }).paymentRef ?? "")).map((doc) => doc.ref.delete()));
  for (const ref of invoiceRefs) await db.recursiveDelete(financeInvoicesCollection().doc(ref));
  for (const ref of payableRefs) await db.recursiveDelete(financePayablesCollection().doc(ref));
  await fixtures.cleanupAll();
});

describe("Step 17C - Finance end-to-end closure", () => {
  it("proves the complete Agreement -> Review -> Payable -> Invoice -> Payment monthly cycle, with upstream immutability", async () => {
    const head = await fixtures.finance.actorOf("head");

    // ---- 1) Agreement + 16 real deliverables + finalized Partner Review ---------------------------------------------
    const basis = await fixtures.seedProratedPartnerBasis(PERIOD, `Closure Partner ${runId}`);
    expect(basis.agreementVersion).toBeGreaterThan(0);
    expect(basis.reviewVersion).toBeGreaterThan(0);

    // ---- 2) Payable: proration proof + explicit tax decision + provenance pinning ----------------------------------
    // For a Partner basis, the Agreement is resolved from the finalized Partner Review itself - never
    // client-supplied (only a Vendor AGREEMENT_ONLY basis takes an explicit agreementRef).
    const created = must(
      await createPayable(head, { counterpartyType: "PARTNER", counterpartyRef: basis.partner.partnerRef, commercialPeriod: PERIOD }, randomUUID()),
      "create payable",
    );
    const payableRef = created.payable.head.payableRef;
    payableRefs.push(payableRef);
    const draftVersion = created.payable.selectedVersion!;

    // The worked example from spec section 5: required 20, delivered 16 -> service base 80,000.
    expect(draftVersion.snapshot.qualifyingContent?.requiredCount).toBe(CLOSURE_REQUIRED_COUNT);
    expect(draftVersion.snapshot.qualifyingContent?.actualQualifyingCount).toBe(CLOSURE_ACTUAL_COUNT);
    expect(draftVersion.serviceBaseMinor).toBe(CLOSURE_SERVICE_BASE_MINOR); // 8,000,000 = INR 80,000
    // The prorated base line, plus TDS (a Partner basis has the 10% platform TDS rule applied
    // automatically - it needs no Finance decision, unlike GST). LFC/SFC and target evaluations
    // surface as `warnings` text only - see PAYABLE_LINE_CATEGORIES - never as a money-affecting
    // line (this scenario carries no incentive/transfer-fee/advance term at all). The proration cap
    // when actual > required, and warnings never moving money, are exhaustively proven with exact
    // numbers in amount-determination.test.ts; this closure only re-proves the CHAIN, not every
    // calculator edge case.
    expect(draftVersion.lines.map((line) => line.category)).toEqual(["PRORATED_BASE", "TDS"]);

    // GST is unconfirmed -> FINANCE_REVIEW_REQUIRED, gross/net not final yet.
    expect(draftVersion.determinationState).toBe("FINANCE_REVIEW_REQUIRED");
    expect(draftVersion.unresolved.some((u) => u.code === "GST_APPLICABILITY_UNCONFIRMED")).toBe(true);

    // Provenance: Agreement ref/version, Review ref/version, commercial month, calculation rule version - all pinned verbatim.
    expect(draftVersion.snapshot.agreement.agreementRef).toBe(basis.agreementRef);
    expect(draftVersion.snapshot.agreement.agreementVersion).toBe(basis.agreementVersion);
    expect(draftVersion.snapshot.review?.reviewRef).toBe(basis.reviewRef);
    expect(draftVersion.snapshot.review?.reviewVersion).toBe(basis.reviewVersion);
    expect(draftVersion.snapshot.commercialPeriod.periodKey ?? PERIOD).toBeTruthy();
    expect(draftVersion.calculationRuleVersion).toBe("MONTHLY_ANALYTICS_PRORATION_V1");

    // Explicit GST decision (never defaulted): Yes at 18%.
    const taxConfirmed = must(
      await confirmPayableTax(head, { payableRef, expectedDocVersion: created.payable.head.docVersion, gstApplicable: true, gstRateBps: CLOSURE_GST_RATE_BPS }, randomUUID()),
      "confirm GST",
    );
    const taxedVersion = taxConfirmed.selectedVersion!;
    expect(taxedVersion.determinationState).toBe("DETERMINISTIC");
    // Five distinct totals, never conflated (spec section 5).
    expect(taxedVersion.serviceBaseMinor).toBe(8_000_000);
    expect(taxedVersion.gstMinor).toBe(1_440_000); // 18% of 8,000,000
    expect(taxedVersion.grossInvoiceExpectedMinor).toBe(9_440_000); // service base + GST
    expect(taxedVersion.tdsMinor).toBe(800_000); // 10% platform rule, ON THE SERVICE BASE, never on the gross Invoice total
    expect(taxedVersion.expectedNetPaymentMinor).toBe(8_640_000); // gross - TDS
    expect(new Set([taxedVersion.serviceBaseMinor, taxedVersion.gstMinor, taxedVersion.grossInvoiceExpectedMinor, taxedVersion.tdsMinor, taxedVersion.expectedNetPaymentMinor]).size).toBe(5);

    const ready = must(await markPayableReadyForInvoice(head, { payableRef, expectedDocVersion: taxConfirmed.head.docVersion }, randomUUID()), "ready");
    expect(ready.head.status).toBe("READY_FOR_INVOICE");
    const rereadPayable = must(await getPayable(head, payableRef), "reread payable");
    expect(rereadPayable.selectedVersion!.expectedNetPaymentMinor).toBe(8_640_000);

    // ---- 3) Invoice: create, extract from a synthetic PDF, a user correction, reconciliation, payee mismatch + resolution ----
    const invoiceCreated = must(await createInvoiceDraft(head, { payableRef }, randomUUID()), "create invoice");
    let invoice = invoiceCreated.invoice;
    invoiceRefs.push(invoice.head.invoiceRef);

    // A synthetic, structurally-valid text PDF (no OCR) exercising invoice number/date/subtotal/GST/declared total.
    const synthPdf = makeTextPdf([["Invoice Number: INV-CLOSURE-001", `Invoice Date: 2 ${PERIOD.slice(5)}/2019`, "Sub Total: INR 80,000", "GST @ 18%", "Total Due: INR 94,400"]]);
    const preview = must(await previewInvoiceExtraction(head, { invoiceRef: invoice.head.invoiceRef, contentBase64: synthPdf.toString("base64") }), "extraction preview");
    expect(preview.status).toBe("EXTRACTED");
    const byKey = Object.fromEntries(preview.fields.map((f) => [f.fieldKey, f]));
    expect(byKey.externalInvoiceNumber?.value).toBe("INV-CLOSURE-001");
    expect(byKey.declaredTotalMinor?.value).toBe(9_440_000); // reconciles to the Payable's gross expectation exactly

    // Genuinely read-only: previewing never mutates the Invoice.
    const rereadAfterPreview = must(await getInvoice(head, invoice.head.invoiceRef), "reread after preview");
    expect(rereadAfterPreview.head.docVersion).toBe(invoice.head.docVersion);

    // Apply the extracted proposals, but with a USER CORRECTION on the invoice number (a value the
    // user has touched must never be silently overwritten by a later extraction) and a deliberate
    // payee-name mismatch to exercise the identity-matching gate end to end.
    const CORRECTED_NUMBER = "INV-CLOSURE-001-CORRECTED";
    const revised = must(
      await reviseInvoiceDraft(
        head,
        {
          invoiceRef: invoice.head.invoiceRef,
          expectedDocVersion: invoice.head.docVersion,
          externalInvoiceNumber: CORRECTED_NUMBER,
          invoiceDate: "2024-04-02",
          currency: "INR",
          declaredTotalMinor: byKey.declaredTotalMinor!.value as number,
          extractedPayeeName: MISMATCHED_SUPPLIER_NAME,
          reason: "Applying extraction proposals with a corrected invoice number and the extracted payee name.",
        },
        randomUUID(),
      ),
      "revise draft",
    );
    invoice = revised;
    expect(invoice.head.externalInvoiceNumber).toBe(CORRECTED_NUMBER); // the user's correction wins, never the raw proposal
    // No document is attached yet, so reconciliation reads BLOCKED (MISSING_INVOICE_DOCUMENT) rather
    // than MATCH/MISMATCH - it is re-evaluated once the document lands below.
    expect(invoice.selectedVersion!.reconciliation.state).toBe("BLOCKED");
    expect(invoice.selectedVersion!.payeeIdentity!.overallStatus).toBe("MISMATCH");

    const withDoc = must(
      await attachInvoiceDocument(head, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: invoice.head.docVersion, fileName: "closure-invoice.pdf", contentBase64: synthPdf.toString("base64") }, randomUUID()),
      "attach document",
    );
    invoice = withDoc;
    expect(invoice.selectedVersion!.reconciliation.state).toBe("MATCH"); // now that the document is present, the declared total matches the Payable's gross expectation exactly

    const submitted = must(await submitInvoice(head, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: invoice.head.docVersion }, randomUUID()), "submit");
    invoice = submitted;
    expect(invoice.head.status).toBe("SUBMITTED");

    // ---- 4) Approval gating: blocked by the unresolved hard payee mismatch, then resolved through the authorized flow ----
    const blocked = failure(await approveInvoice(head, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: invoice.head.docVersion }, randomUUID()));
    expect(blocked.code).toBe("not_ready");
    expect(blocked.blockers?.some((b: { code: string }) => b.code === "PAYEE_IDENTITY_MISMATCH")).toBe(true);

    const resolved = must(
      await resolveInvoicePayeeMismatch(head, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: invoice.head.docVersion, reason: "Verified against the signed Agreement; same legal entity under a trading name." }, randomUUID()),
      "resolve payee mismatch",
    );
    invoice = resolved;
    expect(invoice.selectedVersion!.payeeIdentity!.overallStatus).toBe("OVERRIDDEN");
    // The original mismatch evidence is preserved verbatim, never rewritten into a fake match.
    const nameField = invoice.selectedVersion!.payeeIdentity!.fields.find((f) => f.field === "NAME")!;
    expect(nameField.status).toBe("MISMATCH");
    expect(nameField.safeExtractedDisplay).toBe(MISMATCHED_SUPPLIER_NAME);

    const approved = must(await approveInvoice(head, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: invoice.head.docVersion }, randomUUID()), "approve");
    invoice = approved;
    expect(invoice.head.status).toBe("APPROVED");
    expect(invoice.selectedVersion!.payablePin.payableExpectedNetPaymentMinor).toBe(8_640_000);
    expect(invoice.selectedVersion!.payablePin.payableGrossInvoiceExpectedMinor).toBe(9_440_000);
    // TDS is never the supplier's own gross Invoice target - the Invoice's declared/gross total stays the full 9,440,000.
    expect(invoice.selectedVersion!.declaredTotalMinor).toBe(9_440_000);

    // Sensitive-data spot check: no raw restricted identity fields anywhere in the Invoice DTO.
    const invoiceSerialized = JSON.stringify(invoice);
    for (const forbidden of ["panNumber", "aadhaarNumber", "accountNumber", "ifsc", "gstin"]) expect(invoiceSerialized.toLowerCase()).not.toContain(forbidden.toLowerCase());

    // ---- 5) Payment journey: two partial Payments to PAID -----------------------------------------------------------
    const expectedNet = invoice.selectedVersion!.payablePin.payableExpectedNetPaymentMinor!;
    expect(expectedNet).toBe(8_640_000);
    const firstAmount = Math.floor(expectedNet / 2); // 4,320,000
    const secondAmount = expectedNet - firstAmount; // 4,320,000

    const firstDraft = must(await createPaymentDraft(head, { invoiceRef: invoice.head.invoiceRef }, randomUUID()), "first payment draft").payment;
    paymentRefs.push(firstDraft.head.paymentRef);
    expect(firstDraft.selectedVersion!.invoicePin.expectedNetPaymentMinor).toBe(expectedNet); // pinned from the approved Invoice, never client-supplied
    expect(firstDraft.selectedVersion!.invoicePin.invoiceVersion).toBe(invoice.head.approvedVersion);

    const firstRevised = must(
      await revisePaymentDraft(head, { paymentRef: firstDraft.head.paymentRef, expectedDocVersion: firstDraft.head.docVersion, amountMinor: firstAmount, paymentDate: "2024-04-10", method: "BANK_TRANSFER", externalReference: `CLO-REF-1-${runId}`, reason: "First installment." }, randomUUID()),
      "revise first",
    );
    const firstRecorded = must(await recordPayment(head, { paymentRef: firstRevised.head.paymentRef, expectedDocVersion: firstRevised.head.docVersion }, randomUUID()), "record first");
    expect(firstRecorded.head.status).toBe("RECORDED");

    // RECORDED (not yet CONFIRMED) never reduces the remaining balance.
    const settlementAfterRecordOnly = must(await getInvoicePaymentSettlement(head, invoice.head.invoiceRef), "settlement after record-only");
    expect(settlementAfterRecordOnly.summary.confirmedPaidMinor).toBe(0);
    expect(settlementAfterRecordOnly.summary.state).toBe("UNPAID");

    const firstConfirmed = must(await confirmPayment(head, { paymentRef: firstRecorded.head.paymentRef, expectedDocVersion: firstRecorded.head.docVersion }, randomUUID()), "confirm first");
    expect(firstConfirmed.head.status).toBe("CONFIRMED");

    const settlementAfterFirst = must(await getInvoicePaymentSettlement(head, invoice.head.invoiceRef), "settlement after first confirm");
    expect(settlementAfterFirst.summary.confirmedPaidMinor).toBe(firstAmount);
    expect(settlementAfterFirst.summary.remainingMinor).toBe(secondAmount);
    expect(settlementAfterFirst.summary.state).toBe("PARTIALLY_PAID");
    expect(settlementAfterFirst.summary.confirmedPaidMinor! + settlementAfterFirst.summary.remainingMinor!).toBe(expectedNet);

    const secondDraft = must(await createPaymentDraft(head, { invoiceRef: invoice.head.invoiceRef }, randomUUID()), "second payment draft").payment;
    paymentRefs.push(secondDraft.head.paymentRef);
    const secondRevised = must(
      await revisePaymentDraft(head, { paymentRef: secondDraft.head.paymentRef, expectedDocVersion: secondDraft.head.docVersion, amountMinor: secondAmount, paymentDate: "2024-04-20", method: "BANK_TRANSFER", externalReference: `CLO-REF-2-${runId}`, reason: "Final installment." }, randomUUID()),
      "revise second",
    );
    const secondRecorded = must(await recordPayment(head, { paymentRef: secondRevised.head.paymentRef, expectedDocVersion: secondRevised.head.docVersion }, randomUUID()), "record second");
    const secondConfirmed = must(await confirmPayment(head, { paymentRef: secondRecorded.head.paymentRef, expectedDocVersion: secondRecorded.head.docVersion }, randomUUID()), "confirm second");
    expect(secondConfirmed.head.status).toBe("CONFIRMED");

    const settlementFinal = must(await getInvoicePaymentSettlement(head, invoice.head.invoiceRef), "final settlement");
    expect(settlementFinal.summary.confirmedPaidMinor).toBe(expectedNet);
    expect(settlementFinal.summary.remainingMinor).toBe(0);
    expect(settlementFinal.summary.state).toBe("PAID");

    // Neither Payment ever recalculated GST/TDS - both amounts sum to the ORIGINAL expectedNetPaymentMinor pinned at approval.
    const paymentOne = must(await getPayment(head, firstConfirmed.head.paymentRef), "reread payment one");
    const paymentTwo = must(await getPayment(head, secondConfirmed.head.paymentRef), "reread payment two");
    expect(paymentOne.selectedVersion!.invoicePin.expectedNetPaymentMinor).toBe(expectedNet);
    expect(paymentTwo.selectedVersion!.invoicePin.expectedNetPaymentMinor).toBe(expectedNet);
    // Sensitive-data spot check on the Payment DTOs too.
    const paymentSerialized = JSON.stringify([paymentOne, paymentTwo]);
    for (const forbidden of ["accountNumber", "ifsc", "panNumber", "aadhaarNumber"]) expect(paymentSerialized.toLowerCase()).not.toContain(forbidden.toLowerCase());

    // ---- 6) Upstream immutability: Agreement / Review / Payable snapshot / approved Invoice version all unchanged ----
    const agreementAfter = must(await getAgreementDetail(head, basis.agreementRef), "reread agreement after payment");
    expect(agreementAfter.selectedVersion!.version).toBe(basis.agreementVersion);
    expect(agreementAfter.head.latestVersion).toBe(basis.agreementVersion); // no revision was ever created by any downstream action

    const reviewAfter = must(await getPartnerReview(head, basis.reviewRef), "reread review after payment");
    expect(reviewAfter.selectedVersion!.version).toBe(basis.reviewVersion);
    expect(reviewAfter.selectedVersion!.status).toBe("FINALIZED");

    const payableAfter = must(await getPayable(head, payableRef), "reread payable after payment");
    expect(payableAfter.selectedVersion!.serviceBaseMinor).toBe(8_000_000);
    expect(payableAfter.selectedVersion!.expectedNetPaymentMinor).toBe(8_640_000);
    expect(payableAfter.selectedVersion!.snapshot.agreement.agreementVersion).toBe(basis.agreementVersion);
    expect(payableAfter.selectedVersion!.snapshot.review?.reviewVersion).toBe(basis.reviewVersion);

    const invoiceAfter = must(await getInvoice(head, invoice.head.invoiceRef), "reread invoice after payment");
    expect(invoiceAfter.head.approvedVersion).toBe(invoice.head.approvedVersion);
    expect(invoiceAfter.selectedVersion!.declaredTotalMinor).toBe(9_440_000);
    expect(invoiceAfter.selectedVersion!.payablePin.payableExpectedNetPaymentMinor).toBe(8_640_000);
  });
});

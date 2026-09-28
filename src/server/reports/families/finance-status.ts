import type { ActorContext } from "@/server/authz/types";
import { listAgreementsWorkspace } from "@/server/finance-agreements/agreement-workspace-service";
import { listInvoicesWorkspace } from "@/server/finance-invoices/invoice-workspace-service";
import { listPayablesWorkspace } from "@/server/finance-payables/payable-workspace-service";
import { listPaymentsWorkspace } from "@/server/finance-payments/payment-workspace-service";

import { buildReportResult } from "../result-builder";
import { mapSourceError } from "../source-errors";
import type { AppliedReportFilters, ReportResult, ReportRow, ReportsServiceResult } from "../types";

// Section 12: Finance Status - Agreement/Payable/Invoice/Payment lifecycle + role-safe amount status,
// each sourced through its own module's already-safe, already-bounded WORKSPACE list service (never a
// per-record detail fetch, so no N+1 fan-out). Every amount field is exactly what that module's own
// row DTO already exposes (already null, never a fabricated 0, whenever the actor lacks the
// finance_amounts sensitive category) - service base / GST / gross / TDS / expected-net / settlement
// are always reported under their own distinct metric id, never summed together.
const PAGE_SIZE = 50;

export async function runFinanceStatusReport(actor: ActorContext, appliedFilters: AppliedReportFilters): Promise<ReportsServiceResult<ReportResult>> {
  const generatedAt = new Date().toISOString();
  const partnerRef = appliedFilters.partnerRef;
  const status = appliedFilters.status;

  const [agreements, payables, invoices, payments] = await Promise.all([
    listAgreementsWorkspace(actor, {}, {}),
    listPayablesWorkspace(actor, { limit: PAGE_SIZE }),
    listInvoicesWorkspace(actor, { limit: PAGE_SIZE }),
    listPaymentsWorkspace(actor, { limit: PAGE_SIZE }),
  ]);
  for (const result of [agreements, payables, invoices, payments]) {
    if (!result.ok) return mapSourceError(result);
  }
  if (!agreements.ok || !payables.ok || !invoices.ok || !payments.ok) return { ok: false, code: "internal", message: "Unreachable." };

  const agreementRows = agreements.data.rows.filter((row) => (partnerRef ? row.counterparty.ref === partnerRef : true)).filter((row) => (status ? row.lifecycle === status : true));
  const payableRows = payables.data.rows.filter((row) => (partnerRef ? row.counterparty.ref === partnerRef : true)).filter((row) => (status ? row.status === status : true));
  const invoiceRows = invoices.data.rows.filter((row) => (partnerRef ? row.counterparty.ref === partnerRef : true)).filter((row) => (status ? row.status === status : true));
  const paymentRows = payments.data.rows.filter((row) => (partnerRef ? row.counterparty.ref === partnerRef : true)).filter((row) => (status ? row.status === status : true));

  const activeAgreementCount = agreementRows.filter((row) => row.lifecycle === "ACTIVE").length;
  const sumOrNull = (values: (number | null)[]): number | null => values.reduce<number | null>((acc, v) => (v === null ? acc : (acc ?? 0) + v), null);
  const payableTotalAmountMinorSigned = sumOrNull(payableRows.map((row) => row.totalAmountMinorSigned));
  const invoiceDeclaredGrossMinor = sumOrNull(invoiceRows.map((row) => row.declaredTotalMinor));
  const paymentSettledMinor = sumOrNull(paymentRows.filter((row) => row.status === "CONFIRMED").map((row) => row.amountMinor));

  const rows: ReportRow[] = [
    ...agreementRows.map((row) => ({ kind: "agreement" as const, ref: row.agreementRef, counterparty: row.counterparty.displayName, status: row.lifecycle, amountMinor: null })),
    ...payableRows.map((row) => ({ kind: "payable" as const, ref: row.payableRef, counterparty: row.counterparty.displayName, status: row.status, amountMinor: row.totalAmountMinorSigned })),
    ...invoiceRows.map((row) => ({ kind: "invoice" as const, ref: row.invoiceRef, counterparty: row.counterparty.displayName, status: row.status, amountMinor: row.declaredTotalMinor })),
    ...paymentRows.map((row) => ({ kind: "payment" as const, ref: row.paymentRef, counterparty: row.counterparty.displayName, status: row.status, amountMinor: row.amountMinor })),
  ];

  // Bug class B fix (this stage's completion report): the FOUR *WorkspaceRowDto shapes above each
  // carry `counterparty` as a NESTED OBJECT ({type, ref, displayName, ...}) - the combined `rows` array
  // above already correctly flattens it to a plain displayName string per row, but `sections` below
  // previously passed the RAW workspace rows straight through (agreementRows/payableRows/etc, not the
  // flattened rows above), which handed buildGenericTable a `counterparty` column whose actual runtime
  // value is an object, not a scalar - the exact shape that crashes wrapText's own `text.split(...)`
  // (a `string` is assumed, but a real object was there) once rendered as a PDF table cell. Each
  // section below is now its own flat, scalar-only projection, with the resolved counterparty
  // displayName kept as the PRIMARY column and the raw *Ref demoted to the end (further reinforced,
  // generically, by report-sections/helpers.ts's own orderColumnsForDisplay).
  const agreementSectionRows: ReportRow[] = agreementRows.map((row) => ({
    counterpartyDisplayName: row.counterparty.displayName,
    counterpartyType: row.counterparty.type,
    lifecycle: row.lifecycle,
    agreementNumber: row.agreementNumber,
    agreementType: row.agreementType,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    awaitingActivation: row.awaitingActivation,
    kycState: row.kyc.state,
    hasDiscrepancy: row.hasDiscrepancy,
    agreementRef: row.agreementRef,
  }));
  const payableSectionRows: ReportRow[] = payableRows.map((row) => ({
    counterpartyDisplayName: row.counterparty.displayName,
    counterpartyType: row.counterparty.type,
    commercialPeriod: row.commercialPeriod,
    status: row.status,
    sourceType: row.sourceType,
    totalAmountMinorSigned: row.totalAmountMinorSigned,
    determinationState: row.determinationState,
    payableRef: row.payableRef,
  }));
  const invoiceSectionRows: ReportRow[] = invoiceRows.map((row) => ({
    counterpartyDisplayName: row.counterparty.displayName,
    counterpartyType: row.counterparty.type,
    commercialPeriod: row.commercialPeriod,
    status: row.status,
    externalInvoiceNumber: row.externalInvoiceNumber,
    declaredTotalMinor: row.declaredTotalMinor,
    reconciliationState: row.reconciliationState,
    invoiceRef: row.invoiceRef,
  }));
  const paymentSectionRows: ReportRow[] = paymentRows.map((row) => ({
    counterpartyDisplayName: row.counterparty.displayName,
    counterpartyType: row.counterparty.type,
    status: row.status,
    amountMinor: row.amountMinor,
    method: row.method,
    paymentRef: row.paymentRef,
  }));

  const truncated = agreements.data.disclosure.headsTruncated || payables.data.disclosure.headsTruncated || invoices.data.disclosure.headsTruncated || payments.data.disclosure.headsTruncated;

  return {
    ok: true,
    data: buildReportResult({
      reportId: "finance_status",
      generatedAt,
      evidenceCutoff: generatedAt,
      appliedFilters,
      scopeSummary: { basis: "actor-scope (listAgreementsWorkspace/listPayablesWorkspace/listInvoicesWorkspace/listPaymentsWorkspace)", note: partnerRef ? "Filtered to the requested Partner/Vendor counterparty ref." : "Every actor-scoped Finance record across all four modules." },
      metrics: { activeAgreementCount, payableTotalAmountMinorSigned, invoiceDeclaredGrossMinor, paymentSettledMinor },
      rows,
      sections: { agreements: agreementSectionRows, payables: payableSectionRows, invoices: invoiceSectionRows, payments: paymentSectionRows },
      truncated,
      rowCount: rows.length,
      provenance: [
        { sourceModule: "finance-agreements", sourceFunction: "listAgreementsWorkspace", recordCount: agreementRows.length, scanned: agreements.data.disclosure.headsRead },
        { sourceModule: "finance-payables", sourceFunction: "listPayablesWorkspace", recordCount: payableRows.length, scanned: payables.data.disclosure.headsRead },
        { sourceModule: "finance-invoices", sourceFunction: "listInvoicesWorkspace", recordCount: invoiceRows.length, scanned: invoices.data.disclosure.headsRead },
        { sourceModule: "finance-payments", sourceFunction: "listPaymentsWorkspace", recordCount: paymentRows.length, scanned: payments.data.disclosure.headsRead },
      ],
    }),
  };
}

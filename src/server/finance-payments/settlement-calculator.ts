import type { PaymentSettlementState, PaymentStatus } from "./types";

// Step 17A section 9: the PURE settlement calculator. No Firestore, no actor, no side effects -
// just integers in, a settlement summary out. Both the live read-only settlement projection
// (payment-lifecycle-service.ts's getInvoicePaymentSettlement) and this module's own unit tests
// call this exact function, so "what the API returns" and "what is tested" can never drift apart.
//
// ONLY CONFIRMED payments reduce the remaining amount (section 9) - RECORDED is pending/not yet
// settled, FAILED/VOID never count toward anything. A negative `remainingMinor` never appears:
// once confirmed exceeds expected, `remainingMinor` clamps to 0 and the excess is reported
// separately as `overpaidByMinor`, so a caller can't misread "remaining" as "we still owe more"
// when actually too much has already moved.

export type SettlementInputPayment = { status: PaymentStatus; amountMinor: number };

export type PaymentSettlementSummary = {
  expectedNetPaymentMinor: number | null;
  confirmedPaidMinor: number;
  recordedPendingMinor: number;
  failedMinor: number;
  remainingMinor: number | null;
  overpaidByMinor: number;
  state: PaymentSettlementState;
  warnings: string[];
};

export function computeSettlement(expectedNetPaymentMinor: number | null, payments: readonly SettlementInputPayment[]): PaymentSettlementSummary {
  const sumOf = (status: PaymentStatus) => payments.filter((p) => p.status === status).reduce((sum, p) => sum + p.amountMinor, 0);

  const confirmedPaidMinor = sumOf("CONFIRMED");
  const recordedPendingMinor = sumOf("RECORDED");
  const failedMinor = sumOf("FAILED");

  const warnings: string[] = [];

  if (expectedNetPaymentMinor === null) {
    warnings.push("The expected net payment for this invoice is not available, so settlement cannot be determined precisely.");
    return { expectedNetPaymentMinor: null, confirmedPaidMinor, recordedPendingMinor, failedMinor, remainingMinor: null, overpaidByMinor: 0, state: "REVIEW_REQUIRED", warnings };
  }

  const overpaidByMinor = Math.max(0, confirmedPaidMinor - expectedNetPaymentMinor);
  const remainingMinor = Math.max(0, expectedNetPaymentMinor - confirmedPaidMinor);

  let state: PaymentSettlementState;
  if (overpaidByMinor > 0) {
    state = "OVERPAID";
    warnings.push(`Confirmed payments exceed the expected net payment by ${overpaidByMinor} minor units.`);
  } else if (confirmedPaidMinor === expectedNetPaymentMinor && expectedNetPaymentMinor > 0) {
    state = "PAID";
  } else if (confirmedPaidMinor > 0) {
    state = "PARTIALLY_PAID";
  } else {
    state = "UNPAID";
  }

  if (recordedPendingMinor > 0 && confirmedPaidMinor + recordedPendingMinor > expectedNetPaymentMinor) {
    warnings.push("Recorded (pending) payments would exceed the expected net payment if all were confirmed as-is.");
  }

  return { expectedNetPaymentMinor, confirmedPaidMinor, recordedPendingMinor, failedMinor, remainingMinor, overpaidByMinor, state, warnings };
}

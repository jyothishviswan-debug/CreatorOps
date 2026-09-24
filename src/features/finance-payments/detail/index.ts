// Step 17B: the Payment detail record (/finance/payments/[paymentRef]). The server page
// (src/app/finance/payments/[paymentRef]/page.tsx) resolves the actor, reads the Payment and hands
// both here.
export { PaymentDetail } from "./PaymentDetail";
export { parseDetailTab, type DetailTabKey } from "./detail-view";

// Production hardening (base spec section 6 - Agreement/Finance privacy hardening, carried debt item
// 7): the retention policy for financeAgreementRestrictedExtractions.
//
// What this record is, and isn't: extraction-service.ts's own header comment already draws the line
// - "Nothing extracted is operational, whatever the status." A restricted extraction record holds raw
// contract SNIPPETS/locators and raw identity VALUES an automated parser/OCR pass read off an
// uploaded PDF - transient supporting evidence for a human to review, never itself the Agreement's
// canonical business record. The canonical record is the immutable, versioned
// financeAgreements/{ref}/versions document a human CONFIRMED.
//
// Why this file defines a policy WITHOUT executing it: this module carries its own deliberate,
// mechanically-enforced architectural invariant (finance-agreements-boundary.test.ts's "no deletes on
// Agreement data", finance-agreements-static.test.ts's "no delete of any kind, and no exported
// delete/remove/purge function" - a static source-scan guard, not incidental) - this domain never
// deletes anything, anywhere, full stop. That is a deliberate prior design decision this hardening
// pass does not have standing to unilaterally reverse on its own judgment: raw contract-adjacent
// extraction text can still carry real legal/tax/audit retention obligations depending on
// jurisdiction and business context (which this stage was explicitly told not to invent - see the
// base spec's own "If retention is legally/business-required but not specified, define a
// configurable policy boundary rather than inventing a legal retention period"), and
// reconciliation-service.ts's own identity-value read (`restricted?.runRef`) proves raw extraction
// data can still be a legitimate, ongoing Finance-reconciliation input well after an Agreement
// version is confirmed - an automated deletion path is a materially bigger, more irreversible change
// than this stage's other narrow fixes, and deserves an explicit business decision to lift that
// invariant, not a hardening-pass judgment call.
//
// What this stage DOES ship, in full: the configurable retention-window boundary itself
// (getFinanceAgreementRestrictedExtractionRetentionDays, src/lib/env/server.ts - unset by default,
// so today's actual behavior, indefinite retention, is completely unchanged unless an operator
// deliberately configures a real value for their own legal/business context) and the pure,
// independently-testable eligibility RULE below. Together they are the "configurable policy
// boundary" + "document...the rule" the base spec asks for. Actually executing a purge against this
// domain's data remains RELEASE-ONLY: it needs an explicit product/legal decision to lift the
// existing no-delete invariant (and, at that point, to also decide financeAgreementOcrRuns' own
// separate, hash-keyed-cache retention question, which this file does not attempt).
export function isRestrictedExtractionPurgeEligible(createdAt: string, retentionDays: number | null, now: Date = new Date()): boolean {
  if (retentionDays === null) return false; // no configured window => never auto-eligible (safe default)
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return false;
  const elapsedDays = (now.getTime() - createdMs) / (1000 * 60 * 60 * 24);
  return elapsedDays >= retentionDays;
}

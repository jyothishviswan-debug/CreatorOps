import { randomUUID } from "node:crypto";

// Opaque, browser-facing handles: a fixed prefix + 20 random hex characters. They encode
// nothing about the underlying Firestore doc id or any user. Resolution is always a
// strict-equality lookup, and every input schema validates the exact shape
// (agreementRefSchema / artifactRefSchema / extractionRunRefSchema in types.ts).
function randomHex20(): string {
  return randomUUID().replace(/-/g, "").slice(0, 20);
}

export function generateAgreementRef(): string {
  return `agr_${randomHex20()}`;
}

export function generateContractArtifactRef(): string {
  return `ca_${randomHex20()}`;
}

export function generateExtractionRunRef(): string {
  return `run_${randomHex20()}`;
}

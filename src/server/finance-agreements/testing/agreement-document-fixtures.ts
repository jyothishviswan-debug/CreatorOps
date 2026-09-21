import type { ContractArtifactStore } from "../contract-artifacts/store";
import { CONTRACT_PDF_MIME_TYPE, sha256Hex } from "../contract-artifacts/validation";
import { createInMemoryAgreementDocumentStorage, setAgreementDocumentStorageForTests, type FakeAgreementDocumentStorage } from "../document-storage";
import { financeContractArtifactsCollection } from "../firestore";
import { generateContractArtifactRef } from "../ids";
import { contractArtifactDocSchema, type ContractArtifactDoc, type CounterpartyType } from "../types";

import { makeTextPdf } from "./pdf-fixtures";

// Step 14B.1 test support: byte-backed contract artifacts and the fake Agreement-document storage. Test-only.
// (Older Finance fixtures seed artifact METADATA with no bytes behind it; anything that stores an Agreement document needs the real
// bytes in the ContractArtifactStore, because the document is read back from there and checksum-verified.)

// A small valid PDF whose bytes are unique per `label` (so two Agreements never share a checksum by accident).
export function samplePdfBytes(label: string): Buffer {
  return makeTextPdf([[`Synthetic signed Agreement - ${label}`, "This file is invented test data."]]);
}

export type ByteBackedArtifact = { artifact: ContractArtifactDoc; bytes: Buffer; docRef: FirebaseFirestore.DocumentReference };

// Writes real bytes to the artifact store AND the matching metadata doc (correct locator, size and sha256).
export async function seedByteBackedArtifact(input: { type: CounterpartyType; ref: string; artifactStore: ContractArtifactStore; bytes?: Buffer; label?: string; fileName?: string }): Promise<ByteBackedArtifact> {
  const bytes = input.bytes ?? samplePdfBytes(input.label ?? generateContractArtifactRef());
  const artifactRef = generateContractArtifactRef();
  const storageLocator = await input.artifactStore.put({ artifactRef, bytes, mimeType: CONTRACT_PDF_MIME_TYPE });
  const artifact = contractArtifactDocSchema.parse({
    artifactRef,
    fileName: input.fileName ?? "signed-agreement.pdf",
    mimeType: CONTRACT_PDF_MIME_TYPE,
    sizeBytes: bytes.byteLength,
    sha256: sha256Hex(bytes),
    uploadedByUserRef: "adoc-test",
    uploadedAt: new Date().toISOString(),
    counterparty: { type: input.type, ref: input.ref },
    status: "EXTRACTED",
    storageLocator,
  });
  const docRef = financeContractArtifactsCollection().doc(artifactRef);
  await docRef.set(artifact);
  return { artifact, bytes, docRef };
}

// Installs a fresh fake storage as the test override and returns it; call the returned `restore` (afterAll / finally) to remove it.
export function installFakeAgreementDocumentStorage(): { storage: FakeAgreementDocumentStorage; restore: () => void } {
  const storage = createInMemoryAgreementDocumentStorage();
  setAgreementDocumentStorageForTests(storage);
  return { storage, restore: () => setAgreementDocumentStorageForTests(null) };
}

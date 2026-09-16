// Minimal stand-in for the slice of the Admin Firestore SDK this module
// actually uses (`.collection(x).doc(y).get()`), keyed by "collection/docId".
// A key mapped to `undefined` simulates a genuinely missing document.
export type FakeDocs = Record<string, Record<string, unknown> | undefined>;

export function makeFakeFirestore(docs: FakeDocs) {
  return {
    collection: (collectionName: string) => ({
      doc: (docId: string) => ({
        get: async () => {
          const data = docs[`${collectionName}/${docId}`];
          return {
            exists: data !== undefined,
            data: () => data,
          };
        },
      }),
    }),
  };
}

// Minimal stand-in for the slice of the Admin Firestore SDK this module
// actually uses: `.collection(x).doc(y).get()` for single-document reads,
// and `.collection(x).where(field, "==", value).limit(n).get()` for the
// bounded scope-grant query. A key mapped to `undefined` simulates a
// genuinely missing document.
export type FakeDocs = Record<string, Record<string, unknown> | undefined>;

export function makeFakeFirestore(docs: FakeDocs) {
  function docsIn(collectionName: string): { id: string; data: Record<string, unknown> }[] {
    const prefix = `${collectionName}/`;
    return Object.entries(docs)
      .filter((entry): entry is [string, Record<string, unknown>] => entry[0].startsWith(prefix) && entry[1] !== undefined)
      .map(([key, data]) => ({ id: key.slice(prefix.length), data }));
  }

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
      where: (field: string, _op: "==", value: unknown) => ({
        limit: (n: number) => ({
          get: async () => {
            const matched = docsIn(collectionName)
              .filter((entry) => entry.data[field] === value)
              .slice(0, n);
            return { docs: matched.map((entry) => ({ id: entry.id, data: () => entry.data })) };
          },
        }),
      }),
    }),
  };
}

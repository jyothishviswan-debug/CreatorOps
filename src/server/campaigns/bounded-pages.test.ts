import { describe, expect, it } from "vitest";

import { BOUNDED_PAGE_SIZE, collectBounded, MAX_RELEVANT_ITEMS_PER_CAMPAIGN, MAX_SCANNED_ROWS_PER_CAMPAIGN } from "./bounded-pages";

// Step 12C.2: the shared cursor-following primitive, exercised against a
// fake page source that mimics listAssignmentDocs/listContentDocs exactly:
// a request is clamped to 100 rows, and `nextCursor` is non-null only when
// the page is full AND more rows remain.

type Row = { id: number; relevant: boolean };

function makeSource(rows: Row[]) {
  const calls: Array<{ limit: number; cursor: number | undefined }> = [];
  const fetchPage = async (limit: number, cursor: number | undefined) => {
    calls.push({ limit, cursor });
    const size = Math.min(limit, BOUNDED_PAGE_SIZE);
    const start = cursor ?? 0;
    const items = rows.slice(start, start + size);
    const next = start + items.length;
    return { items, nextCursor: items.length === size && next < rows.length ? next : null };
  };
  return { fetchPage, calls };
}

const relevantRows = (count: number): Row[] => Array.from({ length: count }, (_, id) => ({ id, relevant: true }));
const select = (row: Row) => (row.relevant ? row.id : null);

describe("collectBounded - relevant-item bound", () => {
  it("documents the constants: 200 relevant items, 500 scanned rows, 100 per page", () => {
    expect(MAX_RELEVANT_ITEMS_PER_CAMPAIGN).toBe(200);
    expect(MAX_SCANNED_ROWS_PER_CAMPAIGN).toBe(500);
    expect(BOUNDED_PAGE_SIZE).toBe(100);
  });

  it.each([0, 1, 99, 100, 101, 150, 200])("fully represents %i relevant rows, not truncated", async (count) => {
    const source = makeSource(relevantRows(count));
    const result = await collectBounded({ fetchPage: source.fetchPage, select });
    expect(result.items).toHaveLength(count);
    expect(result.items).toEqual(Array.from({ length: count }, (_, i) => i));
    expect(result.truncated).toBe(false);
  });

  it("101 rows needs a second page (the old single-page read stopped at 100)", async () => {
    const source = makeSource(relevantRows(101));
    const result = await collectBounded({ fetchPage: source.fetchPage, select });
    expect(result.items).toHaveLength(101);
    expect(source.calls.map((c) => c.cursor)).toEqual([undefined, 100]);
  });

  it("201 relevant rows keeps the first 200 and reports truncated", async () => {
    const source = makeSource(relevantRows(201));
    const result = await collectBounded({ fetchPage: source.fetchPage, select });
    expect(result.items).toHaveLength(200);
    expect(result.items[199]).toBe(199);
    expect(result.truncated).toBe(true);
  });

  it("well over 200 relevant rows is still truncated with exactly 200 kept, without reading everything", async () => {
    const source = makeSource(relevantRows(450));
    const result = await collectBounded({ fetchPage: source.fetchPage, select });
    expect(result.items).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(result.scannedRows).toBeLessThanOrEqual(MAX_SCANNED_ROWS_PER_CAMPAIGN);
    expect(source.calls.length).toBeLessThanOrEqual(3);
  });

  it("follows deterministic cursors in order - no gaps, no duplicates across pages", async () => {
    const source = makeSource(relevantRows(200));
    const result = await collectBounded({ fetchPage: source.fetchPage, select });
    expect(new Set(result.items).size).toBe(200);
    expect(source.calls.map((c) => c.cursor)).toEqual([undefined, 100]);
  });
});

describe("collectBounded - irrelevant rows never consume the budget", () => {
  it("DRAFT/CANCELLED-like rows interleaved with exactly 200 relevant rows: all 200 kept, not truncated", async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 200; i += 1) {
      rows.push({ id: rows.length, relevant: true });
      if (i % 2 === 0) rows.push({ id: rows.length, relevant: false });
    }
    // 300 scanned rows, 200 relevant.
    const source = makeSource(rows);
    const result = await collectBounded({ fetchPage: source.fetchPage, select });
    expect(result.items).toHaveLength(200);
    expect(result.truncated).toBe(false);
    expect(result.scannedRows).toBe(300);
  });

  it("150 relevant rows behind 100 irrelevant ones are all still found", async () => {
    const rows: Row[] = [...Array.from({ length: 100 }, (_, id) => ({ id, relevant: false })), ...Array.from({ length: 150 }, (_, i) => ({ id: 100 + i, relevant: true }))];
    const result = await collectBounded({ fetchPage: makeSource(rows).fetchPage, select });
    expect(result.items).toHaveLength(150);
    expect(result.truncated).toBe(false);
  });

  it("201 relevant rows mixed with irrelevant ones is truncated at 200 relevant", async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 201; i += 1) {
      rows.push({ id: rows.length, relevant: true });
      rows.push({ id: rows.length, relevant: false });
    }
    // 402 scanned rows (under the 500 ceiling).
    const result = await collectBounded({ fetchPage: makeSource(rows).fetchPage, select });
    expect(result.items).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it("irrelevant tail after exactly 200 relevant rows, fully scanned, is NOT truncated", async () => {
    const rows: Row[] = [...relevantRows(200), ...Array.from({ length: 50 }, (_, i) => ({ id: 200 + i, relevant: false }))];
    const result = await collectBounded({ fetchPage: makeSource(rows).fetchPage, select });
    expect(result.items).toHaveLength(200);
    expect(result.truncated).toBe(false);
  });
});

describe("collectBounded - hard scan ceiling", () => {
  it("stops at 500 scanned rows with pages remaining and reports truncated, even with zero relevant rows", async () => {
    const rows: Row[] = Array.from({ length: 800 }, (_, id) => ({ id, relevant: false }));
    const source = makeSource(rows);
    const result = await collectBounded({ fetchPage: source.fetchPage, select });
    expect(result.items).toEqual([]);
    expect(result.scannedRows).toBe(500);
    expect(result.pagesFetched).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it("exactly 500 scanned rows and no further page is NOT truncated", async () => {
    const rows: Row[] = Array.from({ length: 500 }, (_, id) => ({ id, relevant: id % 5 === 0 }));
    const result = await collectBounded({ fetchPage: makeSource(rows).fetchPage, select });
    expect(result.items).toHaveLength(100);
    expect(result.scannedRows).toBe(500);
    expect(result.truncated).toBe(false);
  });

  it("501 scanned rows (a sixth page exists) is truncated", async () => {
    const rows: Row[] = Array.from({ length: 501 }, (_, id) => ({ id, relevant: id % 5 === 0 }));
    const result = await collectBounded({ fetchPage: makeSource(rows).fetchPage, select });
    expect(result.scannedRows).toBe(500);
    expect(result.truncated).toBe(true);
  });

  it("never requests more than the remaining scan budget or one page", async () => {
    const source = makeSource(Array.from({ length: 900 }, (_, id) => ({ id, relevant: false })));
    await collectBounded({ fetchPage: source.fetchPage, select, maxScannedRows: 250 });
    expect(source.calls.map((c) => c.limit)).toEqual([100, 100, 50]);
  });

  it("a page that reports a next cursor but returns nothing cannot loop forever", async () => {
    const result = await collectBounded<Row, number, string>({ fetchPage: async () => ({ items: [], nextCursor: "again" }), select });
    expect(result.truncated).toBe(true);
    expect(result.pagesFetched).toBe(1);
  });
});

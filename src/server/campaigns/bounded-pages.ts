// Step 12C.2: the one shared, dependency-free, bounded cursor-following
// primitive behind Campaign Overview's obligation read
// (execution-integration-service.ts) and Campaign Detail's downstream
// summary (detail-downstream-service.ts). A LEAF module on purpose - it
// imports nothing from either service, so neither can create an import cycle.
//
// Why it exists: listAssignmentDocs/listContentDocs clamp a single page to
// 100 rows (MAX_ASSIGNMENT_PAGE_SIZE / MAX_CONTENT_PAGE_SIZE), so passing a
// larger `limit` silently yields only the first 100. The documented
// per-Campaign bound is therefore reached by FOLLOWING the deterministic
// cursor page by page - never by a fetch-all, never from the browser, never
// one lookup per row.
//
// The bound is expressed in RELEVANT items, not scanned rows: a
// caller-supplied `select` decides which scanned rows count (e.g. only
// ASSIGNED/ACCEPTED/IN_PROGRESS/COMPLETED Assignments are obligations), so
// DRAFT/CANCELLED rows never consume the relevant-item budget. A separate,
// hard scan ceiling caps the total rows ever read, so a Campaign full of
// irrelevant rows can never turn into an unbounded loop.

// Per-Campaign bound on RELEVANT items (obligations / non-cancelled
// Assignments). Both list functions order newest first (createdAt
// descending, ties broken by document id), so "the first 200" is the 200
// most recently created.
export const MAX_RELEVANT_ITEMS_PER_CAMPAIGN = 200;

// Hard ceiling on rows SCANNED per Campaign per collection: 5 pages of 100.
// Reaching it with pages still remaining means the result is incomplete
// (truncated) even if fewer than 200 relevant rows were found.
export const MAX_SCANNED_ROWS_PER_CAMPAIGN = 500;

// The page size both list functions clamp to (100).
export const BOUNDED_PAGE_SIZE = 100;

export type BoundedPage<Raw, Cursor> = { items: Raw[]; nextCursor: Cursor | null };

export type CollectBoundedOptions<Raw, Item, Cursor> = {
  // Fetch one page of at most `limit` rows after `cursor` (undefined = first
  // page). The caller wires this to listAssignmentDocs/listContentDocs with
  // its own scope inputs, so scope is applied BEFORE any row is returned.
  fetchPage: (limit: number, cursor: Cursor | undefined) => Promise<BoundedPage<Raw, Cursor>>;
  // Returns the projected item when the row is relevant, or null to skip it
  // (skipped rows still count against the scan ceiling, never the item bound).
  select: (row: Raw) => Item | null;
  maxItems?: number;
  maxScannedRows?: number;
  pageSize?: number;
};

export type CollectBoundedResult<Item> = {
  // At most `maxItems` relevant items, in the deterministic list order.
  items: Item[];
  // true iff the result is incomplete: a (maxItems + 1)th relevant row
  // exists, OR the scan ceiling was hit while more pages remain.
  truncated: boolean;
  scannedRows: number;
  pagesFetched: number;
};

export async function collectBounded<Raw, Item, Cursor>(options: CollectBoundedOptions<Raw, Item, Cursor>): Promise<CollectBoundedResult<Item>> {
  const maxItems = options.maxItems ?? MAX_RELEVANT_ITEMS_PER_CAMPAIGN;
  const maxScannedRows = options.maxScannedRows ?? MAX_SCANNED_ROWS_PER_CAMPAIGN;
  const pageSize = options.pageSize ?? BOUNDED_PAGE_SIZE;

  const items: Item[] = [];
  let scannedRows = 0;
  let pagesFetched = 0;
  let cursor: Cursor | undefined = undefined;

  for (;;) {
    // The previous page reported a further page, but the scan ceiling is
    // spent: the result is incomplete.
    if (scannedRows >= maxScannedRows) return { items, truncated: true, scannedRows, pagesFetched };

    const page: BoundedPage<Raw, Cursor> = await options.fetchPage(Math.min(pageSize, maxScannedRows - scannedRows), cursor);
    pagesFetched += 1;

    for (const row of page.items) {
      scannedRows += 1;
      const item = options.select(row);
      if (item === null) continue;
      // A (maxItems + 1)th relevant row exists: keep the first maxItems only.
      if (items.length >= maxItems) return { items, truncated: true, scannedRows, pagesFetched };
      items.push(item);
    }

    if (!page.nextCursor) return { items, truncated: false, scannedRows, pagesFetched };
    // Defensive: a page that reports a next cursor but returned nothing makes
    // no progress against the scan ceiling - stop rather than loop.
    if (page.items.length === 0) return { items, truncated: true, scannedRows, pagesFetched };
    cursor = page.nextCursor;
  }
}

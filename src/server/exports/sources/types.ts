// Shared option shape for every source fetcher (section 8's preview requirement: preview and
// generation share the exact same fetcher, differing only in the bound they request - never a second,
// independently-written query). `limit` is always REQUIRED (never a fetcher-local default) so a
// caller (export-service.ts) is always the one deciding the bound - generation passes the target's own
// maxRows, preview passes the same maxRows too (see export-service.ts's own comment on why: it is the
// identical bounded query generation would run, so the exact row-count/truncation signal preview shows
// is never a guess).
export type FetchRowsOptions = { limit: number };

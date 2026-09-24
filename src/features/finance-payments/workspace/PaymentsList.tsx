"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import { Pager } from "@/features/administration/Pager";
import { EmptyState, Skeleton } from "@/ui/States";
import type { PaymentRowDto, PaymentWorkspaceDto } from "@/server/finance-payments/client-dto";

import { loadPaymentsWorkspace } from "../api-client";
import { PaymentCards, PaymentsTable } from "./PaymentRows";
import { PAGE_ERROR_TITLE, pageStatusCopy, workspaceEmptyCopy } from "./workspace-copy";
import { toWorkspaceRequest, type WorkspaceUrlState } from "./workspace-query";
import { NEW_PAYMENT_HREF, toWorkspaceRowView } from "./workspace-view-model";
import type { WorkspaceLayout } from "./WorkspaceToolbar";

// Step 17B: one filter state's list of Payment rows. It is REMOUNTED (React `key` = the canonical
// URL state) whenever a filter changes, so its page cache can never leak across filters. Page 1 is
// the server-rendered `initial`; every further page is ONE bounded cursor request - nothing is
// fetched whole, nothing is filtered or sorted in the browser (the server's order is deterministic
// and kept as received).
export function PaymentsList({ initial, state, layout, anyFilterActive, onClearFilters }: { initial: PaymentWorkspaceDto; state: WorkspaceUrlState; layout: WorkspaceLayout; anyFilterActive: boolean; onClearFilters: () => void }) {
  const [pages, setPages] = useState<PaymentRowDto[][]>([initial.rows]);
  const [nextCursors, setNextCursors] = useState<(string | null)[]>([initial.nextCursor]);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function goToPage(page: number) {
    if (page < 1 || page === currentPage || busyRef.current) return;
    if (page <= pages.length) {
      setError(null);
      setCurrentPage(page);
      return;
    }
    const cursor = nextCursors[page - 2];
    if (page > pages.length + 1 || !cursor) return;

    busyRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    const result = await loadPaymentsWorkspace(toWorkspaceRequest(state, { cursor }), { signal: controller.signal });
    if (result.ok === false && result.aborted) return;
    busyRef.current = false;
    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPages((previous) => [...previous, result.data.rows]);
    setNextCursors((previous) => [...previous, result.data.nextCursor]);
    setCurrentPage(page);
  }

  const pageRows = pages[currentPage - 1] ?? [];
  const amountsVisible = initial.permissions.canViewAmounts;
  const views = pageRows.map((row) => toWorkspaceRowView(row, amountsVisible));
  const hasMore = nextCursors[currentPage - 1] != null;
  const { disclosure, permissions } = initial;
  const emptyCopy = workspaceEmptyCopy({ headsRead: disclosure.headsRead, headsTruncated: disclosure.headsTruncated, anyFilterActive, canManage: permissions.canManage });
  const noPaymentsAtAll = !anyFilterActive && !disclosure.headsTruncated;

  return (
    <>
      {error && (
        <div className="banner" role="alert" style={{ margin: "0 18px 15px" }}>
          <b>{PAGE_ERROR_TITLE}</b> {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "0 18px 18px" }} aria-hidden="true" data-testid="workspace-loading">
          <Skeleton lines={5} />
        </div>
      ) : views.length === 0 ? (
        <EmptyState
          title={emptyCopy.title}
          description={emptyCopy.description}
          icon={anyFilterActive ? "search" : "file"}
          action={
            anyFilterActive ? (
              <button className="btn" type="button" onClick={onClearFilters}>
                Clear filters
              </button>
            ) : noPaymentsAtAll && permissions.canManage ? (
              <Link className="btn primary" href={NEW_PAYMENT_HREF}>
                Record Payment
              </Link>
            ) : undefined
          }
        />
      ) : layout === "cards" ? (
        <PaymentCards rows={views} />
      ) : (
        <PaymentsTable rows={views} />
      )}

      <div className="panelfoot" style={{ flexWrap: "wrap", alignItems: "center" }}>
        <span data-testid="workspace-page-status">{pageStatusCopy(currentPage, pageRows.length)}</span>
        <Pager currentPage={currentPage} knownPages={pages.length} hasMore={hasMore} busy={loading} onChange={goToPage} />
      </div>
    </>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { Panel, PanelBody, PanelGrid, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import type { VendorPartnerLinkWithPartnerDto } from "@/server/vendors/client-dto";
import { listVendorPartnerLinks } from "./api-client";
import { effectiveDateLabel, LINK_STATUS_LABELS, linkStatusTone, RELATIONSHIP_TYPE_LABELS } from "./format";

// Step 8B section 8: truthful payee/commercial CONTEXT only, derived
// entirely from this Vendor's own real relationship rows - never Finance
// truth. Company policy caps a Partner to at most one ACTIVE Vendor at a
// time (see vendorPartnerLinkDocSchema's own comment), so every ACTIVE
// relationship on this Vendor IS, by construction, the one party
// currently handling that Partner's operations and payments - there is
// no separate "payee" sub-flag to filter by anymore. Agreements/
// Payables/Invoices/Payments don't exist yet, so those are shown as an
// honest "not yet built" state rather than a fabricated number, count,
// or amount.
export function VendorPayeeContextPanel({ vendorRef }: { vendorRef: string }) {
  const [links, setLinks] = useState<VendorPartnerLinkWithPartnerDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listVendorPartnerLinks(vendorRef).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLinks(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [vendorRef]);

  const activeLinks = links.filter((l) => l.status === "ACTIVE");

  return (
    <>
      <PanelGrid>
        <Panel span={12}>
          <PanelHead
            title="Payee / Commercial Context"
            description="This Vendor's currently active Partner relationships - each one is the sole party handling that Partner's operations and payments. Context for future Agreement/Finance truth, not Finance truth itself."
          />
          <PanelBody>
            {loading ? (
              <Skeleton lines={2} />
            ) : error ? (
              <div className="banner" role="alert">
                {error}
              </div>
            ) : activeLinks.length === 0 ? (
              <EmptyState title="No active relationships on file" description="This Vendor has no currently active Partner relationship." icon="wallet" />
            ) : (
              activeLinks.map((link) => (
                <div className="record" key={link.vendorPartnerLinkRef} style={{ marginBottom: 10 }}>
                  <div className="recordmeta" style={{ justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <Link href={`/partners/${link.partnerRef}`} className="textlink">
                        <b>{link.partner.displayName}</b>
                      </Link>
                      <Pill tone={linkStatusTone(link.status)}> {LINK_STATUS_LABELS[link.status]}</Pill>
                      <Pill tone="default"> {RELATIONSHIP_TYPE_LABELS[link.relationshipType]}</Pill>
                      <div>
                        <small>
                          Effective {effectiveDateLabel(link.effectiveFrom)}
                          {link.effectiveTo ? ` – ${effectiveDateLabel(link.effectiveTo)}` : " – ongoing"}
                        </small>
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </PanelBody>
        </Panel>
      </PanelGrid>
      <PanelGrid>
        {(["Agreements", "Payables", "Invoices", "Payments"] as const).map((label) => (
          <Panel span={3} key={label}>
            <PanelHead title={label} />
            <PanelBody>
              <EmptyState title="Not yet built" description={`${label} has no real trusted source wired to Vendors yet.`} icon="clock" />
            </PanelBody>
          </Panel>
        ))}
      </PanelGrid>
    </>
  );
}

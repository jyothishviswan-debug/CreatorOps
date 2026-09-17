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
// entirely from this Vendor's own real relationship rows
// (payeeRole=true) - never Finance truth. Agreements/Payables/Invoices/
// Payments don't exist yet, so those are shown as an honest "not yet
// built" state rather than a fabricated number, count, or amount.
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

  const payeeLinks = links.filter((l) => l.payeeRole);

  return (
    <>
      <PanelGrid>
        <Panel span={12}>
          <PanelHead
            title="Payee / Commercial Context"
            description="Which Partner relationships carry the payee role, and their effective state - context for future Agreement/Finance truth, not Finance truth itself."
          />
          <PanelBody>
            {loading ? (
              <Skeleton lines={2} />
            ) : error ? (
              <div className="banner" role="alert">
                {error}
              </div>
            ) : payeeLinks.length === 0 ? (
              <EmptyState title="No payee relationships on file" description="No linked Partner relationship on this Vendor is currently marked as payee." icon="wallet" />
            ) : (
              payeeLinks.map((link) => (
                <div className="record" key={link.vendorPartnerLinkRef} style={{ marginBottom: 10 }}>
                  <div className="recordmeta" style={{ justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <Link href={`/partners/${link.partnerRef}`} className="textlink">
                        <b>{link.partner.displayName}</b>
                      </Link>
                      <Pill tone={linkStatusTone(link.status)}> {LINK_STATUS_LABELS[link.status]}</Pill>
                      <Pill tone="default"> {RELATIONSHIP_TYPE_LABELS[link.relationshipType]}</Pill>
                      <Pill tone="orange"> Payee</Pill>
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

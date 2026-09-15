import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { DetailView } from "@/ui/DetailView";
import { getVendorDetail } from "@/features/vendors/fixtures";

export default async function VendorDetailPage({
  params,
}: {
  params: Promise<{ vendorId: string }>;
}) {
  const { vendorId } = await params;
  const detail = getVendorDetail(vendorId);
  if (!detail) notFound();

  return (
    <AppShell>
      <DetailView moduleLabel="Vendors" workspaceHref="/vendors" detail={detail} />
    </AppShell>
  );
}

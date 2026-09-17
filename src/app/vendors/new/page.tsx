import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { VendorForm } from "@/features/vendors/VendorForm";

export default function NewVendorPage() {
  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">VENDORS / NEW VENDOR</div>
          <h1>Add a vendor</h1>
          <p>Start with the essentials. Relationships and restricted identity are captured afterward.</p>
        </div>
        <div className="actions">
          <Link href="/vendors" className="btn">
            Back to vendors
          </Link>
        </div>
      </div>

      <VendorForm />
    </AppShell>
  );
}

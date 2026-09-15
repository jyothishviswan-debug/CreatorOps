"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { FormLayout, FormSection, Fields, Field, FormFoot, Checklist } from "@/ui/Form";
import { Icon } from "@/ui/icons";

export default function NewVendorPage() {
  const router = useRouter();

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">VENDORS / NEW VENDOR</div>
          <h1>Add a vendor</h1>
          <p>Start with the essentials. Add supporting context where it helps.</p>
        </div>
        <div className="actions">
          <Link href="/vendors" className="btn">
            Back to vendors
          </Link>
        </div>
      </div>

      <FormLayout>
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            router.push("/vendors");
          }}
        >
          <FormSection title="Business essentials" description="Use canonical identifiers to keep the programme free of duplicates.">
            <Fields>
              <Field label="Business name">
                <input type="text" placeholder="Creator House" required />
              </Field>
              <Field label="Email address" hint="Use an illustrative address in this preview.">
                <input type="email" required />
              </Field>
              <Field label="Phone number" hint="Include the country code.">
                <input type="tel" />
              </Field>
              <Field label="Vendor type">
                <select>
                  <option>Agency</option>
                  <option>Manager</option>
                  <option>Payee</option>
                  <option>Other</option>
                </select>
              </Field>
              <Field label="Region">
                <select>
                  <option>Kerala</option>
                  <option>Maharashtra</option>
                  <option>Tamil Nadu</option>
                  <option>Karnataka</option>
                </select>
              </Field>
              <Field label="Relationship owner">
                <select>
                  <option>Meera Das</option>
                  <option>Ananya Rao</option>
                  <option>Arjun Nair</option>
                </select>
              </Field>
            </Fields>
          </FormSection>

          <FormSection title="Supporting context" description="Capture useful details without making the simple path complicated.">
            <Fields>
              <Field label="Notes" full>
                <textarea placeholder="Add relevant context…" />
              </Field>
            </Fields>
            <details style={{ marginTop: 17, fontSize: 12 }}>
              <summary style={{ cursor: "pointer" }}>Additional business details</summary>
              <p className="foundationnote" style={{ marginTop: 12 }}>
                Represented partners, payee identity, and business structure belong in
                progressive sections. Keep these details available without expanding every
                field by default.
              </p>
            </details>
          </FormSection>

          <FormFoot>
            <small>Preview only · entered values are not persisted</small>
            <div className="actions">
              <Link href="/vendors" className="btn">
                Cancel
              </Link>
              <button type="submit" className="btn primary">
                Review and save
              </button>
            </div>
          </FormFoot>
        </form>

        <aside className="panel">
          <div className="panelhead">
            <h2>A cleaner first step</h2>
          </div>
          <div className="panelbody">
            <Checklist>
              <li>
                <Icon name="check" /> Capture business identity
              </li>
              <li>
                <Icon name="check" /> Check duplicates automatically
              </li>
              <li>
                <Icon name="check" /> Assign an accountable owner
              </li>
              <li>
                <Icon name="check" /> Keep context with the record
              </li>
            </Checklist>
            <div className="scopebox">
              Duplicate checks appear inline in the full implementation. This preview does not
              perform live checks.
            </div>
          </div>
        </aside>
      </FormLayout>
    </AppShell>
  );
}

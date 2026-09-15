"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { FormLayout, FormSection, Fields, Field, FormFoot, Checklist } from "@/ui/Form";
import { Icon } from "@/ui/icons";

export default function NewPartnerPage() {
  const router = useRouter();

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">PARTNERS / NEW PARTNER</div>
          <h1>Add a partner</h1>
          <p>Start with the essentials. Add supporting context where it helps.</p>
        </div>
        <div className="actions">
          <Link href="/partners" className="btn">
            Back to partners
          </Link>
        </div>
      </div>

      <FormLayout>
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            router.push("/partners");
          }}
        >
          <FormSection title="Profile essentials" description="Use canonical identifiers to keep the programme free of duplicates.">
            <Fields>
              <Field label="Full name">
                <input type="text" placeholder="Ananya Rao" required />
              </Field>
              <Field label="Email address" hint="Use an illustrative address in this preview.">
                <input type="email" required />
              </Field>
              <Field label="Mobile number" hint="Include the country code.">
                <input type="tel" />
              </Field>
              <Field label="Profile URL" hint="Use https:// for platform profiles.">
                <input type="url" />
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
              <Field label="Platform handle" hint="Checks automatically while you type.">
                <input type="text" placeholder="@handle" />
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
              <summary style={{ cursor: "pointer" }}>Additional profile details</summary>
              <p className="foundationnote" style={{ marginTop: 12 }}>
                Language, source, audience context, evaluation and supporting links belong in
                progressive sections. Keep these details available without expanding every field
                by default.
              </p>
            </details>
          </FormSection>

          <FormFoot>
            <small>Preview only · entered values are not persisted</small>
            <div className="actions">
              <Link href="/partners" className="btn">
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
                <Icon name="check" /> Capture essential identity
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

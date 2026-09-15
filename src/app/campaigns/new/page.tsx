"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { FormLayout, FormSection, Fields, Field, FormFoot, Checklist } from "@/ui/Form";
import { Icon } from "@/ui/icons";

export default function NewCampaignPage() {
  const router = useRouter();

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">CAMPAIGNS / NEW CAMPAIGN</div>
          <h1>Create a campaign</h1>
          <p>Start with the essentials. Add supporting context where it helps.</p>
        </div>
        <div className="actions">
          <Link href="/campaigns" className="btn">
            Back to campaigns
          </Link>
        </div>
      </div>

      <FormLayout>
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            router.push("/campaigns");
          }}
        >
          <FormSection title="Campaign essentials" description="Use a clear, recognizable name to keep reporting unambiguous.">
            <Fields>
              <Field label="Campaign name">
                <input type="text" placeholder="Civic Voices" required />
              </Field>
              <Field label="Brief summary" hint="A short description of the campaign's goal.">
                <input type="text" />
              </Field>
              <Field label="Start date">
                <input type="date" />
              </Field>
              <Field label="End date">
                <input type="date" />
              </Field>
              <Field label="Region">
                <select>
                  <option>Kerala</option>
                  <option>Maharashtra</option>
                  <option>Tamil Nadu</option>
                  <option>Karnataka</option>
                </select>
              </Field>
              <Field label="Campaign owner">
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
              <summary style={{ cursor: "pointer" }}>Additional campaign details</summary>
              <p className="foundationnote" style={{ marginTop: 12 }}>
                Required deliverables, staffing, and content policy belong in progressive
                sections. Keep these details available without expanding every field by default.
              </p>
            </details>
          </FormSection>

          <FormFoot>
            <small>Preview only · entered values are not persisted</small>
            <div className="actions">
              <Link href="/campaigns" className="btn">
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
                <Icon name="check" /> Capture campaign identity
              </li>
              <li>
                <Icon name="check" /> Define required deliverables later
              </li>
              <li>
                <Icon name="check" /> Assign an accountable owner
              </li>
              <li>
                <Icon name="check" /> Keep context with the record
              </li>
            </Checklist>
            <div className="scopebox">
              Staffing and deliverable assignment happen after the campaign is created. This
              preview does not perform live checks.
            </div>
          </div>
        </aside>
      </FormLayout>
    </AppShell>
  );
}

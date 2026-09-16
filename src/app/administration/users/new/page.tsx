"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { FormLayout, FormSection, Fields, Field, FormFoot, Checklist } from "@/ui/Form";
import { Icon } from "@/ui/icons";
import { ROLES, ROLE_LABELS } from "@/server/authz/roles";
import type { Role } from "@/server/authz/roles";
import { createUser } from "@/features/administration/api-client";

export default function NewAdministrationUserPage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await createUser({ displayName, email, password, role });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.push(`/administration/users/${result.data.userRef}`);
  }

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">USERS / NEW USER</div>
          <h1>Provision a user</h1>
          <p>Creates a real emulator Auth account and an admission record with the selected role.</p>
        </div>
        <div className="actions">
          <Link href="/administration/users" className="btn">
            Back to users
          </Link>
        </div>
      </div>

      <FormLayout>
        <form className="panel" onSubmit={handleSubmit}>
          <FormSection title="Account essentials" description="These values provision a real account in the local Auth emulator.">
            <Fields>
              <Field label="Full name">
                <input type="text" placeholder="Ananya Rao" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
              </Field>
              <Field label="Email address" hint="Must be unique - re-submitting an existing email reuses that account.">
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </Field>
              <Field label="Temporary password" hint="At least 8 characters. The user should change this after first sign-in.">
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
              </Field>
              <Field label="Role" hint="One of the five canonical roles - not a rank, an explicit grant.">
                <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </Field>
            </Fields>
          </FormSection>

          {error && (
            <div style={{ padding: "0 22px 14px" }}>
              <div className="banner" role="alert">
                <b>Couldn&rsquo;t provision this user.</b> {error}
              </div>
            </div>
          )}

          <FormFoot>
            <small>Feature/scope/sensitive access is configured separately, after provisioning.</small>
            <div className="actions">
              <Link href="/administration/users" className="btn">
                Cancel
              </Link>
              <button type="submit" className="btn primary" disabled={submitting}>
                {submitting ? "Provisioning…" : "Provision user"}
              </button>
            </div>
          </FormFoot>
        </form>

        <aside className="panel">
          <div className="panelhead">
            <h2>What happens next</h2>
          </div>
          <div className="panelbody">
            <Checklist>
              <li>
                <Icon name="check" /> Creates the Auth emulator account
              </li>
              <li>
                <Icon name="check" /> Writes the admission record with this role
              </li>
              <li>
                <Icon name="check" /> Assigns no scope grants by default
              </li>
              <li>
                <Icon name="check" /> Records an audit event for this creation
              </li>
            </Checklist>
            <div className="scopebox">Add scope grants and review effective access from the new user&rsquo;s detail page.</div>
          </div>
        </aside>
      </FormLayout>
    </AppShell>
  );
}

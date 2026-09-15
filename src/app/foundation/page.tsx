"use client";

import { useState } from "react";

import { AppShell } from "@/ui/AppShell";
import { PageHeader } from "@/ui/PageCanvas";
import { LocalTabs, ScopeLine } from "@/ui/LocalTabs";
import { Button } from "@/ui/Button";
import { KpiCard, KpiRow } from "@/ui/KpiCard";
import { Panel, PanelBody, PanelFoot, PanelHead, PanelGrid } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { TableShell, Toolbar, SearchInput, PersonCell } from "@/ui/Table";
import { FormLayout, FormSection, Fields, Field, FormFoot, Checklist } from "@/ui/Form";
import { DialogShell } from "@/ui/Dialog";
import { StateGrid, StateCard, Skeleton, EmptyState } from "@/ui/States";
import { Icon } from "@/ui/icons";

export default function FoundationPage() {
  const [tab, setTab] = useState("tokens");
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <AppShell crumb="Foundation">
      <PageHeader
        eyebrow="LIVE VISUAL REFERENCE"
        title="Design foundation"
        description="Every shared primitive ported from the golden master, in one place, for drift checks."
        actions={
          <>
            <Button variant="ghost">Golden master</Button>
            <Button variant="primary" icon="plus">
              New pattern
            </Button>
          </>
        }
      />

      <LocalTabs
        tabs={[
          { key: "tokens", label: "Tokens & buttons" },
          { key: "kpis", label: "KPIs & panels" },
          { key: "table", label: "Table & forms" },
          { key: "states", label: "States & dialog" },
        ]}
        active={tab}
        onChange={setTab}
      />
      <ScopeLine label="Fixture data · illustrative only" />

      {tab === "tokens" && (
        <PanelGrid>
          <Panel span={12}>
            <PanelHead title="Buttons" description="Default, primary, and ghost variants" />
            <PanelBody>
              <div className="actions">
                <Button>Default</Button>
                <Button variant="primary" icon="plus">
                  Primary action
                </Button>
                <Button variant="ghost">Ghost</Button>
                <Button icon="download">With icon</Button>
              </div>
            </PanelBody>
          </Panel>
          <Panel span={12}>
            <PanelHead title="Badges / pills" description="Status tone variants" />
            <PanelBody>
              <div className="actions">
                <Pill>Default</Pill>
                <Pill tone="orange">Orange</Pill>
                <Pill tone="blue">Blue</Pill>
                <Pill tone="purple">Purple</Pill>
                <Pill tone="red">Red</Pill>
                <Pill tone="gray">Gray</Pill>
              </div>
            </PanelBody>
          </Panel>
        </PanelGrid>
      )}

      {tab === "kpis" && (
        <>
          <KpiRow>
            <KpiCard icon="users" label="Active partners" value="128" trend="Across 7 regions" />
            <KpiCard icon="flag" tone="blue" label="Live campaigns" value="12" trend="In execution" />
            <KpiCard icon="file" tone="green" label="Content items" value="342" trend="Planned and delivered" />
            <KpiCard icon="clock" tone="purple" label="Pending reviews" value="18" trend="Ready for a decision" />
          </KpiRow>
          <PanelGrid>
            <Panel span={8}>
              <PanelHead title="Panel with foot" description="Standard panel anatomy" />
              <PanelBody>
                <p>Panel body content area. Matches golden master padding and shadow.</p>
              </PanelBody>
              <PanelFoot>
                <span>Last updated 2 minutes ago</span>
              </PanelFoot>
            </Panel>
            <Panel span={4}>
              <PanelHead title="Attention" link="View all" />
              <PanelBody>
                <p>Compact panel, span 4 of 12.</p>
              </PanelBody>
            </Panel>
          </PanelGrid>
        </>
      )}

      {tab === "table" && (
        <>
          <Panel span={12}>
            <Toolbar>
              <SearchInput placeholder="Search partners" />
              <Button icon="plus" variant="primary">
                Add record
              </Button>
            </Toolbar>
            <TableShell>
              <thead>
                <tr>
                  <th>Partner</th>
                  <th>Status</th>
                  <th>Region</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <PersonCell name="Asha Menon" meta="asha@example.com" initials="AM" />
                  </td>
                  <td>
                    <Pill tone="orange">Under review</Pill>
                  </td>
                  <td>Kerala</td>
                </tr>
                <tr>
                  <td>
                    <PersonCell name="Rohit Verma" meta="rohit@example.com" initials="RV" />
                  </td>
                  <td>
                    <Pill>Active</Pill>
                  </td>
                  <td>Maharashtra</td>
                </tr>
              </tbody>
            </TableShell>
          </Panel>

          <div style={{ marginTop: 18 }}>
            <FormLayout>
              <div>
                <FormSection title="Partner details" description="Fixture-only form layout">
                  <Fields>
                    <Field label="Full name">
                      <input type="text" placeholder="Asha Menon" />
                    </Field>
                    <Field label="Region">
                      <select>
                        <option>Kerala</option>
                        <option>Maharashtra</option>
                      </select>
                    </Field>
                    <Field label="Notes" full hint="Internal only">
                      <textarea placeholder="Add context" />
                    </Field>
                  </Fields>
                </FormSection>
                <FormFoot>
                  <small>Fixture form — not wired to any workflow</small>
                  <Button variant="primary">Save</Button>
                </FormFoot>
              </div>
              <aside className="panel">
                <div className="panelhead">
                  <h2>Checklist</h2>
                </div>
                <div className="panelbody">
                  <Checklist>
                    <li>
                      <Icon name="check" /> Identity confirmed
                    </li>
                    <li>
                      <Icon name="check" /> Agreement on file
                    </li>
                  </Checklist>
                </div>
              </aside>
            </FormLayout>
          </div>
        </>
      )}

      {tab === "states" && (
        <>
          <StateGrid>
            <StateCard title="Loading">
              <Skeleton lines={3} />
            </StateCard>
            <StateCard title="Empty">
              <EmptyState title="No records yet" description="Fixture empty state" />
            </StateCard>
            <StateCard title="Dialog">
              <Button variant="primary" onClick={() => setDialogOpen(true)}>
                Open dialog
              </Button>
            </StateCard>
          </StateGrid>

          <DialogShell
            open={dialogOpen}
            title="Fixture dialog"
            onClose={() => setDialogOpen(false)}
            footer={
              <>
                <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={() => setDialogOpen(false)}>
                  Confirm
                </Button>
              </>
            }
          >
            <p>Native &lt;dialog&gt; shell, styled to match the golden master.</p>
          </DialogShell>
        </>
      )}
    </AppShell>
  );
}

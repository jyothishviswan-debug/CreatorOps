// Ported from the golden master's own foundation() function
// (docs/reference/CreatorOps_UI_Golden_Master.html) — its own banner text
// says: "The app's development-only foundation route should become its
// live implementation reference." Sample labels normalized to canonical
// terminology (creator -> partner, deliverable -> content); two provenance
// notes in section 07 were adapted since they referenced artifacts specific
// to the original prototype (a "V2 primitives" codebase, "three HTML
// references") that don't exist in this repo.
"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { AppShell } from "@/ui/AppShell";
import { Button } from "@/ui/Button";
import { Pill } from "@/ui/Badge";
import { Icon, type IconName } from "@/ui/icons";
import { ALL_NAV_ITEMS } from "@/ui/nav-items";
import { DialogShell } from "@/ui/Dialog";

function SectionLabel({ n, title, desc }: { n: string; title: string; desc: string }) {
  return (
    <div className="sectionlabel">
      <span>{n}</span>
      <div>
        <h2>{title}</h2>
        <p>{desc}</p>
      </div>
    </div>
  );
}

function DocPanel({
  title,
  sub,
  span,
  foot,
  children,
}: {
  title: string;
  sub?: string;
  span: 4 | 6 | 8 | 12;
  foot?: string;
  children: ReactNode;
}) {
  return (
    <section className={`panel s${span}`}>
      <div className="panelhead">
        <div>
          <h2>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
      </div>
      <div className="panelbody">{children}</div>
      {foot && <div className="panelfoot">{foot}</div>}
    </section>
  );
}

function Spec({ items }: { items: { title: string; body: ReactNode }[] }) {
  return (
    <div className="spec">
      {items.map((item) => (
        <div key={item.title}>
          <b>{item.title}</b>
          <p>{item.body}</p>
        </div>
      ))}
    </div>
  );
}

function Kv({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <>
      {rows.map((row) => (
        <div className="kv" key={row.label}>
          <span>{row.label}</span>
          <b>{row.value}</b>
        </div>
      ))}
    </>
  );
}

const TOKENS: [string, string][] = [
  ["Action orange", "#C94C16"],
  ["Accent orange", "#EE692B"],
  ["Navigation", "#19212B"],
  ["Canvas", "#F5F6F8"],
  ["Success", "#17785A"],
  ["Information", "#326BA9"],
];

const DASHBOARD_KPIS: [string, string, string, IconName][] = [
  ["Active partners", "126", "of 142 partners", "users"],
  ["Active campaigns", "18", "across your portfolio", "chart"],
  ["Content completed", "128", "of 164 required", "check"],
  ["Needs attention", "11", "actionable groups", "clock"],
];

const ATTENTION_ROWS: [string, string, string][] = [
  ["Content awaiting review", "12 submissions ready to inspect", "12"],
  ["Upcoming campaign deadlines", "Due within the next 7 days", "4"],
  ["Vendor agreement renewal review", "Ending this month", "2"],
];

const PATTERN_COVERAGE: { label: string; hint: string; icon: IconName }[] = [
  { label: "Workspace", hint: "Search, status filters, table / cards", icon: "users" },
  { label: "Assignment detail", hint: "Header → context → local tabs", icon: "check" },
  { label: "Create / edit", hint: "Progressive, validated, contextual", icon: "search" },
  { label: "Analytics", hint: "Native metrics and source coverage", icon: "chart" },
  { label: "Finance", hint: "Obligations and payment evidence", icon: "wallet" },
  { label: "Administration", hint: "Identity, role and explicit scope", icon: "shield" },
];

const STATE_CARDS: { title: string; body: string; icon: IconName; tone: "blue" | "purple" }[] = [
  { title: "Loading", body: "Preserve the layout while the requested section loads.", icon: "clock", tone: "blue" },
  { title: "Empty workspace", body: "No records yet. Start with the first profile.", icon: "users", tone: "blue" },
  { title: "No search results", body: "No records match these filters. Clear them to continue.", icon: "search", tone: "blue" },
  { title: "Partial data", body: "Instagram is available. YouTube data could not be loaded.", icon: "alert", tone: "blue" },
  { title: "Stale data", body: "Showing the previous snapshot with its update time.", icon: "clock", tone: "blue" },
  { title: "Unavailable", body: "This view is unavailable for the current context.", icon: "file", tone: "blue" },
  { title: "Access denied", body: "You do not have access to this view.", icon: "shield", tone: "purple" },
  { title: "Record not found", body: "This record is unavailable or no longer exists.", icon: "search", tone: "blue" },
  { title: "Edit conflict", body: "This record changed after you opened it. Reload before saving.", icon: "alert", tone: "blue" },
];

function LineChart() {
  return (
    <>
      <div className="chartsummary">
        <b>2.48M</b>
        <span>native platform views · September sample</span>
      </div>
      <svg
        className="chart"
        viewBox="0 0 650 195"
        role="img"
        aria-label="Illustrative weekly views; Instagram exceeds YouTube across four weeks"
      >
        <defs>
          <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ee692b" stopOpacity=".16" />
            <stop offset="1" stopColor="#ee692b" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[20, 60, 100, 140].map((y, i) => (
          <g key={y}>
            <line className="gridline" x1="40" y1={y} x2="632" y2={y} />
            <text x="0" y={y + 4}>
              {[800, 600, 400, 200][i]}K
            </text>
          </g>
        ))}
        <path
          d="M42 125 C100 125 105 82 170 93 S245 139 295 97 S377 69 413 79 S511 16 553 41 S604 43 632 22 L632 154 L42 154Z"
          fill="url(#fill)"
        />
        <path
          d="M42 125 C100 125 105 82 170 93 S245 139 295 97 S377 69 413 79 S511 16 553 41 S604 43 632 22"
          fill="none"
          stroke="#e46b34"
          strokeWidth="2.6"
        />
        <path
          d="M42 143 C114 140 138 112 190 121 S268 127 315 112 S393 124 442 101 S562 113 632 77"
          fill="none"
          stroke="#638ab9"
          strokeWidth="2"
        />
        {["01–07 Sep", "08–14 Sep", "15–21 Sep", "22–30 Sep"].map((n, i) => (
          <text key={n} x={42 + i * 176} y="183">
            {n}
          </text>
        ))}
      </svg>
      <div className="legend">
        <span>
          <i style={{ background: "#e46b34" }} />
          Instagram
        </span>
        <span>
          <i style={{ background: "#638ab9" }} />
          YouTube
        </span>
      </div>
    </>
  );
}

export default function FoundationPage() {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">DESIGN SYSTEM / FINAL DIRECTION</div>
          <h1>The design foundation</h1>
          <p>A complete visual language for a calmer, more capable CreatorOps.</p>
        </div>
        <div className="actions">
          <Link href="/dashboard" className="btn primary">
            <Icon name="arrow" />
            Explore dashboard
          </Link>
        </div>
      </div>

      <div className="hero">
        <div className="herocopy">
          <div className="eyebrow">CLARITY AT EVERY SCALE</div>
          <h1>
            Complex operations.
            <br />
            Considered simplicity.
          </h1>
          <p>
            A single global shell. Purposeful page compositions. Detail where it matters, and clear
            next actions wherever work happens.
          </p>
          <div className="actions">
            <a href="#patterns" className="btn primary">
              <Icon name="layers" />
              Browse screen patterns
            </a>
          </div>
        </div>
        <div className="herovisual">
          <div className="minimock">
            <div className="minitop">
              <b>Programme overview</b>
              <span>September 2026</span>
            </div>
            <div className="minikpis">
              <div>
                Partners
                <b>128</b>
              </div>
              <div>
                Campaigns
                <b>12</b>
              </div>
              <div>
                Delivered
                <b>342</b>
              </div>
            </div>
            <div className="minibars">
              {[26, 43, 36, 61, 52, 70, 55, 85, 76, 94, 86, 100].map((h, i) => (
                <i key={i} style={{ height: `${h}%` }} />
              ))}
            </div>
            <div className="minitop" style={{ paddingTop: 12, border: 0 }}>
              <span>Performance with context</span>
              <span>Inspect &rarr;</span>
            </div>
          </div>
        </div>
      </div>

      <div className="banner">
        <Icon name="layers" />
        <span>
          <b>One coherent system.</b> This route is the live implementation of that visual
          direction — the development-only reference for everything built on top of it.
        </span>
      </div>

      <SectionLabel
        n="01"
        title="Visual language"
        desc="Warm emphasis, neutral surfaces, and semantic colour with restraint."
      />
      <div className="tokenrow">
        {TOKENS.map(([name, hex]) => (
          <div className="token" key={name}>
            <div className="color" style={{ background: hex }} />
            <div>
              <b>{name}</b>
              <small>{hex}</small>
            </div>
          </div>
        ))}
      </div>

      <div className="grid" style={{ marginTop: 18 }}>
        <DocPanel title="Typography" sub="A deliberate hierarchy, without oversized labels" span={6}>
          <div style={{ fontSize: 29, letterSpacing: "-1px", fontWeight: 650 }}>Programme overview</div>
          <p style={{ fontSize: 12, color: "var(--muted)", margin: "9px 0 20px" }}>
            Useful context should be readable, quiet, and close to the decision.
          </p>
          <Spec
            items={[
              {
                title: "29 / 36 · Page title",
                body: (
                  <>
                    16 / 24 · Section title
                    <br />
                    14 / 21 · Body copy
                    <br />
                    12 / 18 · Controls & supporting copy
                  </>
                ),
              },
              {
                title: "Tabular numbers",
                body: (
                  <>
                    <span style={{ fontSize: 26, fontVariantNumeric: "tabular-nums", color: "var(--ink)" }}>
                      2,480,000
                    </span>
                    <br />
                    Consistent alignment for comparisons.
                  </>
                ),
              },
            ]}
          />
        </DocPanel>

        <DocPanel title="Interaction vocabulary" sub="Familiar controls with one clear primary action" span={6}>
          <div className="actions">
            <Button variant="primary" icon="plus">
              Primary action
            </Button>
            <Button>Secondary</Button>
            <Button variant="ghost">Quiet action</Button>
          </div>
          <div className="actions" style={{ marginTop: 18 }}>
            <Pill>Active</Pill>
            <Pill tone="orange">In review</Pill>
            <Pill tone="blue">In progress</Pill>
            <Pill tone="red">Blocked</Pill>
            <Pill tone="gray">Draft</Pill>
          </div>
          <p className="foundationnote" style={{ marginTop: 18 }}>
            Status always includes text. Orange communicates action; green communicates success.
            Destructive choices require deliberate confirmation.
          </p>
        </DocPanel>
      </div>

      <SectionLabel
        n="02"
        title="Composition & density"
        desc="Use available width intelligently. Size each section for its content."
      />
      <div className="grid">
        <DocPanel title="Layout rules" sub="One canvas family, adapted to the job" span={8}>
          <Spec
            items={[
              {
                title: "Overview / Workspace",
                body: "Wide canvas capped at 1,590px. Compact KPI rows. Twelve-column grids with purposeful 8/4, 6/6 and 4/4/4 compositions.",
              },
              {
                title: "Detail / Create / Edit",
                body: "Persistent context before local tabs. Forms capped at 1,080px. Group related information side by side; do not stretch every section.",
              },
              {
                title: "Spacing & density",
                body: "4px base rhythm. 14–18px grid gaps. 16–22px panel padding. Natural card height; no empty height added for decoration.",
              },
              {
                title: "Responsive shell",
                body: "Full navigation above 1,050px; compact rail down to 761px; dismissible menu on mobile. Cards reflow without scaling the whole screen.",
              },
            ]}
          />
        </DocPanel>
        <DocPanel title="One shell. Local navigation." sub="No nested module sidebar" span={4}>
          <div style={{ padding: 14, background: "#f5f6f8", border: "1px solid var(--line)", borderRadius: 8 }}>
            <b style={{ fontSize: 12 }}>Administration</b>
            <div className="tabs" style={{ marginTop: 16 }}>
              <span className="tab active">Overview</span>
              <span className="tab">Users</span>
              <span className="tab">Access review</span>
            </div>
            <div className="skeleton" style={{ width: "85%" }} />
            <div className="skeleton" style={{ width: "65%" }} />
          </div>
        </DocPanel>
      </div>

      <div id="patterns">
        <SectionLabel
          n="03"
          title="Canonical page patterns"
          desc="Rendered examples and interactive destinations, in one system."
        />
      </div>
      <div className="kpis">
        {DASHBOARD_KPIS.map(([label, value, trend, icon], i) => (
          <div className="kpi" key={label}>
            <div className="kpi-top">
              {label}
              <span className={`tile ${["", "blue", "green", "purple"][i]}`}>
                <Icon name={icon} />
              </span>
            </div>
            <div className="value">{value}</div>
            <div className="trend" style={{ color: "var(--muted)" }}>
              {trend}
            </div>
          </div>
        ))}
      </div>
      <div className="grid">
        <DocPanel title="Overview pattern" sub="Performance beside priority work" span={8}>
          <LineChart />
        </DocPanel>
        <DocPanel title="Attention pattern" sub="Specific queues, visible context, direct action" span={4}>
          {ATTENTION_ROWS.map(([title, detail, count], i) => (
            <div className="attention" key={title}>
              <span className={`alerttile ${i === 0 ? "red" : ""}`}>
                <Icon name={i === 0 ? "clock" : i === 1 ? "file" : "alert"} />
              </span>
              <span className="grow">
                <strong>{title}</strong>
                <small>{detail}</small>
              </span>
              <span className="count">{count}</span>
              <span className="arrow">&rsaquo;</span>
            </div>
          ))}
        </DocPanel>
      </div>
      <div className="grid">
        <DocPanel title="Delivery context" sub="Compact linked-record section" span={4}>
          <Kv
            rows={[
              { label: "Campaign", value: "Community Stories" },
              { label: "Content", value: "Instagram Reel · 01" },
              { label: "Due", value: "18 Sep 2026" },
            ]}
          />
        </DocPanel>
        <DocPanel title="Workflow context" sub="Status and responsibility" span={4}>
          <div className="kv">
            <span>State</span>
            <Pill tone="orange">Submitted</Pill>
          </div>
          <Kv
            rows={[
              { label: "Owner", value: "Meera Das" },
              { label: "Next action", value: "Review submission" },
            ]}
          />
        </DocPanel>
        <DocPanel title="Notes & meetings" sub="Keep related context in the same row" span={4}>
          <p className="detailcopy">Brief confirmed. First draft is ready for review before publication.</p>
          <small style={{ display: "block", marginTop: 12 }}>Meera Das · 14 Sep 2026</small>
        </DocPanel>
      </div>
      <div className="coverage">
        {PATTERN_COVERAGE.map((item) => (
          <button type="button" key={item.label}>
            <span className="tile">
              <Icon name={item.icon} />
            </span>
            <span>
              <b>{item.label}</b>
              <small>{item.hint}</small>
            </span>
          </button>
        ))}
      </div>

      <SectionLabel
        n="04"
        title="System states"
        desc="A missing value is not zero. A denied action is not an empty workspace."
      />
      <div className="stategrid">
        {STATE_CARDS.map((card) => (
          <article className="statecard" key={card.title}>
            <span className={`tile ${card.tone}`}>
              <Icon name={card.icon} />
            </span>
            <h3>{card.title}</h3>
            <p>{card.body}</p>
            {card.title === "Loading" && (
              <>
                <div className="skeleton" style={{ width: "85%" }} />
                <div className="skeleton" style={{ width: "58%" }} />
              </>
            )}
            {card.title === "Empty workspace" && <Button variant="primary">Create a lead</Button>}
            {card.title === "No search results" && <Button variant="primary">Clear filters</Button>}
          </article>
        ))}
      </div>

      <SectionLabel
        n="05"
        title="Workflow contracts"
        desc="Simpler presentation preserves important product distinctions."
      />
      <div className="grid">
        <DocPanel title="Domain boundaries" sub="Keep source truth and operational responsibility clear" span={8}>
          <Spec
            items={[
              {
                title: "Discovery → Partner",
                body: "Preserve separate identities. Check canonical identifiers automatically. Conversion requires readiness and authorized action.",
              },
              {
                title: "Assignment → Content",
                body: "An assignment owns partner work; content owns individual production items. Inspecting a stage never silently advances the lifecycle.",
              },
              {
                title: "Agreement → Analytics",
                body: "Agreement defines a target. Analytics owns measured actuals. Missing evidence remains unknown; non-payment targets never alter payables.",
              },
              {
                title: "Identity → Effective access",
                body: "Role, scope, sensitivity and lifecycle all matter. A visual permission preview cannot grant or certify real authorization.",
              },
            ]}
          />
        </DocPanel>
        <DocPanel title="Dialog & feedback patterns" sub="Review before consequential changes" span={4}>
          <p className="foundationnote">
            Use compact dialogs for focused decisions. Keep complex editing on a dedicated page.
            Return clear success, conflict, or recovery feedback.
          </p>
          <div className="actions" style={{ marginTop: 18 }}>
            <Button onClick={() => setDialogOpen(true)}>Review dialog</Button>
          </div>
        </DocPanel>
      </div>

      <SectionLabel
        n="06"
        title="Module coverage"
        desc="Different questions. Shared typography, controls and composition."
      />
      <div className="coverage">
        {ALL_NAV_ITEMS.map((item) => (
          <button type="button" key={item.href}>
            <Icon name={item.icon} />
            <span>
              <b>{item.label}</b>
              <small>Overview & workspace preview</small>
            </span>
          </button>
        ))}
      </div>

      <SectionLabel
        n="07"
        title="Implementation handoff"
        desc="Carry the design into the application without losing the workflow."
      />
      <section className="panel">
        <div className="panelbody">
          <Spec
            items={[
              {
                title: "Reuse the existing domain model",
                body: "Extend this shared UI library (src/ui/) and shell rather than adding a parallel module framework. Use the data model and terminology established here as implementation authority.",
              },
              {
                title: "Keep data access bounded",
                body: "Real workspaces need scoped cursor pagination. Overview drill-downs must carry filters. Avoid fetching entire datasets to render summary cards or export reports.",
              },
              {
                title: "Implement every state",
                body: "Loading, empty, no results, partial, stale, error, denied, not found and conflict. Keep valid sections usable when one source fails.",
              },
              {
                title: "Certify at real widths",
                body: "Check resized desktop, tablet and mobile. Verify keyboard focus, labels, dialog dismissal, readable charts and table overflow. Validate real role/scope behavior separately.",
              },
            ]}
          />
          <div className="scopebox">
            Review provenance: the supplied golden-master HTML (docs/reference/), the canonical
            terminology brief, and this repository&apos;s existing scaffold. This is a visual
            foundation, not a production certification or a claim that every pattern shown is
            wired to live data.
          </div>
        </div>
      </section>

      <SectionLabel
        n="08"
        title="Reports execution pattern"
        desc="Catalog → a report's own declared filters → a governed execution result. New in Step 19B: the golden master's own Reports entry (docs/reference/CreatorOps_UI_Golden_Master.html) is only the generic per-module overview-preview shape shared by every module - it has no catalog/filter/result pattern of its own, so this section documents the one /reports actually uses, built from the same tokens, panels and controls as everywhere else."
      />
      <div className="grid">
        <DocPanel title="Catalog card" sub="One governed report definition, grouped by family" span={6}>
          <div className="record" style={{ maxWidth: 340 }}>
            <b>Monthly Partner Performance</b>
            <p className="foundationnote" style={{ margin: "8px 0 12px" }}>
              A per-Partner, per-month view of coverage, Analytics output and finalized Review evidence - Production/Compliance/Performance kept fully separate.
            </p>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              <Pill tone="gray">partners</Pill>
              <Pill tone="gray">partner_reviews</Pill>
              <Pill tone="gray">analytics</Pill>
            </div>
            <div className="recordmeta">
              <span>Bounded to 200 rows</span>
              <span>2 filters</span>
            </div>
          </div>
        </DocPanel>
        <DocPanel title="Filter controls" sub="Only the ONE report's own server-declared filters - never invented client-side" span={6}>
          <div className="fields">
            <div className="field">
              <label>Platform</label>
              <select disabled defaultValue="">
                <option value="">Any platform</option>
                <option>Instagram</option>
                <option>YouTube</option>
              </select>
            </div>
            <div className="field full">
              <label>Periods (comma-separated YYYY-MM, max 6, required) *</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input type="month" disabled style={{ width: 150 }} />
                <button className="btn" type="button" disabled>
                  <Icon name="plus" />
                  Add period
                </button>
                <small className="muted">3 of 6 periods selected</small>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                <Pill tone="blue">March 2026</Pill>
                <Pill tone="blue">April 2026</Pill>
                <Pill tone="blue">May 2026</Pill>
              </div>
            </div>
          </div>
        </DocPanel>
      </div>

      <div className="grid">
        <DocPanel title="Execution result" sub="generatedAt ≠ evidenceCutoff · a missing metric is never 0 · limitations always visible" span={12}>
          <div className="detailcontext" style={{ marginBottom: 18 }}>
            <div>
              <small>Generated</small>
              <b>24 Sep 2026, 09:14</b>
            </div>
            <div>
              <small>Evidence cutoff (older than the read)</small>
              <b>21 Sep 2026, 18:02</b>
            </div>
            <div>
              <small>Rows returned</small>
              <b>25 of max 25</b>
            </div>
            <div>
              <small>Scope</small>
              <b>actor-scope, one bounded page</b>
            </div>
          </div>
          <div className="banner">
            <Icon name="alert" />
            <span>
              <b>This result was truncated.</b> 25 row(s) of at most 25 are shown - a larger scope exists than this bounded run can return in one pass.
            </span>
          </div>
          <div className="kpis" style={{ gridTemplateColumns: "repeat(4,minmax(0,1fr))" }}>
            <div className="kpi">
              <div className="kpi-top">Finalized reviews</div>
              <div className="value">18</div>
            </div>
            <div className="kpi">
              <div className="kpi-top">Instagram views</div>
              <div className="value" style={{ fontSize: 16, color: "var(--muted)" }}>
                Not available
              </div>
              <div className="trend" style={{ color: "var(--muted)" }}>
                Null (never 0) when no matched row reports views.
              </div>
            </div>
            <div className="kpi">
              <div className="kpi-top">Highest-views period (YouTube)</div>
              <div className="value" style={{ fontSize: 20 }}>
                April 2026
              </div>
            </div>
            <div className="kpi">
              <div className="kpi-top">Dropped periods</div>
              <div className="value">0</div>
            </div>
          </div>
          <div className="grid" style={{ marginTop: 18, marginBottom: 0 }}>
            <div className="panel s6">
              <div className="panelhead">
                <div>
                  <h2>Limitations</h2>
                  <p>Always shown - never buried, never silently dropped.</p>
                </div>
              </div>
              <div className="panelbody">
                <ul className="checklist">
                  <li>
                    <Icon name="alert" />
                    <span>No blended score is computed anywhere in this report.</span>
                  </li>
                  <li>
                    <Icon name="alert" />
                    <span>Bounded to a page of at most 25 Partners when no partnerRef filter is applied.</span>
                  </li>
                </ul>
              </div>
            </div>
            <div className="panel s6">
              <div className="panelhead">
                <div>
                  <h2>Provenance</h2>
                  <p>Full run only - hidden on a viewer-safe run.</p>
                </div>
              </div>
              <div className="panelbody">
                <div className="tablewrap">
                  <table className="compact">
                    <thead>
                      <tr>
                        <th scope="col">Source module</th>
                        <th scope="col">Function</th>
                        <th scope="col">Records</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>partners</td>
                        <td>listPartners</td>
                        <td>25</td>
                      </tr>
                      <tr>
                        <td>analytics</td>
                        <td>getPlatformAnalyticsView</td>
                        <td>18</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </DocPanel>
      </div>

      <div className="stategrid" style={{ marginTop: 18 }}>
        <article className="statecard">
          <span className="tile purple">
            <Icon name="lock" />
          </span>
          <h3>Viewer-safe boundary</h3>
          <p>Finance Status and Administration &amp; Security never run on the viewer-safe path - a Viewer sees a neutral &quot;not available on your access level&quot; message, never a broken fetch.</p>
        </article>
        <article className="statecard">
          <span className="tile blue">
            <Icon name="file" />
          </span>
          <h3>Finalized snapshot</h3>
          <p>Finalize pins the exact result as an immutable snapshot. &quot;Your finalized reports&quot; lists only the acting user&apos;s own snapshots - never every actor&apos;s.</p>
        </article>
        <article className="statecard">
          <span className="tile">
            <Icon name="table" />
          </span>
          <h3>Section, not one mega-table</h3>
          <p>Each report&apos;s own declared sections render as their own typed table - column headers come straight from the real field names a family projector returned, never invented.</p>
        </article>
      </div>

      <SectionLabel
        n="09"
        title="Export Center execution pattern"
        desc="Target → format + server-validated columns/filters → a created job → job lifecycle/history → private artifact delivery. New in the Export Center stage: the golden master has no Export Center entry at all (not even the generic per-module overview-preview shape Reports at least had), so this section documents the whole pattern from scratch, built from the same tokens, panels and controls as everywhere else - and deliberately its own shape, not a copy of section 08's Reports pattern: Export Center generates a downloadable FILE of RECORD ROWS from one target, it never composes a cross-domain analytical result."
      />
      <div className="grid">
        <DocPanel title="Target card" sub="One governed export target - its own allowed formats/columns, never a generic collection dump" span={6}>
          <div className="record" style={{ maxWidth: 340 }}>
            <b>Partners</b>
            <p className="foundationnote" style={{ margin: "8px 0 12px" }}>
              Partner roster rows - status, tier, region and ownership - sourced from the Partners service&apos;s own actor-scoped listPartners.
            </p>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              <Pill tone="gray">partners</Pill>
              <Pill tone="blue">CSV</Pill>
              <Pill tone="blue">XLSX</Pill>
              <Pill tone="blue">PDF</Pill>
            </div>
            <div className="recordmeta">
              <span>Bounded to 500 rows</span>
              <span>13 columns</span>
            </div>
          </div>
        </DocPanel>
        <DocPanel title="Configure - format, filters, columns" sub="The client PROPOSES a subset; the server re-validates every id before generating anything" span={6}>
          <div className="fields">
            <div className="field">
              <label>Format</label>
              <select disabled defaultValue="csv">
                <option value="csv">CSV</option>
                <option value="xlsx">XLSX</option>
                <option value="pdf">PDF</option>
              </select>
            </div>
            <div className="field">
              <label>Region</label>
              <input type="text" disabled placeholder="e.g. Kerala" />
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Columns</label>
            <ul className="checklist">
              <li>
                <Icon name="check" /> Partner ref, Display name, Status, Tier, Region (default columns)
              </li>
              <li>
                <Icon name="check" /> Email, Phone, Owner, Created/updated at (optional)
              </li>
            </ul>
            <small className="muted">A restricted field (e.g. bank/PAN/GSTIN) is never offered here - it is not on this target&apos;s own column allowlist at all, so there is nothing to uncheck.</small>
          </div>
        </DocPanel>
      </div>

      <div className="grid">
        <DocPanel title="Job history" sub="PENDING → GENERATING → COMPLETED or FAILED - a real persisted transition, scoped to the acting user&apos;s own jobs only" span={12}>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Target</th>
                  <th scope="col">Format</th>
                  <th scope="col">Status</th>
                  <th scope="col">Requested at</th>
                  <th scope="col">Rows</th>
                  <th scope="col">
                    <span className="sr">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Partners</td>
                  <td>XLSX</td>
                  <td>
                    <Pill tone="default">COMPLETED</Pill>
                  </td>
                  <td>24 Sep 2026, 09:14</td>
                  <td>128</td>
                  <td>
                    <button className="btn" type="button" disabled>
                      <Icon name="download" />
                      Download
                    </button>
                  </td>
                </tr>
                <tr>
                  <td>Assignments</td>
                  <td>PDF</td>
                  <td>
                    <Pill tone="blue">GENERATING</Pill>
                  </td>
                  <td>24 Sep 2026, 09:16</td>
                  <td>—</td>
                  <td>
                    <span className="foundationnote">Not ready</span>
                  </td>
                </tr>
                <tr>
                  <td>Campaigns</td>
                  <td>CSV</td>
                  <td>
                    <Pill tone="red">FAILED</Pill>
                  </td>
                  <td>23 Sep 2026, 17:02</td>
                  <td>—</td>
                  <td>
                    <span className="foundationnote">Unavailable</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="banner" style={{ marginTop: 16 }}>
            <Icon name="alert" />
            <span>
              <b>A failed job never shows a raw backend/provider error.</b> Only a safe, generic message (e.g. &quot;Export generation failed. Please try again.&quot;) is ever persisted or displayed.
            </span>
          </div>
        </DocPanel>
      </div>

      <div className="stategrid" style={{ marginTop: 18 }}>
        <article className="statecard">
          <span className="tile purple">
            <Icon name="table" />
          </span>
          <h3>Server-authoritative columns</h3>
          <p>An unknown, duplicate, or out-of-target column id rejects the whole request outright - never silently dropped, never passed through to the generated file.</p>
        </article>
        <article className="statecard">
          <span className="tile blue">
            <Icon name="lock" />
          </span>
          <h3>Private artifact delivery</h3>
          <p>The Download action re-authorizes at delivery time (actor + ownership + COMPLETED status). The raw Storage locator never becomes a browser field - only an opaque job reference does.</p>
        </article>
        <article className="statecard">
          <span className="tile">
            <Icon name="download" />
          </span>
          <h3>CSV/XLSX formula-injection guard</h3>
          <p>A cell value beginning with =, +, -, @, tab or CR is neutralized with a leading apostrophe before it is written - the same mitigation applied to both formats.</p>
        </article>
      </div>

      <DialogShell
        open={dialogOpen}
        title="Review before saving"
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
        <p>Illustrative dialog pattern — not wired to any workflow.</p>
      </DialogShell>
    </AppShell>
  );
}

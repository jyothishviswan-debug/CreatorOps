"use client";

import Link from "next/link";

import { Pill } from "./Badge";
import { Icon } from "./icons";
import type { RecordDetail, Tone } from "@/features/shared/types";
import { statusTone } from "@/features/shared/types";

function pillTone(tone: Tone): "default" | "orange" | "blue" | "purple" | "red" | "gray" {
  if (tone === "green") return "default";
  return tone;
}

export function DetailView({
  moduleLabel,
  workspaceHref,
  editHref,
  detail,
}: {
  moduleLabel: string;
  workspaceHref: string;
  editHref?: string;
  detail: RecordDetail;
}) {
  const { record } = detail;
  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">
            {moduleLabel.toUpperCase()} / RECORD DETAIL
          </div>
          <h1>{record.name}</h1>
          <p>{record.sub}</p>
        </div>
        <div className="actions">
          <Link href={workspaceHref} className="btn">
            Back to workspace
          </Link>
          {editHref && (
            <Link href={editHref} className="btn primary">
              Edit record
            </Link>
          )}
        </div>
      </div>

      <div className="detailcontext">
        <div>
          <small>Status</small>
          <Pill tone={pillTone(statusTone(record.status))}>{record.status}</Pill>
        </div>
        <div>
          <small>Responsible owner</small>
          <b>{record.owner}</b>
        </div>
        <div>
          <small>Region</small>
          <b>{record.region}</b>
        </div>
        <div>
          <small>Last updated</small>
          <b>{detail.lastUpdated}</b>
        </div>
      </div>

      <div className="tabsbar">
        <div className="tabs">
          <span className="tab active">Overview</span>
          <span className="tab">Notes & meetings</span>
          <span className="tab">History</span>
        </div>
        <span className="scope">
          <Icon name="shield" />
          Authorized record preview
        </span>
      </div>

      {detail.workflow && (
        <div className="workflow">
          {detail.workflow.map((step) => (
            <div className={`step ${step.state === "done" ? "done" : step.state === "current" ? "current" : ""}`} key={step.label}>
              <i>{step.state === "done" ? "✓" : step.label[0]}</i>
              {step.label}
            </div>
          ))}
        </div>
      )}

      <div className="grid">
        <section className="panel s8">
          <div className="panelhead">
            <div>
              <h2>Record context</h2>
              <p>Essential details stay visible</p>
            </div>
          </div>
          <div className="panelbody">
            <p className="detailcopy">{detail.contextCopy}</p>
            <div style={{ marginTop: 14 }}>
              {detail.kv.map((row) => (
                <div className="kv" key={row.label}>
                  <span>{row.label}</span>
                  <b>{row.value}</b>
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className="panel s4">
          <div className="panelhead">
            <div>
              <h2>Next action</h2>
              <p>Keep the workflow moving</p>
            </div>
          </div>
          <div className="panelbody">
            <span className="tile">
              <Icon name="file" />
            </span>
            <h3 style={{ marginTop: 12 }}>Review record context</h3>
            <p className="detailcopy" style={{ margin: "8px 0 17px" }}>
              Confirm the information and scope before updating this record.
            </p>
            <button className="btn primary" type="button">
              <Icon name="arrow" />
              Inspect details
            </button>
          </div>
        </section>
      </div>

      <div className="grid three">
        <section className="panel s4">
          <div className="panelhead">
            <div>
              <h2>Linked records</h2>
              <p>Relevant cross-module context</p>
            </div>
          </div>
          <div className="panelbody">
            <button className="attention" type="button">
              <span className="alerttile">
                <Icon name="file" />
              </span>
              <span className="grow">
                <strong>{detail.linked.title}</strong>
                <small>{detail.linked.detail}</small>
              </span>
              <Pill tone={pillTone(detail.linked.tone)}>{detail.linked.badge}</Pill>
            </button>
          </div>
        </section>
        <section className="panel s4">
          <div className="panelhead">
            <div>
              <h2>Operational follow-up</h2>
              <p>Canonical source remains authoritative</p>
            </div>
          </div>
          <div className="panelbody">
            <div className="kv">
              <span>Due date</span>
              <b>18 Sep 2026</b>
            </div>
            <div className="kv">
              <span>Owner</span>
              <b>{record.owner}</b>
            </div>
            <div className="kv">
              <span>Priority</span>
              <Pill tone="blue">Normal</Pill>
            </div>
          </div>
        </section>
        <section className="panel s4">
          <div className="panelhead">
            <div>
              <h2>Notes & meetings</h2>
              <p>Keep the conversation with the record</p>
            </div>
          </div>
          <div className="panelbody">
            <p className="detailcopy">&ldquo;{detail.note.body}&rdquo;</p>
            <small style={{ display: "block", marginTop: 12 }}>
              {detail.note.author} · {detail.note.date}
            </small>
          </div>
        </section>
      </div>
    </>
  );
}

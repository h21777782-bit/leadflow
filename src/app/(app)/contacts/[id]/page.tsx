import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Badge, BandBadge, StageBadge, StatusBadge } from "@/components/ui/badges";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { getEnv } from "@/lib/env";
import { formatDateTime, formatMoney } from "@/lib/format";
import { fullName } from "@/lib/normalize";
import { SERVICE_LABEL, SOURCE_LABEL, STAGE_META, type LeadSource, type Service } from "@/lib/pipeline";
import { getContactDetail } from "@/server/queries";
import { NewOpportunityForm } from "@/components/pipeline/new-opportunity-form";
import { StageControl } from "@/components/pipeline/stage-control";
import { ScorePanel } from "@/components/lead/score-panel";
import { LogReplyForm, RouteNowButton } from "@/components/lead/lead-intel-actions";
import { CancelWorkflowButton, OptOutToggle } from "@/components/automations/controls";
import { isUuid } from "@/lib/ids";

export const metadata: Metadata = { title: "Lead details" };

const FLASH: Record<string, string> = {
  created: "Contact created. No existing contact had this email or phone.",
  updated: "Changes saved and recorded in the activity log.",
  merged: "The new details were merged into this existing contact.",
  unchanged: "Nothing changed, so nothing was saved.",
};

export default async function LeadDetailsPage({ params, searchParams }: PageProps<"/contacts/[id]">) {
  await connection();
  const { id } = await params;
  const sp = await searchParams;
  const flashKey = Object.keys(FLASH).find((k) => sp[k] === "1");
  if (!isUuid(id)) notFound(); // avoid a Postgres cast error on bad ids
  const data = await getContactDetail(id);
  if (!data) notFound();

  const tz = getEnv().APP_TIMEZONE;
  const c = data.contact;
  const opp = data.opportunities[0];
  const fields: [string, ReactNode][] = [
    ["Email", c.email ?? "—"],
    ["Phone", c.phone ? <span key="p">{c.phone} <span className="text-muted">({c.phoneE164 ?? "invalid"})</span></span> : "—"],
    ["Company", c.company ?? "—"],
    ["Lead source", SOURCE_LABEL[c.leadSource as LeadSource] ?? c.leadSource],
    ["Service", c.serviceInterest ? SERVICE_LABEL[c.serviceInterest as Service] ?? c.serviceInterest : "—"],
    ["Budget", formatMoney(c.budgetAmount, c.budgetCurrency)],
    ["Country / timezone", `${c.country ?? "—"} / ${c.timezone ?? "—"}`],
    ["Owner", data.ownerName ?? "Unassigned"],
    ["Last contacted", formatDateTime(c.lastContactedAt, tz)],
    ["Next follow-up", formatDateTime(c.nextFollowUpAt, tz)],
  ];

  return (
    <>
      <PageHeader
        title={fullName(c.firstName, c.lastName)}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {c.company}
            {opp && <StageBadge stage={opp.stage} />}
            <BandBadge band={c.leadBand} score={c.leadScore} />
            {c.tags.map((t) => <Badge key={t}>{t}</Badge>)}
          </span>
        }
        actions={
          <>
            <Link href="/contacts" className="px-2 text-[13px] font-medium text-muted hover:text-ink">All contacts</Link>
            <Link href={`/contacts/${c.id}/edit`} className="rounded-md border border-line-strong bg-surface px-3 py-1.5 text-[13px] font-medium hover:bg-canvas">Edit contact</Link>
          </>
        }
      />
      {flashKey && (
        <p role="status" className={`mx-8 mt-4 rounded-md px-3 py-2 ${flashKey === "unchanged" ? "bg-pending-soft text-pending" : "bg-ok-soft text-ok"}`}>
          {FLASH[flashKey]}
        </p>
      )}
      <div className="grid gap-6 px-8 py-6 xl:grid-cols-3">
        <div className="space-y-6">
          <Panel title="Lead score" description="Recalculated automatically when the lead, its deals, messages or appointments change.">
            <ScorePanel
              score={c.leadScore}
              band={c.leadBand}
              scoredAt={c.scoredAt}
              factors={data.scoreHistory[0]?.breakdown ?? null}
              history={data.scoreHistory}
              tz={tz}
            />
            <div className="mt-5 border-t border-line pt-4">
              <LogReplyForm contactId={c.id} />
            </div>
          </Panel>

          <Panel title="Ownership & routing">
            {c.ownerId ? (
              <p>
                <span className="font-medium">{data.ownerName}</span>
                <span className="text-muted">
                  {" "}— {c.assignmentSource === "manual" ? "chosen manually (automatic routing is off for this lead)" : c.assignmentSource === "seed" ? "pre-assigned in demo data" : "assigned by routing"}
                  {c.assignedAt ? `, ${formatDateTime(c.assignedAt, tz)}` : ""}
                </span>
              </p>
            ) : (
              <div className="rounded-md border border-warm/40 bg-warm-soft p-3">
                <p className="font-medium">Unassigned</p>
                <p className="mt-0.5 text-[13px]">{c.unassignedReason ?? "No routing attempt yet."}</p>
                <div className="mt-3">
                  <RouteNowButton contactId={c.id} />
                </div>
              </div>
            )}
            <h3 className="mt-5 text-[13px] font-medium text-muted">Routing decisions</h3>
            {data.routing.length === 0 ? (
              <p className="mt-1 text-[13px] text-faint">None recorded{c.assignmentSource === "seed" ? " — owner came from demo seed data" : ""}.</p>
            ) : (
              <ol className="mt-2 space-y-3 border-l border-line pl-4">
                {data.routing.map((d) => (
                  <li key={d.id} className="text-[13px]">
                    <p>
                      <span className="font-medium">
                        {d.outcome === "unassigned" ? "Left unassigned" : d.outcome === "reassigned" ? `Reassigned to ${d.assignedName}` : `Assigned to ${d.assignedName}`}
                      </span>
                      <span className="text-muted"> — {formatDateTime(d.createdAt, tz)}, trigger: {d.trigger}</span>
                    </p>
                    <p className="text-muted">{d.reason}</p>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-accent">Show rule-by-rule trace</summary>
                      <ul className="mt-1 space-y-1 text-xs text-muted">
                        {(d.trace as { ruleName: string; matched: boolean; why: string; candidates?: { name: string; note: string }[] }[]).map((t, i) => (
                          <li key={i}>
                            <span className={t.matched ? "text-ink" : ""}>{t.ruleName}</span>: {t.why}
                            {t.candidates && <span> [{t.candidates.map((c2) => `${c2.name}: ${c2.note}`).join("; ")}]</span>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <Panel title="Contact">
            <dl className="space-y-2.5">
              {fields.map(([k, v]) => (
                <div key={k} className="grid grid-cols-[9rem_1fr] gap-2">
                  <dt className="text-muted">{k}</dt>
                  <dd className="min-w-0 break-words">{v}</dd>
                </div>
              ))}
            </dl>
            {Object.keys(c.customFields).length > 0 && (
              <>
                <h3 className="mt-5 text-[13px] font-medium text-muted">Custom fields</h3>
                <dl className="mt-1 space-y-1">
                  {Object.entries(c.customFields).map(([k, v]) => (
                    <div key={k} className="grid grid-cols-[9rem_1fr] gap-2">
                      <dt className="text-muted">{k}</dt>
                      <dd>{String(v)}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
            {c.notes && <p className="mt-5 rounded-md bg-canvas p-3 text-[13px]">{c.notes}</p>}
          </Panel>

          <Panel title={data.opportunities.length > 1 ? `Opportunities (${data.opportunities.length})` : "Opportunity"}>
            {data.opportunities.length === 0 && <p className="text-muted">No opportunity yet.</p>}
            <div className="space-y-6">
              {data.opportunities.map((o) => (
                <div key={o.id}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium">{o.title}</p>
                    <StageBadge stage={o.stage} />
                  </div>
                  <p className="tabular mt-1 text-2xl font-semibold">{formatMoney(o.valueAmount, o.currency)}</p>
                  <dl className="mt-2 space-y-1 text-[13px]">
                    {o.nextAction && <div><dt className="inline text-muted">Next action: </dt><dd className="inline">{o.nextAction}</dd></div>}
                    {o.lostReason && <div><dt className="inline text-muted">Lost reason: </dt><dd className="inline">{o.lostReason}</dd></div>}
                  </dl>
                  <StageControl opportunityId={o.id} contactId={c.id} stage={o.stage} />
                  <h3 className="mt-4 text-[13px] font-medium text-muted">Stage history</h3>
                  <ol className="mt-2 space-y-2 border-l border-line pl-4">
                    {data.history.filter((h) => h.opportunityId === o.id).map((h) => (
                      <li key={h.id} className="text-[13px]">
                        <span className="font-medium">{STAGE_META[h.toStage].label}</span>
                        <span className="text-muted"> — {formatDateTime(h.createdAt, tz)} by {h.actorType}</span>
                        {h.reason && <div className="text-muted">{h.reason}</div>}
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
              <NewOpportunityForm contactId={c.id} defaultTitle={`${c.company ?? c.firstName} — new project`} />
            </div>
          </Panel>
        </div>

        <div className="space-y-6 xl:col-span-2">
          <Panel title="Activity timeline" description="Every automated and manual event for this lead, newest first." flush>
            {data.timeline.length === 0 ? (
              <EmptyState title="No activity recorded yet" />
            ) : (
              <ol className="divide-y divide-line">
                {data.timeline.map((e) => (
                  <li key={e.id} className="flex gap-4 px-5 py-2.5">
                    <time className="tabular w-36 shrink-0 text-[13px] text-muted">{formatDateTime(e.createdAt, tz)}</time>
                    <div className="min-w-0">
                      <p>{e.message}</p>
                      <p className="text-xs text-faint">{e.eventType} by {e.actorType}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <Panel title="Follow-up automation" description="The new-lead nurture workflow for this contact.">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <OptOutToggle contactId={c.id} optedOut={Boolean(c.optedOutAt)} />
              {data.workflowRuns.find((r) => r.status === "running") && (
                <CancelWorkflowButton runId={data.workflowRuns.find((r) => r.status === "running")!.id} contactId={c.id} />
              )}
            </div>
            {data.jobs.length === 0 ? (
              <p className="mt-4 text-[13px] text-muted">No follow-up jobs for this lead.</p>
            ) : (
              <ol className="mt-4 space-y-3 border-l border-line pl-4">
                {data.jobs.map((j) => (
                  <li key={j.id} className="text-[13px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{j.type.replace(/^workflow\./, "").replace(/_/g, " ")}</span>
                      <StatusBadge status={j.status} />
                      <span className="text-muted">{formatDateTime(j.runAt, tz)}</span>
                    </div>
                    {j.lastError && <p className="mt-0.5 text-bad">{j.lastError}</p>}
                    {j.attemptHistory.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-accent">Attempt history ({j.attemptHistory.length})</summary>
                        <ul className="mt-1 space-y-1 text-xs text-muted">
                          {j.attemptHistory.map((a) => (
                            <li key={a.id}>#{a.attempt} {a.outcome} — {a.error ?? "ok"}, {formatDateTime(a.startedAt, tz)}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Messages" flush>
              {data.messages.length === 0 ? (
                <EmptyState title="No messages sent" />
              ) : (
                <ul className="divide-y divide-line">
                  {data.messages.map((m) => (
                    <li key={m.id} className="px-5 py-2.5 text-[13px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{m.channel.toUpperCase()} {m.templateKey}</span>
                        <StatusBadge status={m.status} />
                      </div>
                      <p className="mt-0.5 text-muted">{m.body}</p>
                      {m.error && <p className="mt-0.5 text-bad">{m.error}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Appointments" flush>
              {data.appointments.length === 0 ? (
                <EmptyState title="No appointments" />
              ) : (
                <ul className="divide-y divide-line">
                  {data.appointments.map((a) => (
                    <li key={a.id} className="px-5 py-2.5 text-[13px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{a.title}</span>
                        <StatusBadge status={a.status} />
                      </div>
                      <p className="mt-0.5">Lead’s time: {formatDateTime(a.startsAt, a.timezone)} ({a.timezone})</p>
                      <p className="text-muted">Your time: {formatDateTime(a.startsAt, tz)} ({tz})</p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}

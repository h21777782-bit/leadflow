import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Badge, StageBadge, StatusBadge } from "@/components/ui/badges";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { getEnv } from "@/lib/env";
import { formatDateTime, formatMoney } from "@/lib/format";
import { fullName } from "@/lib/normalize";
import { SERVICE_LABEL, SOURCE_LABEL, STAGE_META, type LeadSource, type Service } from "@/lib/pipeline";
import { getContactDetail } from "@/server/queries";

export const metadata: Metadata = { title: "Lead details" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LeadDetailsPage({ params }: PageProps<"/contacts/[id]">) {
  await connection();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound(); // avoid a Postgres cast error on bad ids
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
            {c.tags.map((t) => <Badge key={t}>{t}</Badge>)}
          </span>
        }
        actions={<Link href="/contacts" className="text-[13px] font-medium text-accent hover:underline">All contacts</Link>}
      />
      <div className="grid gap-6 px-8 py-6 xl:grid-cols-3">
        <div className="space-y-6">
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

          {opp && (
            <Panel title="Opportunity">
              <p className="font-medium">{opp.title}</p>
              <p className="tabular mt-1 text-2xl font-semibold">{formatMoney(opp.valueAmount, opp.currency)}</p>
              <dl className="mt-3 space-y-1.5 text-[13px]">
                <div><dt className="inline text-muted">Next action: </dt><dd className="inline">{opp.nextAction ?? "—"}</dd></div>
                {opp.lostReason && <div><dt className="inline text-muted">Lost reason: </dt><dd className="inline">{opp.lostReason}</dd></div>}
              </dl>
              <h3 className="mt-5 text-[13px] font-medium text-muted">Stage history</h3>
              <ol className="mt-2 space-y-2 border-l border-line pl-4">
                {data.history.map((h) => (
                  <li key={h.id} className="text-[13px]">
                    <span className="font-medium">{STAGE_META[h.toStage].label}</span>
                    <span className="text-muted"> — {formatDateTime(h.createdAt, tz)} by {h.actorType}</span>
                    {h.reason && <div className="text-muted">{h.reason}</div>}
                  </li>
                ))}
              </ol>
            </Panel>
          )}
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

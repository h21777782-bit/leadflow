import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { BandBadge } from "@/components/ui/badges";
import { Table, Td, Th } from "@/components/ui/table";
import { getEnv } from "@/lib/env";
import { formatDateTime, formatMoney } from "@/lib/format";
import { OPEN_STAGES, SOURCE_LABEL, STAGE_META, type LeadSource } from "@/lib/pipeline";
import { getDashboardSummary } from "@/server/queries";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  await connection(); // always render with live data
  const tz = getEnv().APP_TIMEZONE;
  const d = await getDashboardSummary();
  const openCount = OPEN_STAGES.reduce((n, s) => n + d.byStage[s].count, 0);
  const automationTotal = d.automation.completed + d.automation.pending + d.automation.retrying + d.automation.failed;

  const kpis = [
    { label: "New leads, last 7 days", value: d.newLeads.toString(), note: `${d.totalLeads} leads in total` },
    { label: "Qualified or further", value: d.qualifiedOrLater.toString(), note: "Open deals past qualification" },
    { label: "Upcoming appointments", value: d.upcomingAppointments.toString(), note: "Confirmed or scheduled" },
    { label: "Open pipeline value", value: formatMoney(d.openValue), note: `${openCount} open opportunities` },
    { label: "Won", value: d.won.toString(), note: formatMoney(d.wonValue) },
    { label: "Lost", value: d.lost.toString(), note: "Reasons are on each deal" },
    {
      label: "Win rate (closed deals)",
      value: d.conversionRate == null ? "—" : `${Math.round(d.conversionRate * 100)}%`,
      note: "Won ÷ (won + lost)",
    },
  ];

  return (
    <>
      <PageHeader title="Dashboard" description="How leads are moving through the pipeline and how the automations behind them are doing." />
      <div className="space-y-6 px-8 py-6">
        {/* Pipeline flow: the one bold element on the page */}
        <Panel title="Pipeline flow" description="Open opportunities by stage. Width is proportional to the number of deals.">
          {openCount === 0 ? (
            <EmptyState title="No open opportunities yet" />
          ) : (
            <div>
              <div className="flex h-10 overflow-hidden rounded-md" role="img" aria-label="Open opportunities by stage">
                {OPEN_STAGES.map((stage, i) => {
                  const c = d.byStage[stage].count;
                  if (c === 0) return null;
                  const shade = 0.35 + (i / (OPEN_STAGES.length - 1)) * 0.65;
                  return (
                    <div
                      key={stage}
                      style={{ flexGrow: c, backgroundColor: `color-mix(in srgb, var(--color-accent) ${Math.round(shade * 100)}%, white)` }}
                      className="flex min-w-8 items-center justify-center border-r border-white text-[13px] font-semibold text-white last:border-r-0"
                      title={`${STAGE_META[stage].label}: ${c}`}
                    >
                      <span className="tabular">{c}</span>
                    </div>
                  );
                })}
              </div>
              <ol className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4 xl:grid-cols-7">
                {OPEN_STAGES.map((stage) => (
                  <li key={stage} className="text-[13px]">
                    <span className="block text-muted">{STAGE_META[stage].label}</span>
                    <span className="tabular block font-medium">
                      {d.byStage[stage].count} {d.byStage[stage].count === 1 ? "deal" : "deals"}
                    </span>
                    <span className="tabular block text-muted">{formatMoney(d.byStage[stage].value)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Panel>

        <div className="grid gap-6 xl:grid-cols-5">
          <Panel title="Lead temperature" description="Open leads only, from the scoring engine." className="xl:col-span-2">
            <dl className="grid grid-cols-3 gap-3">
              {([
                ["hot", "Hot", "70–100", "bg-hot-soft text-hot"],
                ["warm", "Warm", "40–69", "bg-warm-soft text-warm"],
                ["cold", "Cold", "0–39", "bg-cold-soft text-cold"],
              ] as const).map(([k, label, range, tone]) => (
                <div key={k} className={`rounded-md px-3 py-2 ${tone}`}>
                  <dt className="text-[13px] font-medium">{label}</dt>
                  <dd className="tabular text-2xl font-semibold">{d.bands[k]}</dd>
                  <dd className="text-xs opacity-80">score {range}</dd>
                </div>
              ))}
            </dl>
            {d.bands.unscored > 0 && <p className="mt-2 text-xs text-muted">{d.bands.unscored} open lead(s) not scored yet.</p>}
          </Panel>

          <Panel title={`Unassigned leads (${d.unassigned.length})`} className="xl:col-span-3" flush>
            {d.unassigned.length === 0 ? (
              <p className="px-5 py-4 text-muted">Every open lead has an owner.</p>
            ) : (
              <ul className="divide-y divide-line">
                {d.unassigned.map((u) => (
                  <li key={u.id} className="px-5 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <Link href={`/contacts/${u.id}`} className="font-medium text-accent hover:underline">{u.name}</Link>
                      <BandBadge band={u.leadBand} score={u.leadScore} />
                    </div>
                    <p className="text-[13px] text-muted">{u.reason ?? "Not routed yet"}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="grid gap-6 xl:grid-cols-5">
          <Panel title="Sales rep workload" description="Active leads = owned leads with an open deal." className="xl:col-span-2">
            <ul className="space-y-3">
              {d.workload.map((r) => {
                const pct = r.maxOpenLeads ? Math.min(100, (r.activeLeads / r.maxOpenLeads) * 100) : 100;
                const status = !r.isActive ? "Inactive" : !r.isAvailable ? "Unavailable" : r.activeLeads >= r.maxOpenLeads ? "At capacity" : null;
                return (
                  <li key={r.id}>
                    <div className="flex justify-between text-[13px]">
                      <span className="font-medium">{r.name}{status && <span className="ml-2 font-normal text-warm">{status}</span>}</span>
                      <span className="tabular">{r.activeLeads} / {r.maxOpenLeads}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-pending-soft">
                      <div className={`h-1.5 rounded-full ${status ? "bg-warm" : "bg-accent"}`} style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
            <Link href="/settings" className="mt-4 inline-block text-[13px] font-medium text-accent hover:underline">Change availability or capacity</Link>
          </Panel>

          <Panel title="Routing decisions" description="Latest assignments made by the routing engine." className="xl:col-span-3" flush>
            {d.decisions.length === 0 ? (
              <p className="px-5 py-4 text-muted">No routing decisions yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {d.decisions.map((r) => (
                  <li key={r.id} className="px-5 py-2.5 text-[13px]">
                    <p>
                      <Link href={`/contacts/${r.contactId}`} className="font-medium text-accent hover:underline">{r.contactName}</Link>{" "}
                      {r.outcome === "unassigned" ? <span className="text-warm">left unassigned</span> : <>→ <span className="font-medium">{r.assignedName}</span></>}
                      {r.outcome === "reassigned" && r.previousName && <span className="text-muted"> (from {r.previousName})</span>}
                      <span className="text-faint"> — {formatDateTime(r.createdAt, tz)}, {r.trigger}</span>
                    </p>
                    <p className="text-muted">{r.ruleName ?? r.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-4 xl:grid-cols-7">
          {kpis.map((k) => (
            <div key={k.label} className="bg-surface px-4 py-3">
              <dt className="text-[13px] text-muted">{k.label}</dt>
              <dd className="tabular mt-1 text-2xl font-semibold tracking-tight">{k.value}</dd>
              <dd className="text-xs text-faint">{k.note}</dd>
            </div>
          ))}
        </dl>

        <div className="grid gap-6 xl:grid-cols-5">
          <Panel title="Lead source performance" className="xl:col-span-3" flush>
            <Table>
              <thead>
                <tr>
                  <Th>Source</Th>
                  <Th className="text-right">Leads</Th>
                  <Th className="text-right">Won</Th>
                  <Th className="text-right">Win share</Th>
                  <Th className="text-right">Won value</Th>
                </tr>
              </thead>
              <tbody>
                {d.sources.map((r) => (
                  <tr key={r.source}>
                    <Td>{SOURCE_LABEL[r.source as LeadSource] ?? r.source}</Td>
                    <Td className="tabular text-right">{r.leads}</Td>
                    <Td className="tabular text-right">{r.won}</Td>
                    <Td className="tabular text-right">{r.leads ? `${Math.round((r.won / r.leads) * 100)}%` : "—"}</Td>
                    <Td className="tabular text-right">{formatMoney(r.wonValue)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>

          <Panel title="Automation health" className="xl:col-span-2">
            <dl className="space-y-3">
              {[
                { label: "Completed or skipped", value: d.automation.completed, tone: "bg-ok" },
                { label: "Scheduled or running", value: d.automation.pending, tone: "bg-accent" },
                { label: "Retrying", value: d.automation.retrying, tone: "bg-warm" },
                { label: "Failed — needs action", value: d.automation.failed, tone: "bg-bad" },
              ].map((row) => (
                <div key={row.label}>
                  <div className="flex justify-between text-[13px]">
                    <dt>{row.label}</dt>
                    <dd className="tabular font-medium">{row.value}</dd>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-pending-soft">
                    <div className={`h-1.5 rounded-full ${row.tone}`} style={{ width: `${automationTotal ? (row.value / automationTotal) * 100 : 0}%` }} />
                  </div>
                </div>
              ))}
            </dl>
            {d.automation.failed > 0 && (
              <Link href="/failed-automations" className="mt-4 inline-block text-[13px] font-medium text-accent hover:underline">
                Review failed automations
              </Link>
            )}
          </Panel>
        </div>

        <Panel title="Recent automation activity" flush>
          <ul className="divide-y divide-line">
            {d.recent.map((e) => (
              <li key={e.id} className="flex items-baseline gap-4 px-5 py-2.5">
                <time className="tabular w-36 shrink-0 text-[13px] text-muted" dateTime={e.createdAt.toISOString()}>
                  {formatDateTime(e.createdAt, tz)}
                </time>
                <span className="flex-1">
                  {e.message}
                  {e.contactId && e.contactName && (
                    <>
                      {" "}
                      <Link href={`/contacts/${e.contactId}`} className="text-accent hover:underline">
                        {e.contactName}
                      </Link>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <div className="border-t border-line px-5 py-2.5">
            <Link href="/activity" className="text-[13px] font-medium text-accent hover:underline">
              Open the full activity log
            </Link>
          </div>
        </Panel>
      </div>
    </>
  );
}

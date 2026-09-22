import type { Metadata } from "next";
import { connection } from "next/server";
import { RepEditor } from "@/components/settings/rep-editor";
import { RuleEditor, type RuleView } from "@/components/settings/rule-editor";
import { WorkingHoursEditor } from "@/components/settings/working-hours-editor";
import { Badge } from "@/components/ui/badges";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { Table, Td, Th } from "@/components/ui/table";
import { SERVICE_LABEL, type Service } from "@/lib/pipeline";
import { DEFAULT_SCORING_CONFIG as SC } from "@/lib/scoring";
import { listTeamAndRules } from "@/server/queries";

export const metadata: Metadata = { title: "Settings" };

function flashMessage(sp: Record<string, string | string[] | undefined>): string | null {
  if (sp.repUpdated === "1") return `Saved. ${sp.moved ?? 0} lead(s) assigned, ${sp.left ?? 0} left unassigned.`;
  if (sp.ruleUpdated === "1") return `Rule saved. ${sp.rerouted ?? 0} waiting lead(s) were assigned.`;
  return null;
}

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  await connection();
  const sp = await searchParams;
  const flash = flashMessage(sp);
  const { team, rules } = await listTeamAndRules();
  const reps = team.filter((u) => u.role === "sales_rep");
  const nameById = new Map(team.map((u) => [u.id, u.name]));

  const toView = (r: (typeof rules)[number]): RuleView => ({
    id: r.id, name: r.name, priority: r.priority, strategy: r.strategy, isActive: r.isActive,
    services: r.conditions.services ?? [], countries: r.conditions.countries ?? [], sources: r.conditions.sources ?? [],
    minBudget: r.conditions.minBudget ?? null, requireServiceExpertise: Boolean(r.conditions.requireServiceExpertise), targetUserIds: r.targetUserIds,
  });
  const describe = (r: (typeof rules)[number]) => {
    const c = r.conditions;
    const when = [
      c.services?.length ? `service is ${c.services.map((sv) => SERVICE_LABEL[sv as Service] ?? sv).join(" or ")}` : null,
      c.countries?.length ? `country is ${c.countries.join(", ")}` : null,
      c.sources?.length ? `source is ${c.sources.join(", ")}` : null,
      c.minBudget ? `budget at least $${c.minBudget}` : null,
    ].filter(Boolean);
    const how = { assign_user: "first available of", round_robin: "round robin across", least_loaded: "lowest workload among" }[r.strategy];
    return `${when.length ? `When ${when.join(" and ")}` : "Any lead"}: ${how} ${r.targetUserIds.map((id) => nameById.get(id) ?? "unknown").join(", ")}${c.requireServiceExpertise ? " (must sell the service)" : ""}.`;
  };

  return (
    <>
      <PageHeader title="Settings" description="Sales team availability and capacity, routing rules, and how leads are scored. Changes here re-route affected leads immediately." />
      {flash && <p role="status" className="mx-8 mt-4 rounded-md bg-ok-soft px-3 py-2 text-ok">{flash}</p>}
      <div className="space-y-6 px-8 py-6">
        <Panel title="Sales team" description="Unavailable, inactive or full reps never receive new leads. Making a rep unavailable moves their not-yet-contacted leads; leads already in conversation stay." flush>
          <Table>
            <thead><tr><Th>Rep</Th><Th>Services / regions</Th><Th className="text-right">Active leads</Th><Th>Availability and capacity</Th><Th>Working hours (own timezone)</Th></tr></thead>
            <tbody>
              {reps.map((u) => (
                <tr key={u.id}>
                  <Td className="font-medium">
                    {u.name}
                    <div className="text-[13px] font-normal text-muted">{u.timezone}</div>
                    {!u.isActive ? <Badge tone="bad">Inactive</Badge> : !u.isAvailable ? <Badge tone="warm">Unavailable</Badge> : u.openLeads >= u.maxOpenLeads ? <Badge tone="warm">At capacity</Badge> : <Badge tone="ok">Taking leads</Badge>}
                  </Td>
                  <Td className="text-[13px]">
                    {u.services.map((sv) => SERVICE_LABEL[sv as Service] ?? sv).join(", ") || "—"}
                    <div className="text-muted">{u.regions.join(", ") || "—"}</div>
                  </Td>
                  <Td className="tabular text-right">{u.openLeads} / {u.maxOpenLeads}</Td>
                  <Td><RepEditor rep={u} /></Td>
                  <Td><WorkingHoursEditor rep={u} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>

        <Panel title="Routing rules" description="Checked in priority order. The first rule with an eligible rep wins; if a matching rule has nobody eligible, the next rule is tried. No match means the lead stays Unassigned with the reason shown." flush>
          <ul className="divide-y divide-line">
            {rules.map((r) => (
              <li key={r.id} className="px-5 py-3">
                <div className="mb-1 flex items-center gap-2">
                  <span className="tabular rounded bg-pending-soft px-1.5 text-xs">{r.priority}</span>
                  <span className="font-medium">{r.name}</span>
                  {!r.isActive && <Badge>Paused</Badge>}
                </div>
                <RuleEditor rule={toView(r)} reps={reps} summary={describe(r)} />
              </li>
            ))}
            <li className="px-5 py-3">
              <RuleEditor
                rule={{ id: null, name: "", priority: 50, strategy: "round_robin", isActive: true, services: [], countries: [], sources: [], minBudget: null, requireServiceExpertise: false, targetUserIds: [] }}
                reps={reps}
                summary="New rules apply to every new lead, and every waiting unassigned lead is retried when you save."
              />
            </li>
          </ul>
        </Panel>

        <Panel title="How leads are scored" description={`Scoring config ${SC.version} (src/lib/scoring.ts). Unknown information gets neutral credit, never a penalty.`}>
          <dl className="grid gap-4 text-[13px] sm:grid-cols-2 xl:grid-cols-5">
            <div><dt className="font-medium">Budget fit — {SC.max.budget}</dt><dd className="text-muted">{SC.budgetTiers.map((t) => `${t.label}: ${t.points}`).join("; ")}; unknown: {SC.budgetUnknownPoints}</dd></div>
            <div><dt className="font-medium">Service fit — {SC.max.service}</dt><dd className="text-muted">{Object.entries(SC.servicePoints).map(([k, v]) => `${SERVICE_LABEL[k as Service] ?? k}: ${v}`).join("; ")}; unknown: {SC.serviceUnknownPoints}</dd></div>
            <div><dt className="font-medium">Engagement — {SC.max.engagement}</dt><dd className="text-muted">Profile completeness up to 8 (company, email + phone, location, notes); replies: 1 = 6, 2 = 9, 3+ = 12</dd></div>
            <div><dt className="font-medium">Response — {SC.max.response}</dt><dd className="text-muted">Replied: {SC.response.replied}; not contacted / awaiting first reply: {SC.response.pending}; no reply after {SC.response.attemptsBeforePenalty}+ attempts: {SC.response.unansweredAfterAttempts}</dd></div>
            <div><dt className="font-medium">Appointment — {SC.max.appointment}</dt><dd className="text-muted">Completed {SC.appointment.completed}; booked {SC.appointment.upcoming}; none yet {SC.appointment.notBooked}; cancelled {SC.appointment.cancelled}; no-show {SC.appointment.noShow}</dd></div>
          </dl>
          <p className="mt-3 text-[13px]">Bands: Hot {SC.bands.hotMin}–100, Warm {SC.bands.warmMin}–{SC.bands.hotMin - 1}, Cold 0–{SC.bands.warmMin - 1}.</p>
        </Panel>
      </div>
    </>
  );
}

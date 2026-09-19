import type { Metadata } from "next";
import { connection } from "next/server";
import { Badge } from "@/components/ui/badges";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { Table, Td, Th } from "@/components/ui/table";
import { SERVICE_LABEL, type Service } from "@/lib/pipeline";
import { listTeamAndRules } from "@/server/queries";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await connection();
  const { team, rules } = await listTeamAndRules();
  const nameById = new Map(team.map((u) => [u.id, u.name]));

  return (
    <>
      <PageHeader title="Settings" description="Sales team and lead routing rules. Rules are checked in priority order; the first match decides the owner." />
      <div className="space-y-6 px-8 py-6">
        <Panel title="Sales team" flush>
          <Table>
            <thead>
              <tr><Th>Name</Th><Th>Role</Th><Th>Timezone</Th><Th>Services</Th><Th>Regions</Th><Th className="text-right">Open leads</Th><Th>Availability</Th></tr>
            </thead>
            <tbody>
              {team.map((u) => (
                <tr key={u.id}>
                  <Td className="font-medium">{u.name}<div className="text-[13px] font-normal text-muted">{u.email}</div></Td>
                  <Td>{u.role === "admin" ? "Admin" : "Sales rep"}</Td>
                  <Td className="text-[13px]">{u.timezone}</Td>
                  <Td className="text-[13px]">{u.services.map((sv) => SERVICE_LABEL[sv as Service] ?? sv).join(", ") || "—"}</Td>
                  <Td className="text-[13px]">{u.regions.join(", ") || "—"}</Td>
                  <Td className="tabular text-right">{u.role === "admin" ? "—" : `${u.openLeads} / ${u.maxOpenLeads}`}</Td>
                  <Td>{u.role === "admin" ? "—" : u.isAvailable ? <Badge tone="ok">Available</Badge> : <Badge>Unavailable</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>

        <Panel title="Routing rules" flush>
          <Table>
            <thead>
              <tr><Th className="text-right">Priority</Th><Th>Rule</Th><Th>Matches when</Th><Th>Assigns</Th><Th>Status</Th></tr>
            </thead>
            <tbody>
              {rules.map((r) => {
                const cond = [
                  r.conditions.services?.length ? `service is ${r.conditions.services.map((sv) => SERVICE_LABEL[sv as Service] ?? sv).join(" or ")}` : null,
                  r.conditions.countries?.length ? `country is ${r.conditions.countries.join(", ")}` : null,
                  r.conditions.sources?.length ? `source is ${r.conditions.sources.join(", ")}` : null,
                  r.conditions.minBudget ? `budget at least ${r.conditions.minBudget}` : null,
                ].filter(Boolean);
                return (
                  <tr key={r.id}>
                    <Td className="tabular text-right">{r.priority}</Td>
                    <Td className="font-medium">{r.name}</Td>
                    <Td className="text-[13px]">{cond.length ? cond.join(" and ") : "Any lead (fallback)"}</Td>
                    <Td className="text-[13px]">
                      {r.strategy === "round_robin" ? "Round robin: " : ""}
                      {r.targetUserIds.map((id) => nameById.get(id) ?? "Unknown").join(", ")}
                    </Td>
                    <Td>{r.isActive ? <Badge tone="ok">Active</Badge> : <Badge>Paused</Badge>}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Panel>
      </div>
    </>
  );
}

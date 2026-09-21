import type { Metadata } from "next";
import { connection } from "next/server";
import { Badge, StatusBadge } from "@/components/ui/badges";
import { CrmFailureModeSwitch, StageMappingForm, TestConnectionButton } from "@/components/integrations/controls";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Table, Td, Th } from "@/components/ui/table";
import { describeIntegrationConfig, getEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/format";
import { STAGE_META } from "@/lib/pipeline";
import { getCrmOverview } from "@/server/queries";

export const metadata: Metadata = { title: "Integrations" };

function Configured({ ok }: { ok: boolean }) {
  return ok ? <Badge tone="ok">Set</Badge> : <Badge>Not set</Badge>;
}

export default async function IntegrationsPage() {
  await connection();
  const env = getEnv();
  const cfg = describeIntegrationConfig(env);
  const overview = await getCrmOverview();

  const rows: [string, boolean][] = [
    ["Private integration token", cfg.highlevel.tokenConfigured],
    ["Location (sub-account) ID", cfg.highlevel.locationConfigured],
    ["Pipeline ID", cfg.highlevel.pipelineConfigured],
    ["Calendar ID", cfg.highlevel.calendarConfigured],
    ["Webhook public key (Ed25519)", cfg.highlevel.webhookKeyConfigured],
    ["Webhook signing secret (website / n8n)", cfg.webhookSigningConfigured],
  ];

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connection settings come from environment variables. Secret values are never shown here, only whether they are set."
      />
      <div className="space-y-6 px-8 py-6">
        <div className="grid gap-6 xl:grid-cols-3">
          <Panel title="HighLevel">
            <p>
              {cfg.mode === "mock" ? (
                <><Badge tone="warm">Mock mode</Badge> <span className="text-muted">Calls go to the isolated mock provider.</span></>
              ) : (
                <><Badge tone="ok">Live</Badge> <span className="text-muted">Calls go to the HighLevel API.</span></>
              )}
            </p>
            <dl className="mt-4 space-y-2 text-[13px]">
              <div className="flex justify-between gap-2"><dt className="text-muted">API base URL</dt><dd className="break-all text-right">{cfg.highlevel.baseUrl}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">API version header</dt><dd>{cfg.highlevel.apiVersion}</dd></div>
              {rows.map(([label, ok]) => (
                <div key={label} className="flex items-center justify-between gap-2"><dt className="text-muted">{label}</dt><dd><Configured ok={ok} /></dd></div>
              ))}
            </dl>
            <p className="mt-4 text-[13px] text-muted">To switch to live mode, set <code>MOCK_MODE=false</code> and fill in the HighLevel values in <code>.env.local</code>.</p>
            <div className="mt-4 border-t border-line pt-4">
              <TestConnectionButton />
            </div>
          </Panel>

          <Panel title="Sync status" description="Outbox jobs keep HighLevel in sync — every contact/opportunity write enqueues one.">
            <dl className="grid grid-cols-2 gap-3">
              <div className="rounded-md bg-canvas px-3 py-2">
                <dt className="text-[13px] text-muted">Contacts synced</dt>
                <dd className="tabular text-lg font-semibold">{overview.contacts.synced} / {overview.contacts.total}</dd>
              </div>
              <div className="rounded-md bg-canvas px-3 py-2">
                <dt className="text-[13px] text-muted">Opportunities synced</dt>
                <dd className="tabular text-lg font-semibold">{overview.opportunities.synced} / {overview.opportunities.total}</dd>
              </div>
              {(["pending", "processing", "retry_scheduled", "completed", "failed"] as const).map((st) => (
                <div key={st} className="rounded-md bg-canvas px-3 py-2">
                  <dt className="text-[13px] text-muted">{st.replace(/_/g, " ")} jobs</dt>
                  <dd className="tabular text-lg font-semibold">{overview.jobs[st] ?? 0}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          {env.MOCK_MODE && (
            <Panel title="Demo failure switch" description="MOCK_MODE only. Forces the mock CRM provider to fail every call, so retries and Failed Automations can be demonstrated on demand.">
              <CrmFailureModeSwitch current={overview.failureMode} />
            </Panel>
          )}
        </div>

        <Panel title="Pipeline stage mapping" description="Our stage ↔ HighLevel stage id. Used when syncing opportunities. Leave blank to sync without a stage (still creates/updates the opportunity).">
          <div className="space-y-2.5">
            {overview.stages.map((s) => (
              <StageMappingForm key={s.key} stageKey={s.key} label={STAGE_META[s.key].label} ghlStageId={s.ghlStageId} />
            ))}
          </div>
        </Panel>

        <Panel title="Recent integration calls" flush>
          {overview.calls.length === 0 ? (
            <EmptyState title="No integration calls yet" />
          ) : (
            <Table>
              <thead>
                <tr><Th>Time</Th><Th>Provider</Th><Th>Operation</Th><Th className="text-right">HTTP</Th><Th className="text-right">Attempt</Th><Th>Result</Th></tr>
              </thead>
              <tbody>
                {overview.calls.map((c) => (
                  <tr key={c.id}>
                    <Td className="tabular whitespace-nowrap text-[13px] text-muted">{formatDateTime(c.createdAt, env.APP_TIMEZONE)}</Td>
                    <Td>{c.provider}</Td>
                    <Td className="font-medium">{c.operation}</Td>
                    <Td className="tabular text-right">{c.statusCode ?? "—"}</Td>
                    <Td className="tabular text-right">{c.attempt}</Td>
                    <Td><StatusBadge status={c.success ? "succeeded" : "failed"} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
    </>
  );
}

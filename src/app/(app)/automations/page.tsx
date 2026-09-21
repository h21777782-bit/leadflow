import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { CancelJobButton, CancelWorkflowButton, FailureModeSwitch, RetryJobButton, StepDelayForm } from "@/components/automations/controls";
import { StatusBadge } from "@/components/ui/badges";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Table, Td, Th } from "@/components/ui/table";
import { getEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/format";
import { getAutomationOverview, listJobs, listWorkflowRuns } from "@/server/queries";
import { SUPPORTED_JOB_TYPES } from "@/server/worker/runner";

export const metadata: Metadata = { title: "Automations" };

const WORKFLOW_LABEL: Record<string, string> = { new_lead_nurture: "New lead nurture" };
const STOP_LABEL: Record<string, string> = {
  appointment_booked: "Appointment booked",
  lead_replied: "Lead replied",
  deal_won: "Deal won",
  deal_lost: "Deal lost",
  opted_out: "Opted out",
  no_open_deal: "No open deal",
  workflow_cancelled: "Cancelled manually",
  sequence_finished: "Sequence finished",
};
const JOB_STATUS_ORDER = ["pending", "processing", "retry_scheduled", "completed", "skipped", "failed", "cancelled"] as const;

export default async function AutomationsPage() {
  await connection();
  const env = getEnv();
  const tz = env.APP_TIMEZONE;
  const [overview, runs, activeJobs] = await Promise.all([
    getAutomationOverview(),
    listWorkflowRuns(),
    listJobs({ statuses: ["pending", "processing", "retry_scheduled", "failed"], limit: 100 }),
  ]);
  const running = runs.filter((r) => r.status === "running").length;

  return (
    <>
      <PageHeader
        title="Automations"
        description={`${runs.length} workflow runs, ${running} still running. A lead can be in the same workflow only once at a time.`}
      />
      <div className="space-y-6 px-8 py-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel title="Worker status" description="The worker is a separate process (npm run worker) — it must be running for jobs to execute.">
            {overview.workers.length === 0 ? (
              <EmptyState title="No worker has ever reported in">Run `npm run worker` (or `npm run worker:once`) in a separate terminal.</EmptyState>
            ) : (
              <ul className="space-y-2">
                {overview.workers.map((w) => (
                  <li key={w.workerId} className="flex items-center justify-between gap-2 rounded-md bg-canvas px-3 py-2 text-[13px]">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{w.workerId}</p>
                      <p className="text-muted">{w.hostname} · {w.jobsCompleted} done, {w.jobsFailed} failed · last seen {formatDateTime(w.lastSeenAt, tz)}</p>
                    </div>
                    <StatusBadge status={w.online ? "running" : "stopped"} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Job counts" description="Every job currently in the queue, by status.">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {JOB_STATUS_ORDER.map((st) => (
                <div key={st} className="rounded-md bg-canvas px-3 py-2">
                  <dt className="text-[13px] text-muted">{st.replace(/_/g, " ")}</dt>
                  <dd className="tabular text-lg font-semibold">{overview.jobs[st] ?? 0}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </div>

        {env.MOCK_MODE && (
          <Panel
            title="Demo failure switch"
            description="MOCK_MODE only. Forces the mock messaging provider to fail every send, so retries and Failed Automations can be demonstrated on demand."
          >
            <FailureModeSwitch current={overview.failureMode} />
          </Panel>
        )}

        <Panel title="Follow-up step delays" description="Editable timing for the New lead nurture sequence. Changes apply to steps scheduled from now on.">
          <div className="space-y-2.5">
            {overview.steps.filter((s) => s.workflowKey === "new_lead_nurture").map((s) => (
              <StepDelayForm key={s.id} stepId={s.id} stepKey={s.stepKey} delaySeconds={s.delaySeconds} />
            ))}
          </div>
        </Panel>

        <Panel title="New lead nurture — workflow runs" description="One follow-up sequence per contact." flush>
          {runs.length === 0 ? (
            <EmptyState title="No workflow runs yet" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Lead</Th>
                  <Th>Workflow</Th>
                  <Th>Status</Th>
                  <Th>Current step or stop reason</Th>
                  <Th className="text-right">Messages sent</Th>
                  <Th>Started</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <Td><Link href={`/contacts/${r.contactId}`} className="font-medium text-accent hover:underline">{r.contactName}</Link></Td>
                    <Td>{WORKFLOW_LABEL[r.workflowKey] ?? r.workflowKey}</Td>
                    <Td><StatusBadge status={r.status} /></Td>
                    <Td className="text-[13px]">
                      {r.status === "running" ? r.currentStep?.replace(/_/g, " ") : STOP_LABEL[r.stopReason ?? ""] ?? r.stopReason ?? "—"}
                    </Td>
                    <Td className="tabular text-right">{r.messagesSent}</Td>
                    <Td className="tabular whitespace-nowrap text-[13px]">{formatDateTime(r.startedAt, tz)}</Td>
                    <Td>{r.status === "running" && <CancelWorkflowButton runId={r.id} contactId={r.contactId} />}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel title="Jobs" description="Pending, processing, retrying and failed jobs, with full attempt history." flush>
          {activeJobs.length === 0 ? (
            <EmptyState title="No active jobs">Everything has completed or nothing has been scheduled yet.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Type</Th>
                  <Th>Lead</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Attempts</Th>
                  <Th>Last error</Th>
                  <Th>Next / due</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {activeJobs.map((j) => (
                  <tr key={j.id}>
                    <Td className="whitespace-nowrap font-medium">{j.type}</Td>
                    <Td>{j.contactId ? <Link href={`/contacts/${j.contactId}`} className="text-accent hover:underline">{j.contactName}</Link> : "—"}</Td>
                    <Td><StatusBadge status={j.status} /></Td>
                    <Td className="tabular text-right">{j.attempts} / {j.maxAttempts}</Td>
                    <Td className="max-w-xs text-[13px] text-bad">
                      {j.lastError}
                      {j.attemptHistory.length > 0 && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-xs text-accent">Attempt history ({j.attemptHistory.length})</summary>
                          <ul className="mt-1 space-y-1 text-xs text-muted">
                            {j.attemptHistory.map((a) => (
                              <li key={a.id}>#{a.attempt} {a.outcome} — {a.error ?? "ok"} {a.durationMs != null && `(${a.durationMs}ms)`}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </Td>
                    <Td className="tabular whitespace-nowrap text-[13px]">{formatDateTime(j.runAt, tz)}</Td>
                    <Td>
                      <div className="flex flex-col gap-1.5">
                        {(j.status === "failed" || j.status === "retry_scheduled") && (
                          SUPPORTED_JOB_TYPES.includes(j.type)
                            ? <RetryJobButton jobId={j.id} contactId={j.contactId ?? undefined} />
                            : <p className="text-xs text-muted">No handler for “{j.type}” yet</p>
                        )}
                        {(j.status === "pending" || j.status === "retry_scheduled") && <CancelJobButton jobId={j.id} contactId={j.contactId ?? undefined} />}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel title="Outgoing messages" description="Follow-up sends. Every one is [SIMULATED] — nothing leaves this system in Phase 4." flush>
          {overview.messages.length === 0 ? (
            <EmptyState title="No follow-up messages sent yet" />
          ) : (
            <ul className="divide-y divide-line">
              {overview.messages.map((m) => (
                <li key={m.id} className="px-5 py-2.5 text-[13px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={`/contacts/${m.contactId}`} className="font-medium text-accent hover:underline">{m.contactName}</Link>
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-pending-soft px-1.5 py-0.5 text-xs font-medium text-pending">SIMULATED</span>
                      <StatusBadge status={m.status} />
                    </div>
                  </div>
                  <p className="mt-0.5 text-muted">To {m.toAddress} — “{m.subject}”</p>
                  {m.error && <p className="mt-0.5 text-bad">{m.error}</p>}
                  <p className="mt-0.5 text-xs text-faint">{formatDateTime(m.attemptedAt ?? m.createdAt, tz)}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

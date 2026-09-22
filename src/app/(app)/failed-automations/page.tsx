import type { Metadata } from "next";
import { connection } from "next/server";
import { FailedJobsTable } from "@/components/automations/bulk-retry";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { listFailedJobTypes, listFailedJobs } from "@/server/queries";
import { getEnv } from "@/lib/env";
import { SUPPORTED_JOB_TYPES } from "@/server/worker/runner";

export const metadata: Metadata = { title: "Failed automations" };

export default async function FailedAutomationsPage({ searchParams }: PageProps<"/failed-automations">) {
  await connection();
  const sp = await searchParams;
  const status = sp.status === "failed" || sp.status === "retry_scheduled" ? sp.status : undefined;
  const type = typeof sp.type === "string" && sp.type ? sp.type : undefined;
  const tz = getEnv().APP_TIMEZONE;

  const [jobs, types] = await Promise.all([listFailedJobs({ status, type }), listFailedJobTypes()]);
  const rows = jobs.map((j) => ({
    id: j.id,
    type: j.type,
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    lastError: j.lastError,
    createdAt: j.createdAt.toISOString(),
    contactId: j.contactId,
    contactName: j.contactName,
    attemptHistory: j.attemptHistory.map((a) => ({ id: a.id, attempt: a.attempt, outcome: a.outcome, error: a.error })),
    retryable: SUPPORTED_JOB_TYPES.includes(j.type),
  }));

  return (
    <>
      <PageHeader
        title="Failed automations"
        description="Jobs that are retrying, or that used up every retry and now need a person to act. Records marked [demo seed] are demo data."
      />
      <div className="px-8 py-6">
        <Panel className="mb-4" title="Filters">
          <form className="flex flex-wrap items-end gap-3 text-[13px]" method="GET">
            <label>
              <span className="mb-1 block font-medium">Status</span>
              <select name="status" defaultValue={status ?? ""} className="rounded-md border border-line-strong bg-surface px-2 py-1.5">
                <option value="">All (failed + retrying)</option>
                <option value="failed">Failed only</option>
                <option value="retry_scheduled">Retry scheduled only</option>
              </select>
            </label>
            <label>
              <span className="mb-1 block font-medium">Job type</span>
              <select name="type" defaultValue={type ?? ""} className="rounded-md border border-line-strong bg-surface px-2 py-1.5">
                <option value="">All types</option>
                {types.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <button type="submit" className="rounded-md border border-line-strong bg-surface px-3 py-1.5 font-medium hover:bg-canvas">Apply</button>
            {(status || type) && <a href="/failed-automations" className="text-accent hover:underline">Clear</a>}
          </form>
        </Panel>

        <Panel flush>
          {rows.length === 0 ? (
            <EmptyState title="Nothing has failed">When an automation runs out of retries it will appear here with its error.</EmptyState>
          ) : (
            <FailedJobsTable jobs={rows} tz={tz} />
          )}
        </Panel>
      </div>
    </>
  );
}

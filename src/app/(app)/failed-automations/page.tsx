import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { StatusBadge } from "@/components/ui/badges";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Table, Td, Th } from "@/components/ui/table";
import { getEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/format";
import { listFailedJobs } from "@/server/queries";

export const metadata: Metadata = { title: "Failed automations" };

export default async function FailedAutomationsPage() {
  await connection();
  const tz = getEnv().APP_TIMEZONE;
  const jobs = await listFailedJobs();

  return (
    <>
      <PageHeader
        title="Failed automations"
        description="Jobs that are retrying, or that used up every retry and now need a person to act. Records marked [demo seed] are demo data."
      />
      <div className="px-8 py-6">
        <Panel flush>
          {jobs.length === 0 ? (
            <EmptyState title="Nothing has failed">When an automation runs out of retries it will appear here with its error.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Workflow step</Th>
                  <Th>Lead</Th>
                  <Th>First attempt</Th>
                  <Th>Error</Th>
                  <Th className="text-right">Retries</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <Td className="whitespace-nowrap font-medium">{j.type}</Td>
                    <Td>
                      {j.contactId ? (
                        <Link href={`/contacts/${j.contactId}`} className="text-accent hover:underline">{j.contactName}</Link>
                      ) : "—"}
                    </Td>
                    <Td className="tabular whitespace-nowrap text-[13px]">{formatDateTime(j.createdAt, tz)}</Td>
                    <Td className="max-w-md text-[13px] text-bad">{j.lastError}</Td>
                    <Td className="tabular text-right">{j.attempts} / {j.maxAttempts}</Td>
                    <Td><StatusBadge status={j.status} /></Td>
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

import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { StatusBadge } from "@/components/ui/badges";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Table, Td, Th } from "@/components/ui/table";
import { getEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/format";
import { listWorkflowRuns } from "@/server/queries";

export const metadata: Metadata = { title: "Automations" };

const WORKFLOW_LABEL: Record<string, string> = { new_lead_nurture: "New lead nurture" };
const STOP_LABEL: Record<string, string> = { appointment_booked: "Appointment booked", lead_responded: "Lead responded" };

export default async function AutomationsPage() {
  await connection();
  const tz = getEnv().APP_TIMEZONE;
  const runs = await listWorkflowRuns();
  const running = runs.filter((r) => r.status === "running").length;

  return (
    <>
      <PageHeader
        title="Automations"
        description={`${runs.length} workflow runs, ${running} still running. A lead can be in the same workflow only once at a time.`}
      />
      <div className="px-8 py-6">
        <Panel title="New lead nurture" description="Acknowledge immediately, follow up twice, stop when the lead replies or books a call." flush>
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

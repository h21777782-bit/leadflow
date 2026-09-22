import type { Metadata } from "next";
import { connection } from "next/server";
import { ReprocessButton } from "@/components/webhooks/controls";
import { Badge, StatusBadge } from "@/components/ui/badges";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Table, Td, Th } from "@/components/ui/table";
import { getEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/format";
import { listWebhookEvents } from "@/server/queries";

export const metadata: Metadata = { title: "Webhook events" };

export default async function WebhooksPage() {
  await connection();
  const tz = getEnv().APP_TIMEZONE;
  const events = await listWebhookEvents(100);
  const failed = events.filter((e) => e.status === "failed").length;

  return (
    <>
      <PageHeader
        title="Webhook events"
        description={`${events.length} received, ${failed} failed. Every inbound webhook is authenticated (HMAC for website/n8n, Ed25519 for HighLevel) before anything is stored.`}
      />
      <div className="px-8 py-6">
        <Panel flush>
          {events.length === 0 ? (
            <EmptyState title="No webhooks received yet">Send one with `npm run webhook:send -- leads`.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Received</Th>
                  <Th>Source</Th>
                  <Th>Type</Th>
                  <Th>Signature</Th>
                  <Th>Status</Th>
                  <Th>Result / error</Th>
                  <Th>Payload</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <Td className="tabular whitespace-nowrap text-[13px] text-muted">{formatDateTime(e.receivedAt, tz)}</Td>
                    <Td className="whitespace-nowrap font-medium">{e.source}</Td>
                    <Td>{e.eventType}</Td>
                    <Td>{e.signatureValid == null ? "—" : <Badge tone={e.signatureValid ? "ok" : "bad"}>{e.signatureValid ? "Valid" : "Invalid"}</Badge>}</Td>
                    <Td><StatusBadge status={e.status} /></Td>
                    <Td className="max-w-xs text-[13px]">
                      {e.error ? <span className="text-bad">{e.error}</span> : e.result ? <span className="text-muted">{JSON.stringify(e.result)}</span> : "—"}
                      {e.job && <div className="mt-0.5 text-xs text-faint">job: {e.job.status} ({e.job.attempts}/{e.job.maxAttempts} attempts)</div>}
                    </Td>
                    <Td className="max-w-xs">
                      <details>
                        <summary className="cursor-pointer text-xs text-accent">View payload</summary>
                        <pre className="mt-1 max-w-xs overflow-x-auto whitespace-pre-wrap break-all rounded bg-canvas p-2 text-xs">{JSON.stringify(e.payload, null, 2)}</pre>
                      </details>
                    </Td>
                    <Td>{e.status === "failed" && <ReprocessButton webhookEventId={e.id} />}</Td>
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

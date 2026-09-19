import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Badge } from "@/components/ui/badges";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Table, Td, Th } from "@/components/ui/table";
import { getEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/format";
import { listActivity } from "@/server/queries";

export const metadata: Metadata = { title: "Activity log" };

const TONE = (eventType: string) =>
  eventType.includes("failed") || eventType.includes("dead") ? "bad" : eventType.startsWith("stage") ? "accent" : "neutral";

export default async function ActivityPage() {
  await connection();
  const tz = getEnv().APP_TIMEZONE;
  const events = await listActivity({ limit: 200 });

  return (
    <>
      <PageHeader title="Activity log" description="Append-only record of what happened, who or what did it, and when. Showing the latest 200 events." />
      <div className="px-8 py-6">
        <Panel flush>
          {events.length === 0 ? (
            <EmptyState title="No activity yet" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>Event</Th>
                  <Th>What happened</Th>
                  <Th>Lead</Th>
                  <Th>Actor</Th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <Td className="tabular whitespace-nowrap text-[13px] text-muted">{formatDateTime(e.createdAt, tz)}</Td>
                    <Td><Badge tone={TONE(e.eventType)}>{e.eventType}</Badge></Td>
                    <Td>{e.message}</Td>
                    <Td>
                      {e.contactId ? <Link href={`/contacts/${e.contactId}`} className="text-accent hover:underline">{e.contactName}</Link> : "—"}
                    </Td>
                    <Td className="text-[13px] text-muted">{e.actorType}</Td>
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

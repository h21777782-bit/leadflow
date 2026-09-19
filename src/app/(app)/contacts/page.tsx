import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { StageBadge } from "@/components/ui/badges";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Table, Td, Th } from "@/components/ui/table";
import { getEnv } from "@/lib/env";
import { formatDateTime, formatMoney } from "@/lib/format";
import { fullName } from "@/lib/normalize";
import { SERVICE_LABEL, SOURCE_LABEL, type LeadSource, type Service } from "@/lib/pipeline";
import { listContacts } from "@/server/queries";

export const metadata: Metadata = { title: "Contacts" };

export default async function ContactsPage() {
  await connection();
  const tz = getEnv().APP_TIMEZONE;
  const rows = await listContacts();

  return (
    <>
      <PageHeader title="Contacts" description={`${rows.length} contacts. Each email and phone number can exist only once.`} />
      <div className="px-8 py-6">
        <Panel flush>
          {rows.length === 0 ? (
            <EmptyState title="No contacts yet">Run <code>npm run db:seed</code> to load the demo data.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Company</Th>
                  <Th>Source</Th>
                  <Th>Service</Th>
                  <Th className="text-right">Budget</Th>
                  <Th>Owner</Th>
                  <Th>Stage</Th>
                  <Th>Next follow-up</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="hover:bg-canvas/70">
                    <Td>
                      <Link href={`/contacts/${c.id}`} className="font-medium text-accent hover:underline">
                        {fullName(c.firstName, c.lastName)}
                      </Link>
                      <div className="text-[13px] text-muted">{c.email}</div>
                    </Td>
                    <Td>
                      {c.company}
                      <div className="text-[13px] text-muted">{c.country}</div>
                    </Td>
                    <Td>{SOURCE_LABEL[c.leadSource as LeadSource] ?? c.leadSource}</Td>
                    <Td>{c.serviceInterest ? SERVICE_LABEL[c.serviceInterest as Service] ?? c.serviceInterest : "—"}</Td>
                    <Td className="tabular text-right">{formatMoney(c.budgetAmount, c.budgetCurrency)}</Td>
                    <Td>{c.ownerName ?? "Unassigned"}</Td>
                    <Td><StageBadge stage={c.stage} /></Td>
                    <Td className="tabular whitespace-nowrap text-[13px]">{formatDateTime(c.nextFollowUpAt, tz, { dateStyle: "medium" })}</Td>
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

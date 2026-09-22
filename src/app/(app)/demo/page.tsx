import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { sql } from "drizzle-orm";
import { createDemoLeadAction, resetDemoDataAction } from "@/app/actions/demo";
import { StageBadge, BandBadge } from "@/components/ui/badges";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { getDb } from "@/db/client";
import { contacts } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/format";
import { fullName } from "@/lib/normalize";
import { isUuid } from "@/lib/ids";
import { DEMO_TAG } from "@/lib/demo";
import { getContactDetail } from "@/server/queries";

export const metadata: Metadata = { title: "Demo scenario" };

const STEP_LABELS: Record<string, string> = {
  "contact.created": "1. Duplicate check passed — new contact created",
  "opportunity.created": "2. Opportunity opened in the pipeline (New lead)",
  "lead.scored": "3. Lead scored",
  "owner.assigned": "4. Assigned to a rep by the routing engine",
  "owner.reassigned": "4. Reassigned by the routing engine",
  "lead.unassigned": "4. Left unassigned (with a reason)",
  "workflow.triggered": "5. Follow-up sequence scheduled",
  "crm.sync_enqueue_failed": "(HighLevel sync enqueue — see Integrations)",
};

export default async function DemoPage({ searchParams }: PageProps<"/demo">) {
  await connection();
  const sp = await searchParams;
  const tz = getEnv().APP_TIMEZONE;
  const contactId = typeof sp.contactId === "string" && isUuid(sp.contactId) ? sp.contactId : null;
  const error = typeof sp.error === "string" ? sp.error : null;

  const detail = contactId ? await getContactDetail(contactId) : null;
  const existingDemoLeads = await getDb()
    .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, createdAt: contacts.createdAt })
    .from(contacts)
    .where(sql`${DEMO_TAG} = any(${contacts.tags})`)
    .orderBy(sql`${contacts.createdAt} desc`)
    .limit(20);

  return (
    <>
      <PageHeader
        title="Demo scenario"
        description="One button runs a real lead through the actual intake service — duplicate check, scoring, routing, and workflow start — and shows the real audit-log timeline it produced, not a scripted animation."
      />
      <div className="space-y-6 px-8 py-6">
        <Panel>
          <div className="flex flex-wrap items-center gap-3">
            <form action={createDemoLeadAction}>
              <button type="submit" className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent/90">
                Create a demo lead
              </button>
            </form>
            <form action={resetDemoDataAction}>
              <button type="submit" className="rounded-md border border-bad/40 bg-bad-soft px-4 py-2 font-medium text-bad hover:bg-bad-soft/70">
                Reset demo data ({existingDemoLeads.length})
              </button>
            </form>
          </div>
          {error && <p className="mt-3 text-[13px] text-bad">Could not create a demo lead: {error}</p>}
          <p className="mt-3 text-[13px] text-muted">
            Reset only ever deletes contacts tagged <code>{DEMO_TAG}</code> — nothing from the seeded demo dataset or
            anything created through the real forms is touched.
          </p>
        </Panel>

        {detail && (
          <Panel title={`Timeline for ${fullName(detail.contact.firstName, detail.contact.lastName)}`} description="Every row below is a real row from audit_logs, in the order it was actually written — this is what just happened, not a mock-up.">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <StageBadge stage={detail.opportunities[0]?.stage ?? null} />
              <BandBadge band={detail.contact.leadBand} score={detail.contact.leadScore} />
              <Link href={`/contacts/${detail.contact.id}`} className="text-[13px] font-medium text-accent hover:underline">Open full lead page →</Link>
              <Link href="/pipeline" className="text-[13px] font-medium text-accent hover:underline">View on the pipeline board →</Link>
            </div>
            {detail.timeline.length === 0 ? (
              <EmptyState title="No events yet" />
            ) : (
              <ol className="space-y-3 border-l-2 border-accent/30 pl-4">
                {[...detail.timeline].reverse().map((e) => (
                  <li key={e.id}>
                    <p className="text-[13px] font-medium">{STEP_LABELS[e.eventType] ?? e.eventType}</p>
                    <p className="text-[13px] text-muted">{e.message}</p>
                    <p className="text-xs text-faint">{formatDateTime(e.createdAt, tz)} · {e.eventType}</p>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        )}

        <Panel title={`Demo leads (${existingDemoLeads.length})`} description="Every lead currently tagged demo-live." flush>
          {existingDemoLeads.length === 0 ? (
            <EmptyState title="No demo leads right now">Click “Create a demo lead” above.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {existingDemoLeads.map((c) => (
                <li key={c.id} className="flex items-center justify-between px-5 py-2.5 text-[13px]">
                  <Link href={`/demo?contactId=${c.id}`} className="font-medium text-accent hover:underline">{fullName(c.firstName, c.lastName)}</Link>
                  <span className="text-muted">{formatDateTime(c.createdAt, tz)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

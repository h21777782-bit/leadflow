/**
 * LEAD INTAKE — idempotent processing of a "new lead" event (website form, n8n, …).
 *
 * The same event delivered twice (webhook retry, double-click, n8n re-run) must not
 * create a second contact, opportunity, workflow run or follow-up job:
 *   1. webhook_events has UNIQUE(source, external_event_id) → the second delivery is detected
 *      and the stored result of the first is returned.
 *   2. A DIFFERENT event for the same person hits duplicate detection → contact is reused
 *      (merged), an open opportunity is reused, and the existing workflow run is reused.
 * Phase 6 will put an authenticated HTTP webhook in front of this function.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { opportunities, webhookEvents } from "@/db/schema";
import { createContact, mergeIntoContact } from "./contacts";
import { createOpportunity } from "./opportunities";
import type { Actor } from "./types";
import { startNurtureWorkflow } from "@/server/workflows/nurture";

export type IntakeResult =
  | { status: "processed"; eventId: string; contactId: string; opportunityId: string; workflowRunId: string | null; created: boolean; detail: string }
  | { status: "duplicate_event"; eventId: string; previous: Record<string, unknown> | null; detail: string }
  | { status: "rejected"; eventId: string; detail: string; errors?: Record<string, string> };

export async function ingestLeadEvent(
  db: Database,
  actor: Actor,
  evt: { source: string; eventId: string; lead: Record<string, unknown> },
): Promise<IntakeResult> {
  const [claimed] = await db
    .insert(webhookEvents)
    .values({ source: evt.source, eventType: "lead.created", externalEventId: evt.eventId, payload: evt.lead, status: "received" })
    .onConflictDoNothing({ target: [webhookEvents.source, webhookEvents.externalEventId] })
    .returning({ id: webhookEvents.id });

  if (!claimed) {
    const [prev] = await db.select().from(webhookEvents).where(and(eq(webhookEvents.source, evt.source), eq(webhookEvents.externalEventId, evt.eventId)));
    return {
      status: "duplicate_event",
      eventId: evt.eventId,
      previous: prev?.result ?? null,
      detail: prev?.status === "processed" ? "Already processed — returning the original result, nothing created" : `Already received (status: ${prev?.status}) — not processed twice`,
    };
  }

  const finish = async (status: "processed" | "rejected" | "failed", result: Record<string, unknown>, error?: string) => {
    await db.update(webhookEvents).set({ status, result, error: error ?? null, processedAt: sql`now()` }).where(eq(webhookEvents.id, claimed.id));
  };

  try {
    const r = await createContact(db, actor, evt.lead);
    if (r.status === "invalid") {
      await finish("rejected", { errors: r.errors }, "Invalid lead data");
      return { status: "rejected", eventId: evt.eventId, detail: "Invalid lead data", errors: r.errors };
    }
    if (r.status === "duplicate" && r.matches.length > 1) {
      const detail = `Email and phone match different contacts (${r.matches.map((m) => m.name).join(", ")}) — needs a person`;
      await finish("rejected", { matches: r.matches.map((m) => m.id) }, detail);
      return { status: "rejected", eventId: evt.eventId, detail };
    }

    let contactId: string;
    let created = false;
    if (r.status === "created") {
      contactId = r.contactId;
      created = true;
    } else {
      contactId = r.matches[0].id;
      await mergeIntoContact(db, actor, contactId, evt.lead); // reuse the person, fill in new details
    }

    // Reuse the open deal, or open one if the person had none (e.g. returning after a lost deal).
    let [opp] = await db.select({ id: opportunities.id }).from(opportunities).where(and(eq(opportunities.contactId, contactId), eq(opportunities.status, "open"))).orderBy(desc(opportunities.createdAt)).limit(1);
    if (!opp) {
      const o = await createOpportunity(db, actor, contactId, { title: `Returning enquiry via ${evt.source}`, valueAmount: Number(evt.lead.budgetAmount ?? 0) || 0 });
      if (o.status !== "created") throw new Error("Could not create opportunity for returning lead");
      opp = { id: o.opportunityId };
    }

    const wf = r.status === "created" && r.workflow ? r.workflow : await startNurtureWorkflow(db, actor, contactId, `intake:${evt.source}`);
    const workflowRunId = wf.status === "skipped" ? null : wf.runId;
    const detail = `${created ? "New contact" : "Existing contact reused"}; workflow ${wf.status}${"reason" in wf ? ` (${wf.reason})` : ""}`;
    await finish("processed", { contactId, opportunityId: opp.id, workflowRunId, created });
    return { status: "processed", eventId: evt.eventId, contactId, opportunityId: opp.id, workflowRunId, created, detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finish("failed", {}, message);
    throw err;
  }
}

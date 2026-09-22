/**
 * Generic inbound webhook receiver — used by 5 of the 6 Phase 6 endpoints
 * (contacts, opportunities, appointments, payments, messages). "leads" is
 * NOT routed through this: it reuses `ingestLeadEvent`'s own idempotent
 * webhook_events handling directly, and layering this on top of it would
 * insert into the same (source, externalEventId) key twice — the second
 * insert (inside ingestLeadEvent) would always find the row this receiver
 * already claimed and report "duplicate" on the very first real delivery.
 * See IMPLEMENTATION_LOG.md, Phase 6.
 *
 * Acknowledges fast: claims the event (idempotent insert), enqueues a
 * `webhook.process` job, and returns immediately — the job does the work.
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { webhookEvents } from "@/db/schema";
import { enqueueJob } from "@/server/queue/queue";

export const WEBHOOK_PROCESS_JOB = "webhook.process";
export type WebhookResourceType = "contacts" | "opportunities" | "appointments" | "payments" | "messages";

export type ReceiveWebhookInput = {
  source: string;
  resourceType: WebhookResourceType;
  externalEventId: string;
  payload: Record<string, unknown>;
  signatureValid: boolean;
};

export type ReceiveWebhookResult =
  | { status: "accepted"; eventId: string }
  | { status: "duplicate"; eventId: string; result: Record<string, unknown> | null; webhookStatus: string };

export async function receiveWebhook(db: Database, input: ReceiveWebhookInput): Promise<ReceiveWebhookResult> {
  const [claimed] = await db
    .insert(webhookEvents)
    .values({
      source: input.source,
      eventType: input.resourceType,
      externalEventId: input.externalEventId,
      payload: input.payload,
      signatureValid: input.signatureValid,
      status: "received",
    })
    .onConflictDoNothing({ target: [webhookEvents.source, webhookEvents.externalEventId] })
    .returning({ id: webhookEvents.id });

  if (!claimed) {
    const [existing] = await db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.source, input.source), eq(webhookEvents.externalEventId, input.externalEventId)));
    return { status: "duplicate", eventId: existing.id, result: existing.result, webhookStatus: existing.status };
  }

  const { jobId } = await enqueueJob(db, {
    type: WEBHOOK_PROCESS_JOB,
    idempotencyKey: `webhook:${claimed.id}`,
    runAt: new Date(),
    payload: { webhookEventId: claimed.id },
  });
  await db.update(webhookEvents).set({ jobId }).where(eq(webhookEvents.id, claimed.id));
  return { status: "accepted", eventId: claimed.id };
}

/** Used by the Webhook Events screen's Reprocess button. */
export async function reprocessWebhookEvent(db: Database, webhookEventId: string): Promise<{ status: "not_found" } | { status: "ok"; jobId: string }> {
  const [row] = await db.select({ id: webhookEvents.id }).from(webhookEvents).where(eq(webhookEvents.id, webhookEventId));
  if (!row) return { status: "not_found" };
  const { jobId } = await enqueueJob(db, {
    type: WEBHOOK_PROCESS_JOB,
    idempotencyKey: `webhook:${row.id}:reprocess:${Date.now()}`,
    runAt: new Date(),
    payload: { webhookEventId: row.id },
  });
  await db.update(webhookEvents).set({ jobId, status: "received", error: null }).where(eq(webhookEvents.id, row.id));
  return { status: "ok", jobId };
}

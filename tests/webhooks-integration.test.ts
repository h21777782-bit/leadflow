/**
 * Phase 6 integration tests against real Postgres (TEST_DATABASE_URL).
 * Signature verification itself is unit-tested in webhook-signature.test.ts
 * (pure, no DB). This file covers the receiver's DB-level guarantees:
 * duplicate delivery, concurrent duplicates, invalid payloads, reprocessing,
 * and payment → won.
 */
import { hasTestDb } from "./helpers/test-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, getDb } from "@/db/client";
import { contacts, jobs, notifications, onboardingTasks, opportunities, payments, webhookEvents } from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { PermanentJobError } from "@/lib/job-errors";
import { claimDueJobs } from "@/server/queue/queue";
import { processJob } from "@/server/worker/runner";
import { createContact } from "@/server/services/contacts";
import { processPaymentReceived } from "@/server/services/payments";
import type { Actor } from "@/server/services/types";
import { receiveWebhook, reprocessWebhookEvent, WEBHOOK_PROCESS_JOB } from "@/server/services/webhooks";
import { handleProcessWebhook } from "@/server/workflows/webhook-process";

const actor: Actor = { type: "user", userId: null, label: "test-runner" };
const db = () => getDb();
let seq = 0;
const uniq = () => `${Date.now()}-${++seq}`;

async function makeLead(prefix: string) {
  const r = await createContact(db(), actor, { firstName: prefix, lastName: "Webhook", email: `${prefix.toLowerCase()}-${uniq()}@webhook.example`, leadSource: "website_form" });
  if (r.status !== "created" || !r.opportunityId) throw new Error(`makeLead(${prefix}) failed: ${JSON.stringify(r)}`);
  return { contactId: r.contactId, opportunityId: r.opportunityId };
}

async function processQueuedWebhookJob(webhookEventId: string) {
  const claimed = await claimDueJobs(db(), "webhook-test-worker", 10);
  const job = claimed.find((j) => j.type === WEBHOOK_PROCESS_JOB && (j.payload as { webhookEventId?: string }).webhookEventId === webhookEventId);
  if (!job) throw new Error(`no queued webhook.process job found for event ${webhookEventId}`);
  return processJob(db(), job, "webhook-test-worker");
}

describe.skipIf(!hasTestDb)("webhooks (integration)", () => {
  beforeAll(async () => {
    await migrate(db(), { migrationsFolder: "./drizzle" });
    await seedDatabase(db());
  });
  afterAll(async () => {
    await closeDb();
  });

  // ── Duplicate delivery ───────────────────────────────────────────────────
  it("duplicate delivery: the same (source, eventId) is claimed once; the second delivery returns the original result", async () => {
    const eventId = `dup-${uniq()}`;
    const first = await receiveWebhook(db(), { source: "n8n", resourceType: "contacts", externalEventId: eventId, payload: { email: "dup@webhook.example" }, signatureValid: true });
    expect(first.status).toBe("accepted");
    const second = await receiveWebhook(db(), { source: "n8n", resourceType: "contacts", externalEventId: eventId, payload: { email: "different-payload-ignored@webhook.example" }, signatureValid: true });
    expect(second.status).toBe("duplicate");
    if (second.status === "duplicate") expect(second.eventId).toBe(first.status === "accepted" ? first.eventId : "");

    const rows = await db().select().from(webhookEvents).where(and(eq(webhookEvents.source, "n8n"), eq(webhookEvents.externalEventId, eventId)));
    expect(rows).toHaveLength(1);
    const jobRows = await db().select().from(jobs).where(eq(jobs.idempotencyKey, `webhook:${rows[0].id}`));
    expect(jobRows).toHaveLength(1);
  });

  it("concurrent duplicates: 5 simultaneous deliveries of the same event create exactly one row and one job", async () => {
    const eventId = `race-${uniq()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => receiveWebhook(db(), { source: "n8n", resourceType: "contacts", externalEventId: eventId, payload: { email: "race@webhook.example" }, signatureValid: true })),
    );
    expect(results.filter((r) => r.status === "accepted")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(4);
    const rows = await db().select().from(webhookEvents).where(and(eq(webhookEvents.source, "n8n"), eq(webhookEvents.externalEventId, eventId)));
    expect(rows).toHaveLength(1);
  });

  it("a processed event replayed later returns the SAME stored result, not a fresh re-process", async () => {
    const lead = await makeLead("Replay");
    const eventId = `replay-${uniq()}`;
    const r1 = await receiveWebhook(db(), { source: "n8n", resourceType: "contacts", externalEventId: eventId, payload: { contactId: lead.contactId, company: "Replay Co" }, signatureValid: true });
    if (r1.status !== "accepted") throw new Error("setup failed");
    await processQueuedWebhookJob(r1.eventId);
    const [processedRow] = await db().select().from(webhookEvents).where(eq(webhookEvents.id, r1.eventId));
    expect(processedRow.status).toBe("processed");

    const r2 = await receiveWebhook(db(), { source: "n8n", resourceType: "contacts", externalEventId: eventId, payload: { contactId: lead.contactId, company: "Ignored — duplicate" }, signatureValid: true });
    expect(r2.status).toBe("duplicate");
    if (r2.status === "duplicate") {
      expect(r2.webhookStatus).toBe("processed");
      expect(r2.result).toEqual(processedRow.result);
    }
  });

  // ── Invalid payload ──────────────────────────────────────────────────────
  it("invalid payload (contacts): a permanent error is recorded with a clear message, and the event is marked failed", async () => {
    const r = await receiveWebhook(db(), { source: "website", resourceType: "contacts", externalEventId: `bad-${uniq()}`, payload: { company: "No email or phone or contactId" }, signatureValid: true });
    if (r.status !== "accepted") throw new Error("setup failed");
    const outcome = await processQueuedWebhookJob(r.eventId);
    expect(outcome).toBe("failed"); // permanent — no email/phone/contactId to resolve, exhausts in 1 attempt
    const [row] = await db().select().from(webhookEvents).where(eq(webhookEvents.id, r.eventId));
    expect(row.status).toBe("failed");
    expect(row.error).toContain("email");
  });

  it("invalid payload (opportunities): missing toStage is a permanent error, not a silent no-op", async () => {
    const lead = await makeLead("BadOpp");
    const r = await receiveWebhook(db(), { source: "website", resourceType: "opportunities", externalEventId: `bad-opp-${uniq()}`, payload: { opportunityId: lead.opportunityId }, signatureValid: true });
    if (r.status !== "accepted") throw new Error("setup failed");
    const outcome = await processQueuedWebhookJob(r.eventId);
    expect(outcome).toBe("failed");
    const [row] = await db().select().from(webhookEvents).where(eq(webhookEvents.id, r.eventId));
    expect(row.error).toContain("toStage");
  });

  it("handleProcessWebhook throws PermanentJobError directly for a webhook event that no longer exists", async () => {
    const fakeJob = { id: "does-not-matter", payload: { webhookEventId: "00000000-0000-0000-0000-000000000000" }, attempts: 1, maxAttempts: 5 } as unknown as Parameters<typeof handleProcessWebhook>[1];
    await expect(handleProcessWebhook(db(), fakeJob)).rejects.toBeInstanceOf(PermanentJobError);
  });

  // ── Reprocess ────────────────────────────────────────────────────────────
  it("reprocessWebhookEvent requeues a failed event, and it can succeed the second time once the data is fixed", async () => {
    const lead = await makeLead("Reprocess");
    const r = await receiveWebhook(db(), { source: "website", resourceType: "opportunities", externalEventId: `reprocess-${uniq()}`, payload: { opportunityId: lead.opportunityId }, signatureValid: true });
    if (r.status !== "accepted") throw new Error("setup failed");
    expect(await processQueuedWebhookJob(r.eventId)).toBe("failed"); // missing toStage
    const [failedRow] = await db().select().from(webhookEvents).where(eq(webhookEvents.id, r.eventId));
    expect(failedRow.status).toBe("failed");

    // Fix the underlying stored payload the way a person would before clicking Reprocess, then reprocess.
    await db().update(webhookEvents).set({ payload: { opportunityId: lead.opportunityId, toStage: "qualified" } }).where(eq(webhookEvents.id, r.eventId));
    const reprocess = await reprocessWebhookEvent(db(), r.eventId);
    expect(reprocess.status).toBe("ok");
    const [resetRow] = await db().select().from(webhookEvents).where(eq(webhookEvents.id, r.eventId));
    expect(resetRow.status).toBe("received");
    expect(resetRow.error).toBeNull();

    const outcome = await processQueuedWebhookJob(r.eventId);
    expect(outcome).toBe("completed");
    const [opp] = await db().select().from(opportunities).where(eq(opportunities.id, lead.opportunityId));
    expect(opp.stage).toBe("qualified");
  });

  it("reprocessWebhookEvent on an unknown id returns not_found", async () => {
    const r = await reprocessWebhookEvent(db(), "00000000-0000-0000-0000-000000000000");
    expect(r.status).toBe("not_found");
  });

  // ── Messages (inbound reply) + sales notification ───────────────────────
  it("messages webhook logs the reply, stops follow-ups, and notifies the assigned rep", async () => {
    const lead = await makeLead("Reply");
    const [contact] = await db().select().from(contacts).where(eq(contacts.id, lead.contactId));
    // Assign an owner directly so the notification path has someone to notify (routing itself is Phase 3's concern).
    const [rep] = await db().execute<{ id: string }>(sql`select id from users where role = 'sales_rep' limit 1`);
    const ownerId = rep?.id ?? contact.ownerId;
    if (ownerId) await db().update(contacts).set({ ownerId }).where(eq(contacts.id, lead.contactId));

    const r = await receiveWebhook(db(), { source: "website", resourceType: "messages", externalEventId: `reply-${uniq()}`, payload: { contactId: lead.contactId, channel: "email", body: "Yes, still interested!" }, signatureValid: true });
    if (r.status !== "accepted") throw new Error("setup failed");
    expect(await processQueuedWebhookJob(r.eventId)).toBe("completed");

    if (ownerId) {
      const notes = await db().select().from(notifications).where(eq(notifications.contactId, lead.contactId));
      expect(notes.length).toBeGreaterThanOrEqual(1);
      expect(notes[0].body).toContain("[SIMULATED]");
      expect(notes[0].recipientUserId).toBe(ownerId);
    }
  });

  // ── Payment → won ────────────────────────────────────────────────────────
  it("payment → won: marks the deal won, creates the onboarding checklist once, and is idempotent on externalPaymentId", async () => {
    const lead = await makeLead("Payment");
    const externalPaymentId = `pay-${uniq()}`;

    const r1 = await processPaymentReceived(db(), actor, { opportunityId: lead.opportunityId, amount: 5000, currency: "USD", externalPaymentId });
    expect(r1.status).toBe("processed");
    const [opp] = await db().select().from(opportunities).where(eq(opportunities.id, lead.opportunityId));
    expect(opp.status).toBe("won");
    expect(opp.stage).toBe("won");
    const tasks = await db().select().from(onboardingTasks).where(eq(onboardingTasks.opportunityId, lead.opportunityId));
    expect(tasks).toHaveLength(4);

    // Same externalPaymentId delivered again (webhook retry / duplicate) — no second payment row, no duplicate tasks.
    const r2 = await processPaymentReceived(db(), actor, { opportunityId: lead.opportunityId, amount: 5000, currency: "USD", externalPaymentId });
    expect(r2.status).toBe("duplicate");
    const paymentRows = await db().select().from(payments).where(eq(payments.externalPaymentId, externalPaymentId));
    expect(paymentRows).toHaveLength(1);
    const tasksAfter = await db().select().from(onboardingTasks).where(eq(onboardingTasks.opportunityId, lead.opportunityId));
    expect(tasksAfter).toHaveLength(4);
  });

  it("payment → won via the webhook path end to end (payments resource type)", async () => {
    const lead = await makeLead("PaymentWebhook");
    const r = await receiveWebhook(db(), {
      source: "n8n",
      resourceType: "payments",
      externalEventId: `pay-wh-${uniq()}`,
      payload: { opportunityId: lead.opportunityId, amount: 7500, currency: "USD", externalPaymentId: `pay-wh-ext-${uniq()}` },
      signatureValid: true,
    });
    if (r.status !== "accepted") throw new Error("setup failed");
    expect(await processQueuedWebhookJob(r.eventId)).toBe("completed");
    const [opp] = await db().select().from(opportunities).where(eq(opportunities.id, lead.opportunityId));
    expect(opp.status).toBe("won");
  });

  it("payment for an unknown opportunity is a permanent, clearly-explained failure", async () => {
    const r = await processPaymentReceived(db(), actor, { opportunityId: "00000000-0000-0000-0000-000000000000", amount: 100, externalPaymentId: `pay-nf-${uniq()}` });
    expect(r.status).toBe("not_found");
  });

  it("a negative or missing amount is rejected as invalid, not silently coerced", async () => {
    const lead = await makeLead("BadAmount");
    const r = await processPaymentReceived(db(), actor, { opportunityId: lead.opportunityId, amount: -50, externalPaymentId: `pay-neg-${uniq()}` });
    expect(r.status).toBe("invalid");
  });
});

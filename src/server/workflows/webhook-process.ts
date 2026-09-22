/**
 * `webhook.process` job handler — does the actual work for the 5 webhook
 * resource types that go through the generic receiver (contacts,
 * opportunities, appointments, payments, messages). "leads" is handled
 * synchronously in its own route via `ingestLeadEvent` — see
 * src/server/services/webhooks.ts for why.
 *
 * Every branch reuses an EXISTING service where one exists (contacts,
 * opportunities, messages/reply) rather than writing the DB directly, so a
 * webhook can never do something the UI itself couldn't also do.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { contacts, opportunities, webhookEvents } from "@/db/schema";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { PermanentJobError } from "@/lib/job-errors";
import { upsertAppointmentFromWebhook } from "@/server/services/appointments";
import { writeAudit } from "@/server/services/audit";
import { createContact, findDuplicates, mergeIntoContact } from "@/server/services/contacts";
import { logInboundReply } from "@/server/services/lead-intelligence";
import { notifyRepOfReply } from "@/server/services/notifications";
import { changeStage } from "@/server/services/opportunities";
import { processPaymentReceived } from "@/server/services/payments";
import type { Actor } from "@/server/services/types";
import type { WebhookResourceType } from "@/server/services/webhooks";
import type { Job } from "@/server/queue/queue";
import type { HandlerResult } from "@/server/workflows/nurture";

export const WEBHOOK_PROCESS_JOB = "webhook.process";

async function resolveContactId(db: Database, payload: Record<string, unknown>): Promise<string> {
  if (typeof payload.contactId === "string" && payload.contactId) return payload.contactId;
  const email = typeof payload.email === "string" ? normalizeEmail(payload.email) : null;
  const phone = typeof payload.phone === "string" ? normalizePhone(payload.phone, typeof payload.country === "string" ? payload.country : undefined) : null;
  if (!email && !phone) throw new PermanentJobError("Webhook payload has no contactId, email or phone to resolve a contact");
  const matches = await findDuplicates(db, { emailNormalized: email, phoneE164: phone });
  if (matches.length === 0) throw new PermanentJobError(`No contact found matching ${email ?? phone}`);
  if (matches.length > 1) throw new PermanentJobError(`Ambiguous contact: ${matches.length} contacts matched ${email ?? phone}`);
  return matches[0].id;
}

async function processContacts(db: Database, actor: Actor, payload: Record<string, unknown>): Promise<string> {
  // Direct id reference — the common real-world case for an "update this contact" webhook.
  // Existing values fill in whatever createContact/mergeIntoContact's full-record validation
  // requires (e.g. firstName) that a partial patch payload might not repeat.
  if (typeof payload.contactId === "string" && payload.contactId) {
    const [existing] = await db.select().from(contacts).where(eq(contacts.id, payload.contactId));
    if (!existing) throw new PermanentJobError(`Contact ${payload.contactId} not found`);
    // validateContact expects string | undefined, never null, for optional fields — so nulls from
    // the DB are dropped rather than spread, and only non-null defaults fill in what payload omits.
    const defaults: Record<string, unknown> = { firstName: existing.firstName, leadSource: existing.leadSource };
    if (existing.lastName != null) defaults.lastName = existing.lastName;
    if (existing.email != null) defaults.email = existing.email;
    if (existing.phone != null) defaults.phone = existing.phone;
    const merged = { ...defaults, ...payload };
    const r = await mergeIntoContact(db, actor, existing.id, merged);
    if (r.status === "invalid") throw new PermanentJobError(`Invalid contact payload: ${JSON.stringify(r.errors)}`);
    if (r.status === "duplicate") throw new PermanentJobError("Contact update now matches a different contact — needs a person");
    return `contact ${existing.id} ${r.status}`;
  }

  const email = normalizeEmail(typeof payload.email === "string" ? payload.email : null);
  const phone = normalizePhone(typeof payload.phone === "string" ? payload.phone : null, typeof payload.country === "string" ? payload.country : undefined);
  const existing = email || phone ? await findDuplicates(db, { emailNormalized: email, phoneE164: phone }) : [];
  if (existing.length > 1) throw new PermanentJobError(`Contact payload matches ${existing.length} different contacts — needs a person`);
  if (existing.length === 1) {
    const r = await mergeIntoContact(db, actor, existing[0].id, payload);
    if (r.status === "invalid") throw new PermanentJobError(`Invalid contact payload: ${JSON.stringify(r.errors)}`);
    if (r.status === "duplicate") throw new PermanentJobError("Contact update now matches a different contact — needs a person");
    return `contact ${existing[0].id} ${r.status}`;
  }
  // update-or-create, but never starts a nurture workflow or opens a deal — that is what /api/webhooks/leads is for.
  const r = await createContact(db, actor, payload, { createOpportunity: false });
  if (r.status === "invalid") throw new PermanentJobError(`Invalid contact payload: ${JSON.stringify(r.errors)}`);
  if (r.status === "duplicate") {
    if (r.matches.length === 1) {
      const m = await mergeIntoContact(db, actor, r.matches[0].id, payload);
      if (m.status === "merged" || m.status === "unchanged") return `contact ${r.matches[0].id} ${m.status}`;
    }
    throw new PermanentJobError("Contact payload matches an existing contact ambiguously — needs a person");
  }
  return `contact ${r.contactId} created`;
}

async function processOpportunities(db: Database, actor: Actor, payload: Record<string, unknown>): Promise<string> {
  let opportunityId: string | undefined = typeof payload.opportunityId === "string" ? payload.opportunityId : undefined;
  if (!opportunityId && typeof payload.ghlOpportunityId === "string") {
    const [opp] = await db.select({ id: opportunities.id }).from(opportunities).where(eq(opportunities.ghlOpportunityId, payload.ghlOpportunityId));
    opportunityId = opp?.id;
  }
  if (!opportunityId) throw new PermanentJobError("Webhook payload has no opportunityId or ghlOpportunityId to resolve an opportunity");
  const toStage = typeof payload.toStage === "string" ? payload.toStage : undefined;
  if (!toStage) throw new PermanentJobError("Webhook payload is missing toStage");
  const r = await changeStage(db, actor, { opportunityId, toStage, reason: typeof payload.reason === "string" ? payload.reason : undefined });
  if (r.status === "not_found") throw new PermanentJobError(`Opportunity ${opportunityId} not found`);
  if (r.status === "invalid") throw new PermanentJobError(r.error);
  if (r.status === "conflict") throw new PermanentJobError(r.error);
  return `opportunity ${opportunityId} → ${toStage}`;
}

async function processAppointments(db: Database, actor: Actor, payload: Record<string, unknown>): Promise<string> {
  const contactId = await resolveContactId(db, payload);
  const title = typeof payload.title === "string" && payload.title ? payload.title : "Appointment";
  const startsAt = typeof payload.startsAt === "string" ? new Date(payload.startsAt) : null;
  const endsAt = typeof payload.endsAt === "string" ? new Date(payload.endsAt) : null;
  if (!startsAt || Number.isNaN(startsAt.getTime()) || !endsAt || Number.isNaN(endsAt.getTime())) {
    throw new PermanentJobError("Webhook payload has an invalid or missing startsAt/endsAt");
  }
  const r = await upsertAppointmentFromWebhook(db, actor, {
    contactId,
    title,
    startsAt,
    endsAt,
    timezone: typeof payload.timezone === "string" && payload.timezone ? payload.timezone : "UTC",
    ghlAppointmentId: typeof payload.ghlAppointmentId === "string" ? payload.ghlAppointmentId : null,
    notes: typeof payload.notes === "string" ? payload.notes : null,
  });
  if (r.status === "invalid") throw new PermanentJobError(r.error);
  return `appointment ${r.appointmentId} ${r.status}`;
}

async function processPayments(db: Database, actor: Actor, payload: Record<string, unknown>): Promise<string> {
  let opportunityId: string | undefined = typeof payload.opportunityId === "string" ? payload.opportunityId : undefined;
  if (!opportunityId) {
    const contactId = await resolveContactId(db, payload);
    const [opp] = await db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(and(eq(opportunities.contactId, contactId), eq(opportunities.status, "open")))
      .orderBy(desc(opportunities.createdAt))
      .limit(1);
    opportunityId = opp?.id;
  }
  if (!opportunityId) throw new PermanentJobError("Could not resolve an open opportunity for this payment");
  const amount = typeof payload.amount === "number" ? payload.amount : Number(payload.amount);
  const externalPaymentId = typeof payload.externalPaymentId === "string" ? payload.externalPaymentId : undefined;
  if (!externalPaymentId) throw new PermanentJobError("Webhook payload is missing externalPaymentId");
  const r = await processPaymentReceived(db, actor, { opportunityId, amount, currency: typeof payload.currency === "string" ? payload.currency : undefined, externalPaymentId });
  if (r.status === "invalid") throw new PermanentJobError(r.error);
  if (r.status === "not_found") throw new PermanentJobError(`Opportunity ${opportunityId} not found`);
  return `payment ${r.paymentId} ${r.status}`;
}

async function processMessages(db: Database, actor: Actor, payload: Record<string, unknown>): Promise<string> {
  const contactId = await resolveContactId(db, payload);
  const channel = payload.channel === "sms" ? "sms" : "email";
  const body = typeof payload.body === "string" ? payload.body : "";
  const r = await logInboundReply(db, actor, contactId, { channel, body });
  if (r.status === "invalid") throw new PermanentJobError(r.error);
  if (r.status === "not_found") throw new PermanentJobError(`Contact ${contactId} not found`);
  const [c] = await db.select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, ownerId: contacts.ownerId }).from(contacts).where(eq(contacts.id, contactId));
  if (c) await notifyRepOfReply(db, actor, c, body);
  return `reply logged for contact ${contactId}`;
}

export async function handleProcessWebhook(db: Database, job: Job): Promise<HandlerResult> {
  const { webhookEventId } = job.payload as { webhookEventId?: string };
  if (!webhookEventId) throw new PermanentJobError("Job payload is missing webhookEventId");
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId));
  if (!row) throw new PermanentJobError(`Webhook event ${webhookEventId} no longer exists`);

  const actor: Actor = { type: "webhook", label: `${row.source}:${row.eventType}` };
  const payload = row.payload;

  try {
    let summary: string;
    switch (row.eventType as WebhookResourceType) {
      case "contacts":
        summary = await processContacts(db, actor, payload);
        break;
      case "opportunities":
        summary = await processOpportunities(db, actor, payload);
        break;
      case "appointments":
        summary = await processAppointments(db, actor, payload);
        break;
      case "payments":
        summary = await processPayments(db, actor, payload);
        break;
      case "messages":
        summary = await processMessages(db, actor, payload);
        break;
      default:
        throw new PermanentJobError(`Unknown webhook resource type "${row.eventType}"`);
    }
    await db.update(webhookEvents).set({ status: "processed", result: { summary }, processedAt: sql`now()`, error: null }).where(eq(webhookEvents.id, row.id));
    await writeAudit(db, actor, { eventType: "webhook.processed", entityType: "webhook_event", entityId: row.id, message: `Webhook processed: ${summary}` });
    return { outcome: "completed", note: summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = err instanceof PermanentJobError || job.attempts >= job.maxAttempts;
    await db.update(webhookEvents).set({ status: exhausted ? "failed" : "received", error: message }).where(eq(webhookEvents.id, row.id));
    throw err; // rethrow so the job queue still classifies transient/permanent and retries correctly
  }
}

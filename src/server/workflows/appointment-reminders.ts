/**
 * Appointment reminder jobs (Phase 7) — a SIMULATED message 24h and 1h before
 * an appointment. Reloads the appointment's CURRENT status right before
 * sending, so a reminder is never sent for a cancelled slot even if it was
 * cancelled after the reminder job was scheduled — defense in depth beyond
 * `cancelPendingJobsForAppointment`, which already cancels the job outright
 * in the common case (see src/server/services/appointments.ts).
 */
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { appointments, contacts, messages } from "@/db/schema";
import { PermanentJobError } from "@/lib/job-errors";
import { getMessagingProvider } from "@/server/integrations/messaging";
import type { Job } from "@/server/queue/queue";
import { writeAudit } from "@/server/services/audit";
import type { Actor } from "@/server/services/types";
import type { HandlerResult } from "@/server/workflows/nurture";

export { REMINDER_24H_JOB, REMINDER_1H_JOB } from "@/server/services/appointments";

async function sendReminder(db: Database, job: Job, workerId: string, kind: "24h" | "1h", displayLabel: string): Promise<HandlerResult> {
  const { appointmentId } = job.payload as { appointmentId?: string };
  if (!appointmentId) throw new PermanentJobError("Job payload is missing appointmentId");
  const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
  if (!appt) return { outcome: "skipped", reason: "Appointment no longer exists" };
  if (appt.status === "cancelled") return { outcome: "skipped", reason: "Appointment was cancelled — reminder not sent" };
  const [c] = await db.select().from(contacts).where(eq(contacts.id, appt.contactId));
  if (!c || !c.email) return { outcome: "skipped", reason: "Contact has no email to remind" };

  const idempotencyKey = `appt:reminder:${kind}:${appointmentId}`;
  const subject = `Reminder: ${appt.title} ${displayLabel}`;
  const body = `Hi ${c.firstName}, this is a reminder that "${appt.title}" is ${displayLabel} — ${appt.startsAt.toISOString()} (${appt.timezone}).`;

  const [existing] = await db.select({ status: messages.status }).from(messages).where(eq(messages.idempotencyKey, idempotencyKey));
  if (existing?.status === "sent") return { outcome: "completed", note: "Already sent (idempotent replay)" };
  if (!existing) {
    await db
      .insert(messages)
      .values({ contactId: c.id, channel: "email", direction: "outbound", templateKey: `appointment.reminder_${kind}`, toAddress: c.email, subject, body, status: "queued", provider: "mock", idempotencyKey })
      .onConflictDoNothing({ target: messages.idempotencyKey });
  }
  const provider = getMessagingProvider(db);
  const res = await provider.send({ idempotencyKey, channel: "email", to: c.email, subject, body });
  await db.update(messages).set({ status: "sent", provider: res.provider, providerMessageId: res.providerMessageId, attemptedAt: new Date() }).where(eq(messages.idempotencyKey, idempotencyKey));

  const actor: Actor = { type: "worker", label: workerId };
  await writeAudit(db, actor, {
    eventType: "appointment.reminder_sent",
    entityType: "appointment",
    entityId: appointmentId,
    contactId: c.id,
    message: `[SIMULATED] Reminder sent (${displayLabel}) for "${appt.title}"`,
  });
  return { outcome: "completed", note: `${kind} reminder sent` };
}

export async function handleReminder24h(db: Database, job: Job, workerId: string): Promise<HandlerResult> {
  return sendReminder(db, job, workerId, "24h", "in 24 hours");
}

export async function handleReminder1h(db: Database, job: Job, workerId: string): Promise<HandlerResult> {
  return sendReminder(db, job, workerId, "1h", "in 1 hour");
}

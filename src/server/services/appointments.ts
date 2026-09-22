/**
 * Appointment booking (Phase 7).
 *
 * `bookAppointment()` is the ONE code path for "a slot is now held" — the UI's
 * booking form and the `/api/webhooks/appointments` webhook (an external
 * calendar reporting a new booking) both call it, so every side effect below
 * always happens together, never partially:
 *   1. insert the appointment (the database's EXCLUDE constraint is the real
 *      guarantee against double-booking, even under concurrency — this function
 *      just translates that into a clean result instead of a raw DB error)
 *   2. stage -> appointment_booked (existing changeStage)
 *   3. stop the nurture workflow immediately, not on its next poll
 *   4. a SIMULATED confirmation message
 *   5. reminder jobs at 24h and 1h before (skipped if that time has already passed)
 *   6. notify the assigned rep
 *   7. rescore the lead
 *   8. enqueue a HighLevel calendar sync job (Phase 5's provider + queue)
 *   9. audit
 */
import { and, desc, eq, gt, lt, ne } from "drizzle-orm";
import type { Database } from "@/db/client";
import { exclusionViolation } from "@/db/errors";
import { appointments, contacts, messages, opportunities, users, type appointmentStatusEnum } from "@/db/schema";
import { excludeBookedSlots, generateCandidateSlots, type Slot, type WorkingHours } from "@/lib/scheduling";
import { getMessagingProvider } from "@/server/integrations/messaging";
import { cancelPendingJobsForAppointment, enqueueJob } from "@/server/queue/queue";
import { stopWorkflowForContact } from "@/server/workflows/nurture";
import { writeAudit } from "./audit";
import { recalculateScore } from "./lead-intelligence";
import { notifyRepOfAppointment } from "./notifications";
import { changeStage } from "./opportunities";
import type { Actor } from "./types";

type AppointmentStatus = (typeof appointmentStatusEnum.enumValues)[number];

export const REMINDER_24H_JOB = "appointment.reminder_24h";
export const REMINDER_1H_JOB = "appointment.reminder_1h";
export const CRM_SYNC_APPOINTMENT_JOB = "crm.sync_appointment";
const REMINDER_OFFSETS_MS: [string, number][] = [
  [REMINDER_24H_JOB, 24 * 3_600_000],
  [REMINDER_1H_JOB, 3_600_000],
];

function stamp(): string {
  return new Date().toISOString().slice(0, 19);
}

// ── Availability ─────────────────────────────────────────────────────────────
export async function getRepWorkingHours(db: Database, ownerId: string): Promise<WorkingHours | null> {
  const [u] = await db
    .select({ timezone: users.timezone, workingHoursStart: users.workingHoursStart, workingHoursEnd: users.workingHoursEnd, workingDays: users.workingDays })
    .from(users)
    .where(eq(users.id, ownerId));
  if (!u) return null;
  return { timezone: u.timezone, startTime: u.workingHoursStart, endTime: u.workingHoursEnd, workingDays: u.workingDays };
}

async function bookedIntervals(db: Database, ownerId: string, rangeStart: Date, rangeEnd: Date) {
  return db
    .select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
    .from(appointments)
    .where(and(eq(appointments.ownerId, ownerId), ne(appointments.status, "cancelled"), lt(appointments.startsAt, rangeEnd), gt(appointments.endsAt, rangeStart)));
}

export type GetSlotsResult = { status: "not_found" } | { status: "ok"; slots: Slot[] };

export async function getAvailableSlots(db: Database, input: { ownerId: string; rangeStart: Date; rangeEnd: Date; durationMinutes: number }): Promise<GetSlotsResult> {
  const hours = await getRepWorkingHours(db, input.ownerId);
  if (!hours) return { status: "not_found" };
  const candidates = generateCandidateSlots(hours, input.rangeStart, input.rangeEnd, input.durationMinutes);
  const booked = await bookedIntervals(db, input.ownerId, input.rangeStart, input.rangeEnd);
  return { status: "ok", slots: excludeBookedSlots(candidates, booked) };
}

// ── Book ─────────────────────────────────────────────────────────────────────
export type BookAppointmentInput = {
  contactId: string;
  ownerId: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string; // the lead's timezone, for confirmation/notification copy
  notes?: string | null;
  ghlAppointmentId?: string | null;
  skipPastCheck?: boolean; // webhook-reported bookings may legitimately report something already in progress
};

export type BookAppointmentResult = { status: "invalid"; error: string } | { status: "conflict"; error: string } | { status: "not_found" } | { status: "booked"; appointmentId: string };

export async function bookAppointment(db: Database, actor: Actor, input: BookAppointmentInput): Promise<BookAppointmentResult> {
  if (!input.title.trim()) return { status: "invalid", error: "Missing appointment title" };
  if (!(input.startsAt.getTime() < input.endsAt.getTime())) return { status: "invalid", error: "startsAt must be before endsAt" };
  if (!input.skipPastCheck && input.startsAt.getTime() < Date.now() - 5 * 60_000) return { status: "invalid", error: "Cannot book an appointment in the past" };

  const [contact] = await db.select().from(contacts).where(eq(contacts.id, input.contactId));
  if (!contact) return { status: "not_found" };
  const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.id, input.ownerId));
  if (!owner) return { status: "not_found" };
  const [opp] = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.contactId, input.contactId), eq(opportunities.status, "open")))
    .orderBy(desc(opportunities.createdAt))
    .limit(1);

  let appointmentId: string;
  try {
    const [row] = await db
      .insert(appointments)
      .values({
        contactId: input.contactId,
        opportunityId: opp?.id ?? null,
        ownerId: input.ownerId,
        title: input.title,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timezone: input.timezone,
        status: "scheduled",
        ghlAppointmentId: input.ghlAppointmentId ?? null,
        notes: input.notes ?? null,
      })
      .returning({ id: appointments.id });
    appointmentId = row.id;
  } catch (err) {
    if (exclusionViolation(err)) return { status: "conflict", error: "This rep already has an appointment that overlaps this time" };
    throw err;
  }

  await writeAudit(db, actor, {
    eventType: "appointment.booked",
    entityType: "appointment",
    entityId: appointmentId,
    contactId: input.contactId,
    message: `Appointment "${input.title}" booked for ${input.startsAt.toISOString()} (${input.timezone})`,
    metadata: { startsAt: input.startsAt, timezone: input.timezone },
  });

  if (opp) await changeStage(db, actor, { opportunityId: opp.id, toStage: "appointment_booked" }); // "invalid" (already there/terminal) is fine, not fatal to booking
  await stopWorkflowForContact(db, actor, input.contactId, "Appointment booked");
  await sendConfirmation(db, contact, input.title, input.startsAt, input.timezone, appointmentId);
  await scheduleReminders(db, appointmentId, input.contactId, input.startsAt);
  await notifyRepOfAppointment(db, actor, contact, { title: input.title, startsAt: input.startsAt, timezone: input.timezone });
  await recalculateScore(db, actor, input.contactId, "appointment.booked");
  await enqueueAppointmentSync(db, appointmentId, input.contactId);

  return { status: "booked", appointmentId };
}

async function sendConfirmation(db: Database, contact: typeof contacts.$inferSelect, title: string, startsAt: Date, timezone: string, appointmentId: string): Promise<void> {
  if (!contact.email) return;
  const idempotencyKey = `appt:confirm:${appointmentId}`;
  const subject = `Confirmed: ${title}`;
  const body = `Hi ${contact.firstName}, your appointment "${title}" is confirmed for ${startsAt.toISOString()} (${timezone}).`;
  const [existing] = await db.select({ status: messages.status }).from(messages).where(eq(messages.idempotencyKey, idempotencyKey));
  if (existing?.status === "sent") return;
  if (!existing) {
    await db
      .insert(messages)
      .values({ contactId: contact.id, channel: "email", direction: "outbound", templateKey: "appointment.confirmation", toAddress: contact.email, subject, body, status: "queued", provider: "mock", idempotencyKey })
      .onConflictDoNothing({ target: messages.idempotencyKey });
  }
  try {
    const provider = getMessagingProvider(db);
    const res = await provider.send({ idempotencyKey, channel: "email", to: contact.email, subject, body });
    await db.update(messages).set({ status: "sent", provider: res.provider, providerMessageId: res.providerMessageId, attemptedAt: new Date() }).where(eq(messages.idempotencyKey, idempotencyKey));
  } catch (err) {
    // Best-effort — a failed confirmation message never blocks or undoes the booking itself.
    await db.update(messages).set({ status: "failed", error: err instanceof Error ? err.message : String(err), attemptedAt: new Date() }).where(eq(messages.idempotencyKey, idempotencyKey));
  }
}

async function scheduleReminders(db: Database, appointmentId: string, contactId: string, startsAt: Date): Promise<void> {
  for (const [jobType, msBefore] of REMINDER_OFFSETS_MS) {
    const runAt = new Date(startsAt.getTime() - msBefore);
    if (runAt.getTime() <= Date.now()) continue; // too close to (or already past) the window — skip, don't send a late reminder
    await enqueueJob(db, { type: jobType, idempotencyKey: `${jobType}:${appointmentId}`, runAt, payload: { appointmentId }, contactId, appointmentId });
  }
}

async function enqueueAppointmentSync(db: Database, appointmentId: string, contactId: string): Promise<void> {
  try {
    await enqueueJob(db, { type: CRM_SYNC_APPOINTMENT_JOB, idempotencyKey: `crm:sync_appointment:${appointmentId}:${stamp()}`, runAt: new Date(), payload: { appointmentId }, contactId, appointmentId });
  } catch (err) {
    await writeAudit(db, { type: "system", label: "appointments" }, { eventType: "crm.sync_enqueue_failed", entityType: "appointment", entityId: appointmentId, contactId, message: `Could not enqueue HighLevel calendar sync: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ── Reschedule / cancel / status ─────────────────────────────────────────────
export type SimpleApptResult = { status: "invalid"; error: string } | { status: "not_found" } | { status: "conflict"; error: string } | { status: "ok" };

export async function rescheduleAppointment(db: Database, actor: Actor, appointmentId: string, newStartsAt: Date, newEndsAt: Date): Promise<SimpleApptResult> {
  if (!(newStartsAt.getTime() < newEndsAt.getTime())) return { status: "invalid", error: "startsAt must be before endsAt" };
  const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
  if (!appt) return { status: "not_found" };
  if (appt.status === "cancelled" || appt.status === "completed") return { status: "invalid", error: `Cannot reschedule a ${appt.status} appointment` };

  try {
    await db.update(appointments).set({ startsAt: newStartsAt, endsAt: newEndsAt, status: "scheduled" }).where(eq(appointments.id, appointmentId));
  } catch (err) {
    if (exclusionViolation(err)) return { status: "conflict", error: "This rep already has an appointment that overlaps the new time" };
    throw err;
  }
  await cancelPendingJobsForAppointment(db, appointmentId, "Appointment rescheduled — reminders re-scheduled for the new time");
  await scheduleReminders(db, appointmentId, appt.contactId, newStartsAt);
  await writeAudit(db, actor, { eventType: "appointment.rescheduled", entityType: "appointment", entityId: appointmentId, contactId: appt.contactId, message: `Rescheduled from ${appt.startsAt.toISOString()} to ${newStartsAt.toISOString()}` });
  await enqueueAppointmentSync(db, appointmentId, appt.contactId);
  return { status: "ok" };
}

export async function cancelAppointment(db: Database, actor: Actor, appointmentId: string, reason: string): Promise<SimpleApptResult> {
  const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
  if (!appt) return { status: "not_found" };
  if (appt.status === "cancelled") return { status: "invalid", error: "Already cancelled" };
  await db.update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, appointmentId));
  const n = await cancelPendingJobsForAppointment(db, appointmentId, `Appointment cancelled: ${reason}`);
  await writeAudit(db, actor, { eventType: "appointment.cancelled", entityType: "appointment", entityId: appointmentId, contactId: appt.contactId, message: `Cancelled: ${reason} (${n} pending reminder(s) cancelled)` });
  await enqueueAppointmentSync(db, appointmentId, appt.contactId);
  return { status: "ok" };
}

async function setStatus(db: Database, actor: Actor, appointmentId: string, status: AppointmentStatus, eventType: string): Promise<SimpleApptResult> {
  const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
  if (!appt) return { status: "not_found" };
  if (appt.status === "cancelled" || appt.status === "completed") return { status: "invalid", error: `Already ${appt.status}` };
  await db.update(appointments).set({ status }).where(eq(appointments.id, appointmentId));
  await writeAudit(db, actor, { eventType, entityType: "appointment", entityId: appointmentId, contactId: appt.contactId, message: `Marked ${status}` });
  await recalculateScore(db, actor, appt.contactId, eventType); // completed/no-show both affect the appointment scoring factor
  return { status: "ok" };
}

export const markNoShow = (db: Database, actor: Actor, appointmentId: string) => setStatus(db, actor, appointmentId, "no_show", "appointment.no_show");
export const markCompleted = (db: Database, actor: Actor, appointmentId: string) => setStatus(db, actor, appointmentId, "completed", "appointment.completed");
export const confirmAppointment = (db: Database, actor: Actor, appointmentId: string) => setStatus(db, actor, appointmentId, "confirmed", "appointment.confirmed");

// ── Webhook path (Phase 6/7): reuses bookAppointment / rescheduleAppointment, never writes the row itself ──
export type WebhookAppointmentResult = { status: "invalid"; error: string } | { status: "not_found" } | { status: "conflict"; error: string } | { status: "created" | "updated"; appointmentId: string };

export async function upsertAppointmentFromWebhook(
  db: Database,
  actor: Actor,
  input: { contactId: string; ownerId?: string | null; title: string; startsAt: Date; endsAt: Date; timezone: string; ghlAppointmentId?: string | null; notes?: string | null },
): Promise<WebhookAppointmentResult> {
  if (input.ghlAppointmentId) {
    const [existing] = await db.select().from(appointments).where(eq(appointments.ghlAppointmentId, input.ghlAppointmentId));
    if (existing) {
      const r = await rescheduleAppointment(db, actor, existing.id, input.startsAt, input.endsAt);
      if (r.status === "ok") return { status: "updated", appointmentId: existing.id };
      if (r.status === "conflict") return r;
      return { status: "invalid", error: r.status === "invalid" ? r.error : "Could not update" };
    }
  }
  const [contact] = await db.select({ ownerId: contacts.ownerId }).from(contacts).where(eq(contacts.id, input.contactId));
  const ownerId = input.ownerId ?? contact?.ownerId;
  if (!ownerId) return { status: "invalid", error: "No rep assigned to this contact — cannot book without an owner" };
  const r = await bookAppointment(db, actor, { contactId: input.contactId, ownerId, title: input.title, startsAt: input.startsAt, endsAt: input.endsAt, timezone: input.timezone, ghlAppointmentId: input.ghlAppointmentId, notes: input.notes, skipPastCheck: true });
  if (r.status === "booked") return { status: "created", appointmentId: r.appointmentId };
  return r;
}

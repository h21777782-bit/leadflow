/**
 * Minimal appointment upsert for the Phase 6 webhook (an external calendar
 * system reporting a booking). Full appointment BOOKING — availability,
 * double-booking prevention, reminders, reschedule/cancel flows — is Phase 7;
 * this only records what an external source reports, idempotently.
 */
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { appointments, type appointmentStatusEnum } from "@/db/schema";
import { writeAudit } from "./audit";
import type { Actor } from "./types";

type AppointmentStatus = (typeof appointmentStatusEnum.enumValues)[number];

export type UpsertAppointmentInput = {
  contactId: string;
  opportunityId?: string | null;
  ownerId?: string | null;
  title: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  status?: AppointmentStatus;
  ghlAppointmentId?: string | null;
  notes?: string | null;
};

export type UpsertAppointmentResult =
  | { status: "invalid"; error: string }
  | { status: "created"; appointmentId: string }
  | { status: "updated"; appointmentId: string };

export async function upsertAppointmentFromWebhook(db: Database, actor: Actor, input: UpsertAppointmentInput): Promise<UpsertAppointmentResult> {
  if (!input.title.trim()) return { status: "invalid", error: "Missing appointment title" };
  if (!(input.startsAt.getTime() < input.endsAt.getTime())) return { status: "invalid", error: "startsAt must be before endsAt" };

  if (input.ghlAppointmentId) {
    const [existing] = await db.select().from(appointments).where(eq(appointments.ghlAppointmentId, input.ghlAppointmentId));
    if (existing) {
      await db
        .update(appointments)
        .set({
          title: input.title,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          timezone: input.timezone,
          status: input.status ?? existing.status,
          notes: input.notes ?? existing.notes,
        })
        .where(eq(appointments.id, existing.id));
      await writeAudit(db, actor, {
        eventType: "appointment.updated",
        entityType: "appointment",
        entityId: existing.id,
        contactId: input.contactId,
        message: `Appointment "${input.title}" updated from webhook`,
      });
      return { status: "updated", appointmentId: existing.id };
    }
  }

  const [row] = await db
    .insert(appointments)
    .values({
      contactId: input.contactId,
      opportunityId: input.opportunityId ?? null,
      ownerId: input.ownerId ?? null,
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.timezone,
      status: input.status ?? "scheduled",
      ghlAppointmentId: input.ghlAppointmentId ?? null,
      notes: input.notes ?? null,
    })
    .returning({ id: appointments.id });
  await writeAudit(db, actor, {
    eventType: "appointment.created",
    entityType: "appointment",
    entityId: row.id,
    contactId: input.contactId,
    message: `Appointment "${input.title}" recorded from webhook`,
  });
  return { status: "created", appointmentId: row.id };
}

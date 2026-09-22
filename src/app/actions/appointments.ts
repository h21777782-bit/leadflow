"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import {
  bookAppointment,
  cancelAppointment,
  confirmAppointment,
  getAvailableSlots,
  markCompleted,
  markNoShow,
  rescheduleAppointment,
} from "@/server/services/appointments";
import { getActingUser } from "@/server/services/actor";
import { writeAudit } from "@/server/services/audit";

function revalidateAppointments(contactId?: string) {
  for (const p of ["/appointments", "/dashboard", "/settings"]) revalidatePath(p);
  if (contactId) revalidatePath(`/contacts/${contactId}`);
}

export type ActionResult = { ok: boolean; message: string };

export async function getAvailableSlotsAction(input: { ownerId: string; rangeStart: string; rangeEnd: string; durationMinutes: number }) {
  const r = await getAvailableSlots(getDb(), { ownerId: input.ownerId, rangeStart: new Date(input.rangeStart), rangeEnd: new Date(input.rangeEnd), durationMinutes: input.durationMinutes });
  if (r.status === "not_found") return { ok: false as const, message: "Rep not found", slots: [] };
  return { ok: true as const, message: "", slots: r.slots.map((s) => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })) };
}

export async function bookAppointmentAction(input: { contactId: string; ownerId: string; title: string; startsAt: string; endsAt: string; timezone: string; notes?: string }): Promise<ActionResult> {
  const db = getDb();
  const r = await bookAppointment(db, await getActingUser(db), {
    contactId: input.contactId,
    ownerId: input.ownerId,
    title: input.title,
    startsAt: new Date(input.startsAt),
    endsAt: new Date(input.endsAt),
    timezone: input.timezone,
    notes: input.notes,
  });
  revalidateAppointments(input.contactId);
  if (r.status === "booked") return { ok: true, message: "Appointment booked" };
  if (r.status === "not_found") return { ok: false, message: "Contact or rep not found" };
  return { ok: false, message: r.error };
}

export async function rescheduleAppointmentAction(appointmentId: string, newStartsAt: string, newEndsAt: string, contactId?: string): Promise<ActionResult> {
  const db = getDb();
  const r = await rescheduleAppointment(db, await getActingUser(db), appointmentId, new Date(newStartsAt), new Date(newEndsAt));
  revalidateAppointments(contactId);
  if (r.status === "ok") return { ok: true, message: "Rescheduled" };
  if (r.status === "not_found") return { ok: false, message: "Appointment not found" };
  return { ok: false, message: r.error };
}

export async function cancelAppointmentAction(appointmentId: string, reason: string, contactId?: string): Promise<ActionResult> {
  const db = getDb();
  const r = await cancelAppointment(db, await getActingUser(db), appointmentId, reason || "Cancelled manually");
  revalidateAppointments(contactId);
  if (r.status === "ok") return { ok: true, message: "Cancelled" };
  if (r.status === "not_found") return { ok: false, message: "Appointment not found" };
  return { ok: false, message: r.error };
}

async function simpleStatusAction(fn: typeof markNoShow, appointmentId: string, contactId: string | undefined, okMessage: string): Promise<ActionResult> {
  const db = getDb();
  const r = await fn(db, await getActingUser(db), appointmentId);
  revalidateAppointments(contactId);
  if (r.status === "ok") return { ok: true, message: okMessage };
  if (r.status === "not_found") return { ok: false, message: "Appointment not found" };
  return { ok: false, message: r.error };
}

// Next.js's "use server" compiler requires each exported action to be a plain async function
// declaration (not a const arrow function), so each one is spelled out rather than wrapped.
export async function markNoShowAction(appointmentId: string, contactId?: string): Promise<ActionResult> {
  return simpleStatusAction(markNoShow, appointmentId, contactId, "Marked no-show");
}
export async function markCompletedAction(appointmentId: string, contactId?: string): Promise<ActionResult> {
  return simpleStatusAction(markCompleted, appointmentId, contactId, "Marked completed");
}
export async function confirmAppointmentAction(appointmentId: string, contactId?: string): Promise<ActionResult> {
  return simpleStatusAction(confirmAppointment, appointmentId, contactId, "Confirmed");
}

export async function updateWorkingHoursAction(userId: string, startTime: string, endTime: string, workingDays: number[]): Promise<ActionResult> {
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) return { ok: false, message: "Times must be HH:MM" };
  if (startTime >= endTime) return { ok: false, message: "Start time must be before end time" };
  const db = getDb();
  const [row] = await db.update(users).set({ workingHoursStart: startTime, workingHoursEnd: endTime, workingDays }).where(eq(users.id, userId)).returning({ id: users.id });
  if (!row) return { ok: false, message: "Rep not found" };
  await writeAudit(db, await getActingUser(db), { eventType: "rep.working_hours_updated", entityType: "user", entityId: userId, message: `Working hours updated: ${startTime}–${endTime}, days [${workingDays.join(",")}]` });
  revalidatePath("/settings");
  return { ok: true, message: "Saved" };
}

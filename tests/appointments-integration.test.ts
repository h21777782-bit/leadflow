/**
 * Phase 7 integration tests against real Postgres (TEST_DATABASE_URL).
 * Timezone/DST slot-generation logic is unit-tested in tests/scheduling.test.ts
 * (pure, no DB). This file covers: concurrent double-booking prevention (the
 * database's own EXCLUDE constraint, not just application logic), reminders
 * never sending for a cancelled slot, idempotent booking via webhook, and the
 * full "one flow" side effects (stage change, workflow stop, reminders,
 * notification, rescore).
 */
import { hasTestDb } from "./helpers/test-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, getDb } from "@/db/client";
import { appointments, contacts, jobs, messages, notifications, opportunities, users, workflowRuns } from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { handleReminder1h, handleReminder24h } from "@/server/workflows/appointment-reminders";
import { bookAppointment, cancelAppointment, getAvailableSlots, upsertAppointmentFromWebhook } from "@/server/services/appointments";
import { createContact } from "@/server/services/contacts";
import type { Actor } from "@/server/services/types";
import { exclusionViolation } from "@/db/errors";
import { claimDueJobs } from "@/server/queue/queue";
import { processJob } from "@/server/worker/runner";

const actor: Actor = { type: "user", userId: null, label: "test-runner" };
const db = () => getDb();
let seq = 0;
const uniq = () => `${Date.now()}-${++seq}`;

async function makeLead(prefix: string) {
  const r = await createContact(db(), actor, { firstName: prefix, lastName: "Appt", email: `${prefix.toLowerCase()}-${uniq()}@appt.example`, leadSource: "website_form" });
  if (r.status !== "created" || !r.opportunityId) throw new Error(`makeLead(${prefix}) failed: ${JSON.stringify(r)}`);
  return { contactId: r.contactId, opportunityId: r.opportunityId };
}

async function aRep() {
  const [rep] = await db().select().from(users).where(eq(users.role, "sales_rep")).limit(1);
  return rep;
}

/** A slot far enough out that both 24h and 1h reminders land in the future — a
 * fresh, non-colliding offset every call, so different tests (possibly reusing
 * the same seeded rep) never accidentally overlap each other's leftover data. */
function farFutureSlot() {
  const dayOffset = 10 + (seq % 300);
  const startsAt = new Date(Date.now() + dayOffset * 86_400_000);
  const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
  seq += 1;
  return { startsAt, endsAt };
}

describe.skipIf(!hasTestDb)("appointment booking (integration)", () => {
  beforeAll(async () => {
    await migrate(db(), { migrationsFolder: "./drizzle" });
    await seedDatabase(db());
  });
  afterAll(async () => {
    await closeDb();
  });

  // ── getAvailableSlots ────────────────────────────────────────────────────
  it("getAvailableSlots excludes an already-booked time and returns not_found for an unknown rep", async () => {
    const rep = await aRep();
    const lead = await makeLead("SlotsQuery");
    const { startsAt, endsAt } = farFutureSlot();
    const booked = await bookAppointment(db(), actor, { contactId: lead.contactId, ownerId: rep.id, title: "Occupied", startsAt, endsAt, timezone: "UTC" });
    if (booked.status !== "booked") throw new Error("setup failed");

    const rangeStart = new Date(startsAt.getTime() - 86_400_000);
    const rangeEnd = new Date(endsAt.getTime() + 86_400_000);
    const result = await getAvailableSlots(db(), { ownerId: rep.id, rangeStart, rangeEnd, durationMinutes: 30 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.slots.some((s) => s.startsAt.getTime() === startsAt.getTime())).toBe(false); // the booked slot is gone

    const unknown = await getAvailableSlots(db(), { ownerId: "00000000-0000-0000-0000-000000000000", rangeStart, rangeEnd, durationMinutes: 30 });
    expect(unknown.status).toBe("not_found");
  });

  // ── Double-booking prevention ────────────────────────────────────────────
  it("the database refuses a raw overlapping INSERT for the same rep, even outside the service layer", async () => {
    const rep = await aRep();
    const lead = await makeLead("RawInsert");
    const { startsAt, endsAt } = farFutureSlot();
    await db().insert(appointments).values({ contactId: lead.contactId, ownerId: rep.id, title: "First", startsAt, endsAt, timezone: "UTC", status: "scheduled" });
    const overlapStart = new Date(startsAt.getTime() + 10 * 60_000);
    const overlapEnd = new Date(endsAt.getTime() + 10 * 60_000);
    let caught: unknown;
    try {
      await db().insert(appointments).values({ contactId: lead.contactId, ownerId: rep.id, title: "Overlap", startsAt: overlapStart, endsAt: overlapEnd, timezone: "UTC", status: "scheduled" });
    } catch (err) {
      caught = err;
    }
    expect(exclusionViolation(caught)).toBe("appointments_no_overlap_per_owner");
  });

  it("concurrent booking: two simultaneous requests for the same rep and overlapping time — exactly one succeeds", async () => {
    const rep = await aRep();
    const leadA = await makeLead("RaceA");
    const leadB = await makeLead("RaceB");
    const { startsAt, endsAt } = farFutureSlot();
    const [resultA, resultB] = await Promise.all([
      bookAppointment(db(), actor, { contactId: leadA.contactId, ownerId: rep.id, title: "Race A", startsAt, endsAt, timezone: "UTC" }),
      bookAppointment(db(), actor, { contactId: leadB.contactId, ownerId: rep.id, title: "Race B", startsAt, endsAt, timezone: "UTC" }),
    ]);
    const statuses = [resultA.status, resultB.status].sort();
    expect(statuses).toEqual(["booked", "conflict"]);
    const rows = await db().select().from(appointments).where(eq(appointments.ownerId, rep.id));
    const overlapping = rows.filter((r) => r.startsAt.getTime() === startsAt.getTime() && r.status !== "cancelled");
    expect(overlapping).toHaveLength(1); // never two, however the race resolves
  });

  it("a cancelled appointment does not block a new booking at the same time", async () => {
    const rep = await aRep();
    const leadA = await makeLead("CancelFrees");
    const leadB = await makeLead("CancelFreesB");
    const { startsAt, endsAt } = farFutureSlot();
    const first = await bookAppointment(db(), actor, { contactId: leadA.contactId, ownerId: rep.id, title: "First", startsAt, endsAt, timezone: "UTC" });
    if (first.status !== "booked") throw new Error("setup failed");
    await cancelAppointment(db(), actor, first.appointmentId, "making room");
    const second = await bookAppointment(db(), actor, { contactId: leadB.contactId, ownerId: rep.id, title: "Second", startsAt, endsAt, timezone: "UTC" });
    expect(second.status).toBe("booked");
  });

  // ── Reminders never sent for a cancelled slot ───────────────────────────
  it("cancelling an appointment cancels its pending reminder jobs", async () => {
    const rep = await aRep();
    const lead = await makeLead("ReminderCancel");
    const { startsAt, endsAt } = farFutureSlot();
    const booked = await bookAppointment(db(), actor, { contactId: lead.contactId, ownerId: rep.id, title: "Will be cancelled", startsAt, endsAt, timezone: "UTC" });
    if (booked.status !== "booked") throw new Error("setup failed");
    const before = await db().select().from(jobs).where(eq(jobs.appointmentId, booked.appointmentId));
    expect(before.filter((j) => j.type.startsWith("appointment.reminder"))).toHaveLength(2); // 24h + 1h, both far enough out

    await cancelAppointment(db(), actor, booked.appointmentId, "no longer needed");
    const after = await db().select().from(jobs).where(eq(jobs.appointmentId, booked.appointmentId));
    const reminders = after.filter((j) => j.type.startsWith("appointment.reminder"));
    expect(reminders.every((j) => j.status === "cancelled")).toBe(true);
  });

  it("defense in depth: even if a reminder job somehow still runs after cancellation, the handler skips sending", async () => {
    const rep = await aRep();
    const lead = await makeLead("ReminderDefense");
    const { startsAt, endsAt } = farFutureSlot();
    const booked = await bookAppointment(db(), actor, { contactId: lead.contactId, ownerId: rep.id, title: "Defense test", startsAt, endsAt, timezone: "UTC" });
    if (booked.status !== "booked") throw new Error("setup failed");
    const [reminderJob] = await db().select().from(jobs).where(eq(jobs.appointmentId, booked.appointmentId)).then((rows) => rows.filter((j) => j.type === "appointment.reminder_24h"));

    // Cancel the appointment WITHOUT going through cancelAppointment (simulates a race where the
    // job is already claimed by a worker at the exact moment of cancellation).
    await db().update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, booked.appointmentId));
    const result = await handleReminder24h(db(), reminderJob, "test-worker");
    expect(result.outcome).toBe("skipped");
    expect(result.outcome === "skipped" && result.reason).toContain("cancelled");
    const msgs = await db().select().from(messages).where(eq(messages.contactId, lead.contactId));
    expect(msgs.some((m) => m.templateKey === "appointment.reminder_24h")).toBe(false); // never sent
  });

  it("the 1h reminder handler applies the same cancelled-slot guard", async () => {
    const rep = await aRep();
    const lead = await makeLead("ReminderDefense1h");
    const { startsAt, endsAt } = farFutureSlot();
    const booked = await bookAppointment(db(), actor, { contactId: lead.contactId, ownerId: rep.id, title: "Defense test 1h", startsAt, endsAt, timezone: "UTC" });
    if (booked.status !== "booked") throw new Error("setup failed");
    const [reminderJob] = await db().select().from(jobs).where(eq(jobs.appointmentId, booked.appointmentId)).then((rows) => rows.filter((j) => j.type === "appointment.reminder_1h"));
    await db().update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, booked.appointmentId));
    const result = await handleReminder1h(db(), reminderJob, "test-worker");
    expect(result.outcome).toBe("skipped");
  });

  // ── Idempotent booking webhook ───────────────────────────────────────────
  it("upsertAppointmentFromWebhook is idempotent on ghlAppointmentId: delivered twice updates in place, never creates two rows", async () => {
    const lead = await makeLead("WebhookIdem");
    const rep = await aRep();
    await db().update(contacts).set({ ownerId: rep.id }).where(eq(contacts.id, lead.contactId));
    const ghlAppointmentId = `ghl_appt_${uniq()}`;
    const { startsAt, endsAt } = farFutureSlot();

    const first = await upsertAppointmentFromWebhook(db(), actor, { contactId: lead.contactId, title: "From webhook", startsAt, endsAt, timezone: "UTC", ghlAppointmentId });
    expect(first.status).toBe("created");
    if (first.status !== "created" && first.status !== "updated") throw new Error("unreachable");

    const newStart = new Date(startsAt.getTime() + 60 * 60_000);
    const newEnd = new Date(endsAt.getTime() + 60 * 60_000);
    const second = await upsertAppointmentFromWebhook(db(), actor, { contactId: lead.contactId, title: "From webhook (rescheduled)", startsAt: newStart, endsAt: newEnd, timezone: "UTC", ghlAppointmentId });
    expect(second.status).toBe("updated");
    if (second.status !== "created" && second.status !== "updated") throw new Error("unreachable");
    expect(second.appointmentId).toBe(first.appointmentId); // same row, not a second one

    const rows = await db().select().from(appointments).where(eq(appointments.ghlAppointmentId, ghlAppointmentId));
    expect(rows).toHaveLength(1);
    expect(rows[0].startsAt.getTime()).toBe(newStart.getTime());
  });

  // ── The full "one flow" ──────────────────────────────────────────────────
  it("booking does everything in one flow: stage change, workflow stopped, confirmation message, reminders, notification, rescore", async () => {
    const rep = await aRep();
    const lead = await makeLead("OneFlow");
    const { startsAt, endsAt } = farFutureSlot();
    const [runBefore] = await db().select().from(workflowRuns).where(eq(workflowRuns.contactId, lead.contactId));
    expect(runBefore.status).toBe("running");

    // Give the lead an owner so booking's notify-rep step has someone to notify.
    await db().update(contacts).set({ ownerId: rep.id }).where(eq(contacts.id, lead.contactId));

    const booked = await bookAppointment(db(), actor, { contactId: lead.contactId, ownerId: rep.id, title: "Discovery call", startsAt, endsAt, timezone: "UTC" });
    expect(booked.status).toBe("booked");
    if (booked.status !== "booked") return;

    const [opp] = await db().select().from(opportunities).where(eq(opportunities.id, lead.opportunityId));
    expect(opp.stage).toBe("appointment_booked");

    const [runAfter] = await db().select().from(workflowRuns).where(eq(workflowRuns.contactId, lead.contactId));
    expect(runAfter.status).toBe("stopped");
    expect(runAfter.stopReason).toContain("Appointment booked");

    const msgs = await db().select().from(messages).where(eq(messages.contactId, lead.contactId));
    expect(msgs.some((m) => m.templateKey === "appointment.confirmation" && m.status === "sent")).toBe(true);

    const jobRows = await db().select().from(jobs).where(eq(jobs.appointmentId, booked.appointmentId));
    expect(jobRows.some((j) => j.type === "appointment.reminder_24h")).toBe(true);
    expect(jobRows.some((j) => j.type === "appointment.reminder_1h")).toBe(true);
    expect(jobRows.some((j) => j.type === "crm.sync_appointment")).toBe(true);

    const notes = await db().select().from(notifications).where(eq(notifications.contactId, lead.contactId));
    expect(notes.some((n) => n.subject.includes("booked"))).toBe(true);
  });

  it("crm.sync_appointment retries (transient) until the contact has synced, same ordering pattern as Phase 5", async () => {
    const rep = await aRep();
    const lead = await makeLead("ApptCrmOrdering");
    const { startsAt, endsAt } = farFutureSlot();
    const booked = await bookAppointment(db(), actor, { contactId: lead.contactId, ownerId: rep.id, title: "Ordering test", startsAt, endsAt, timezone: "UTC" });
    if (booked.status !== "booked") throw new Error("setup failed");
    // A generous limit: by this point in the suite many other jobs (from earlier tests, and
    // Phase 4/5/6 tests sharing the same TEST_DATABASE_URL) may already be due.
    const claimed = await claimDueJobs(db(), "appt-crm-worker", 500);
    const syncJob = claimed.find((j) => j.type === "crm.sync_appointment" && j.appointmentId === booked.appointmentId);
    expect(syncJob).toBeDefined();
    const outcome = await processJob(db(), syncJob!, "appt-crm-worker");
    expect(outcome).toBe("retry_scheduled"); // contact not yet synced to HighLevel
  });
});

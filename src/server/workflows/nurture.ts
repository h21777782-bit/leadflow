/**
 * NEW-LEAD NURTURE WORKFLOW
 *
 *   start → follow-up 1 (short, configurable delay) → +1 day follow-up 2 → +3 days follow-up 3 → completed
 *
 * Each step is ONE job whose idempotency key is `wf:<runId>:<stepKey>`, and each
 * outgoing message has the same key in the messages table (UNIQUE). So a step can
 * never be scheduled twice or sent twice, even if a job is retried or replayed.
 *
 * Right before sending, the handler reloads the latest state and stops the run if the
 * lead replied, booked an appointment, the deal closed, the contact opted out, or the
 * run was cancelled — the stop reason is saved on the run, the job and the audit log.
 */
import { and, asc, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { uniqueViolation } from "@/db/errors";
import { appointments, contacts, messages, opportunities, workflowRuns, workflowSteps } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { decideFollowUp, renderTemplate } from "@/lib/followup-rules";
import { PermanentJobError } from "@/lib/job-errors";
import { fullName } from "@/lib/normalize";
import { SERVICE_LABEL, type Service } from "@/lib/pipeline";
import { getMessagingProvider } from "@/server/integrations/messaging";
import { cancelPendingJobsForRun, enqueueJob, type Job } from "@/server/queue/queue";
import { writeAudit } from "@/server/services/audit";
import { recalculateScore } from "@/server/services/lead-intelligence";
import type { Actor, DbOrTx } from "@/server/services/types";

export const NURTURE = "new_lead_nurture";
export const FOLLOWUP_JOB = "workflow.send_followup";

export function defaultSteps(firstDelaySeconds: number) {
  return [
    { stepKey: "followup_1", position: 1, delaySeconds: firstDelaySeconds, subject: "Thanks for your enquiry, {{firstName}}", bodyTemplate: "Hi {{firstName}}, thanks for asking about {{service}}. Would a quick 20-minute call this week help? — {{ownerName}}" },
    { stepKey: "followup_2", position: 2, delaySeconds: 86_400, subject: "Quick follow-up", bodyTemplate: "Hi {{firstName}}, just checking you saw my note about {{service}}. Happy to share examples of similar projects. — {{ownerName}}" },
    { stepKey: "followup_3", position: 3, delaySeconds: 259_200, subject: "Should I close your enquiry?", bodyTemplate: "Hi {{firstName}}, I haven't heard back so I'll close this for now. Reply any time if {{service}} is still on your list. — {{ownerName}}" },
  ];
}

/** Creates the default sequence if it doesn't exist (never overwrites edits). */
export async function ensureDefaultSteps(db: DbOrTx): Promise<void> {
  const steps = defaultSteps(getEnv().FOLLOWUP_1_DELAY_SECONDS).map((s) => ({ ...s, workflowKey: NURTURE, channel: "email" as const }));
  await db.insert(workflowSteps).values(steps).onConflictDoNothing();
}

async function activeSteps(db: DbOrTx, workflowKey: string) {
  return db.select().from(workflowSteps).where(and(eq(workflowSteps.workflowKey, workflowKey), eq(workflowSteps.isActive, true))).orderBy(asc(workflowSteps.position));
}

// ── Start ────────────────────────────────────────────────────────────────────
export type StartResult =
  | { status: "started"; runId: string; jobId: string; firstRunAt: Date }
  | { status: "existing"; runId: string; reason: string }
  | { status: "skipped"; reason: string };

export async function startNurtureWorkflow(db: Database, actor: Actor, contactId: string, trigger: string): Promise<StartResult> {
  await ensureDefaultSteps(db);
  try {
    return await db.transaction(async (tx) => {
      const [c] = await tx.select().from(contacts).where(eq(contacts.id, contactId)).for("update"); // serializes concurrent starts
      if (!c) return { status: "skipped" as const, reason: "Contact not found" };
      if (c.optedOutAt) return { status: "skipped" as const, reason: "Contact opted out" };

      // Idempotency: one nurture run per contact, ever. A repeat submission reuses it.
      const [prior] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.contactId, contactId), eq(workflowRuns.workflowKey, NURTURE))).orderBy(desc(workflowRuns.startedAt)).limit(1);
      if (prior) return { status: "existing" as const, runId: prior.id, reason: `Already has a nurture run (${prior.status})` };

      const [opp] = await tx.select().from(opportunities).where(and(eq(opportunities.contactId, contactId), eq(opportunities.status, "open"))).orderBy(desc(opportunities.createdAt)).limit(1);
      if (!opp) return { status: "skipped" as const, reason: "No open opportunity to nurture" };

      const [first] = await activeSteps(tx, NURTURE);
      if (!first) return { status: "skipped" as const, reason: "Nurture sequence has no active steps" };

      const [run] = await tx
        .insert(workflowRuns)
        .values({ workflowKey: NURTURE, contactId, opportunityId: opp.id, status: "running", currentStep: `waiting:${first.stepKey}` })
        .returning({ id: workflowRuns.id, startedAt: workflowRuns.startedAt });
      const runAt = new Date(Date.now() + first.delaySeconds * 1000);
      const { jobId } = await enqueueJob(tx, {
        type: FOLLOWUP_JOB,
        idempotencyKey: `wf:${run.id}:${first.stepKey}`,
        runAt,
        payload: { workflowRunId: run.id, step: first.stepKey },
        contactId,
        opportunityId: opp.id,
        workflowRunId: run.id,
      });
      await tx.update(contacts).set({ nextFollowUpAt: runAt }).where(eq(contacts.id, contactId));
      await writeAudit(tx, actor, {
        eventType: "workflow.triggered",
        entityType: "workflow_run",
        entityId: run.id,
        contactId,
        message: `Workflow “New lead nurture” started (${trigger}); ${first.stepKey.replace("_", " ")} scheduled for ${runAt.toISOString()}`,
        metadata: { trigger, jobId, runAt },
      });
      return { status: "started" as const, runId: run.id, jobId, firstRunAt: runAt };
    });
  } catch (err) {
    // The partial unique index (one RUNNING run per workflow+contact) is the last line of defence.
    if (uniqueViolation(err) === "workflow_runs_one_active_uq") {
      const [r] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.contactId, contactId), eq(workflowRuns.workflowKey, NURTURE)));
      return { status: "existing", runId: r.id, reason: "Started concurrently by another request" };
    }
    throw err;
  }
}

// ── Follow-up handler (called by the worker) ────────────────────────────────
export type HandlerResult = { outcome: "completed"; note?: string } | { outcome: "skipped"; reason: string };

export async function handleFollowUp(db: Database, job: Job, workerId: string): Promise<HandlerResult> {
  const actor: Actor = { type: "worker", label: workerId };
  const { workflowRunId, step } = job.payload as { workflowRunId?: string; step?: string };
  if (!workflowRunId || !step) throw new PermanentJobError("Job payload is missing workflowRunId or step");

  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, workflowRunId));
  if (!run) throw new PermanentJobError(`Workflow run ${workflowRunId} no longer exists`);
  const [c] = await db.select().from(contacts).where(eq(contacts.id, run.contactId));
  if (!c) throw new PermanentJobError("Contact no longer exists");
  const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.workflowKey, run.workflowKey)).orderBy(asc(workflowSteps.position));
  const cfg = steps.find((s) => s.stepKey === step);

  // ── Latest state, loaded right before acting ──
  const openOpps = await db.select().from(opportunities).where(and(eq(opportunities.contactId, c.id), eq(opportunities.status, "open")));
  const [closed] = openOpps.length
    ? [undefined]
    : await db.select().from(opportunities).where(and(eq(opportunities.contactId, c.id), ne(opportunities.status, "open"))).orderBy(desc(opportunities.updatedAt)).limit(1);
  const [reply] = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.contactId, c.id), eq(messages.direction, "inbound"), gte(messages.createdAt, run.startedAt))).limit(1);
  const [appt] = await db.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.contactId, c.id), inArray(appointments.status, ["scheduled", "confirmed", "completed"]))).limit(1);
  const stageBooked = openOpps.some((o) => ["appointment_booked", "proposal_sent", "negotiation"].includes(o.stage));

  const decision = decideFollowUp({
    workflowStatus: run.status,
    optedOut: Boolean(c.optedOutAt),
    hasOpenOpportunity: openOpps.length > 0,
    closedAs: closed ? (closed.status as "won" | "lost") : null,
    repliedSinceStart: Boolean(reply),
    appointmentBooked: Boolean(appt) || stageBooked,
    hasAddress: Boolean(c.email),
  });

  if (decision.action === "stop") {
    await db.transaction(async (tx) => {
      if (run.status === "running") {
        await tx.update(workflowRuns).set({ status: "stopped", stopReason: decision.reason, currentStep: null, finishedAt: sql`now()` }).where(eq(workflowRuns.id, run.id));
      }
      await cancelPendingJobsForRun(tx, run.id, `Workflow stopped: ${decision.message}`, job.id);
      await tx.update(contacts).set({ nextFollowUpAt: null }).where(eq(contacts.id, c.id));
      await writeAudit(tx, actor, {
        eventType: "followup.skipped",
        entityType: "workflow_run",
        entityId: run.id,
        contactId: c.id,
        message: `${step.replace("_", " ")} skipped — ${decision.message}. Workflow stopped.`,
        metadata: { reason: decision.reason, jobId: job.id },
      });
    });
    return { outcome: "skipped", reason: decision.message };
  }

  if (!cfg || !cfg.isActive) return { outcome: "skipped", reason: `Step ${step} is disabled or no longer configured` };
  if (!c.email) throw new PermanentJobError("Contact has no email address — cannot send an email follow-up");

  // ── Send (idempotent) ──
  const idempotencyKey = `wf:${run.id}:${step}`;
  const [owner] = c.ownerId ? await db.execute<{ name: string }>(sql`select name from users where id = ${c.ownerId}`) : [];
  const vars = {
    firstName: c.firstName,
    service: c.serviceInterest ? SERVICE_LABEL[c.serviceInterest as Service] ?? c.serviceInterest : "your project",
    ownerName: owner?.name ?? "The LeadFlow team",
  };
  const subject = renderTemplate(cfg.subject, vars);
  const body = renderTemplate(cfg.bodyTemplate, vars);

  const [existing] = await db.select().from(messages).where(eq(messages.idempotencyKey, idempotencyKey));
  let note = "";
  if (existing?.status === "sent") {
    // A previous attempt already delivered it (e.g. crashed after sending). Do NOT send again.
    note = "Message was already sent by an earlier attempt — not sent again";
  } else {
    if (!existing) {
      await db
        .insert(messages)
        .values({ contactId: c.id, workflowRunId: run.id, channel: cfg.channel, direction: "outbound", templateKey: `nurture.${step}`, toAddress: c.email, subject, body, status: "queued", provider: "mock", idempotencyKey })
        .onConflictDoNothing({ target: messages.idempotencyKey });
    }
    const provider = getMessagingProvider(db);
    try {
      const res = await provider.send({ idempotencyKey, channel: cfg.channel, to: c.email, subject, body });
      await db
        .update(messages)
        .set({ status: "sent", provider: res.provider, providerMessageId: res.providerMessageId, error: null, attemptedAt: sql`now()` })
        .where(eq(messages.idempotencyKey, idempotencyKey));
      note = res.simulated ? `[SIMULATED] Email sent via ${res.provider} provider (${res.providerMessageId})` : `Sent (${res.providerMessageId})`;
    } catch (err) {
      await db
        .update(messages)
        .set({ status: "failed", error: err instanceof Error ? err.message : String(err), attemptedAt: sql`now()` })
        .where(eq(messages.idempotencyKey, idempotencyKey));
      throw err; // the queue classifies it and schedules a retry or fails the job
    }
  }

  // ── Advance the workflow ──
  const next = steps.filter((s) => s.isActive && s.position > (cfg.position ?? 0))[0];
  await db.transaction(async (tx) => {
    await tx.update(contacts).set({ lastContactedAt: sql`now()` }).where(eq(contacts.id, c.id));
    await writeAudit(tx, actor, {
      eventType: "message.sent",
      entityType: "message",
      entityId: run.id,
      contactId: c.id,
      message: `${note}: “${subject}”`,
      metadata: { step, jobId: job.id, simulated: true },
    });
    if (next) {
      const runAt = new Date(Date.now() + next.delaySeconds * 1000);
      await enqueueJob(tx, {
        type: FOLLOWUP_JOB,
        idempotencyKey: `wf:${run.id}:${next.stepKey}`,
        runAt,
        payload: { workflowRunId: run.id, step: next.stepKey },
        contactId: c.id,
        opportunityId: run.opportunityId,
        workflowRunId: run.id,
      });
      await tx.update(workflowRuns).set({ currentStep: `waiting:${next.stepKey}` }).where(eq(workflowRuns.id, run.id));
      await tx.update(contacts).set({ nextFollowUpAt: runAt }).where(eq(contacts.id, c.id));
      await writeAudit(tx, actor, {
        eventType: "followup.scheduled",
        entityType: "workflow_run",
        entityId: run.id,
        contactId: c.id,
        message: `${next.stepKey.replace("_", " ")} scheduled for ${runAt.toISOString()}`,
      });
    } else {
      await tx.update(workflowRuns).set({ status: "completed", currentStep: null, stopReason: "sequence_finished", finishedAt: sql`now()` }).where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.status, "running")));
      await tx.update(contacts).set({ nextFollowUpAt: null }).where(eq(contacts.id, c.id));
    }
  });
  // More contact attempts change the response factor of the score.
  await recalculateScore(db, actor, c.id, "followup.sent");
  return { outcome: "completed", note };
}

// ── Manual controls ──────────────────────────────────────────────────────────
export async function cancelWorkflowRun(db: Database, actor: Actor, runId: string, reason: string) {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).for("update");
    if (!run) return { status: "not_found" as const };
    if (run.status !== "running") return { status: "not_allowed" as const, error: `Workflow is already ${run.status}` };
    await tx.update(workflowRuns).set({ status: "cancelled", stopReason: reason, currentStep: null, finishedAt: sql`now()` }).where(eq(workflowRuns.id, runId));
    const n = await cancelPendingJobsForRun(tx, runId, `Workflow cancelled: ${reason}`);
    await tx.update(contacts).set({ nextFollowUpAt: null }).where(eq(contacts.id, run.contactId));
    await writeAudit(tx, actor, { eventType: "workflow.cancelled", entityType: "workflow_run", entityId: runId, contactId: run.contactId, message: `Workflow cancelled manually: ${reason} (${n} pending job(s) cancelled)` });
    return { status: "ok" as const, cancelledJobs: n };
  });
}

export async function setOptOut(db: Database, actor: Actor, contactId: string, optedOut: boolean) {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(contacts).where(eq(contacts.id, contactId)).for("update");
    if (!c) return { status: "not_found" as const };
    await tx.update(contacts).set({ optedOutAt: optedOut ? sql`now()` : null }).where(eq(contacts.id, contactId));
    await writeAudit(tx, actor, {
      eventType: optedOut ? "contact.opted_out" : "contact.opted_in",
      entityType: "contact",
      entityId: contactId,
      contactId,
      message: optedOut ? `${fullName(c.firstName, c.lastName)} opted out — pending follow-ups will be skipped` : `${fullName(c.firstName, c.lastName)} opted back in`,
    });
    return { status: "ok" as const };
  });
}

export async function updateStepDelay(db: Database, actor: Actor, stepId: string, delaySeconds: number) {
  if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 30 * 86_400) {
    return { status: "invalid" as const, error: "Delay must be a whole number of seconds between 0 and 30 days" };
  }
  const [s] = await db.update(workflowSteps).set({ delaySeconds }).where(eq(workflowSteps.id, stepId)).returning();
  if (!s) return { status: "not_found" as const };
  await writeAudit(db, actor, { eventType: "workflow_step.updated", entityType: "workflow_step", entityId: stepId, message: `${s.stepKey} delay set to ${delaySeconds}s (applies to steps scheduled from now on)` });
  return { status: "ok" as const };
}

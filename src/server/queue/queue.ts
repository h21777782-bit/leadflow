/**
 * PERSISTENT JOB QUEUE (PostgreSQL).
 *
 * Lifecycle:
 *   pending ──claim──► processing ──ok──► completed | skipped
 *                         │
 *                         ├─transient error, attempts left──► retry_scheduled ──(run_at)──► claimed again
 *                         ├─permanent error / attempts used up──► failed ──Retry now──► pending
 *                         └─worker died (lease expired)──► recovered to retry_scheduled (or failed)
 *   pending / retry_scheduled ──Cancel──► cancelled
 *
 * Guarantees:
 *  - A job exists at most once per idempotency_key (UNIQUE index + ON CONFLICT DO NOTHING).
 *  - Claiming is one atomic UPDATE over a `FOR UPDATE SKIP LOCKED` sub-select, so two
 *    workers can never claim the same row; they simply skip each other's locked rows.
 *  - Finishing a job requires still holding the lease (locked_by = me AND status = processing),
 *    so a worker whose lease was recovered cannot overwrite the newer outcome.
 *  - Every attempt is recorded in job_attempts (full history).
 */
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { jobAttempts, jobs, workflowRuns } from "@/db/schema";
import { backoffDelayMs } from "@/lib/backoff";
import { getEnv } from "@/lib/env";
import { classifyError } from "@/lib/job-errors";
import { writeAudit } from "@/server/services/audit";
import type { Actor, DbOrTx } from "@/server/services/types";

export type Job = typeof jobs.$inferSelect;
const WORKER_ACTOR = (workerId: string): Actor => ({ type: "worker", label: workerId });

// ── Enqueue ──────────────────────────────────────────────────────────────────
export type EnqueueInput = {
  type: string;
  idempotencyKey: string;
  runAt: Date;
  payload?: Record<string, unknown>;
  contactId?: string | null;
  opportunityId?: string | null;
  workflowRunId?: string | null;
  appointmentId?: string | null;
  maxAttempts?: number;
};

/** Idempotent: enqueueing the same key twice returns the existing job instead of creating a second one. */
export async function enqueueJob(db: DbOrTx, input: EnqueueInput): Promise<{ jobId: string; created: boolean }> {
  const [row] = await db
    .insert(jobs)
    .values({
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      runAt: input.runAt,
      payload: input.payload ?? {},
      contactId: input.contactId ?? null,
      opportunityId: input.opportunityId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      appointmentId: input.appointmentId ?? null,
      maxAttempts: input.maxAttempts ?? getEnv().JOB_MAX_ATTEMPTS,
      status: "pending",
    })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning({ id: jobs.id });
  if (row) return { jobId: row.id, created: true };
  const [existing] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.idempotencyKey, input.idempotencyKey));
  return { jobId: existing.id, created: false };
}

// ── Claim ────────────────────────────────────────────────────────────────────
export async function claimDueJobs(db: Database, workerId: string, limit: number, now = new Date()): Promise<Job[]> {
  const leaseSeconds = getEnv().JOB_LEASE_SECONDS;
  const due = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(inArray(jobs.status, ["pending", "retry_scheduled"]), lte(jobs.runAt, now)))
    .orderBy(asc(jobs.runAt))
    .limit(limit)
    .for("update", { skipLocked: true });

  return db
    .update(jobs)
    .set({
      status: "processing",
      lockedBy: workerId,
      lockedAt: sql`now()`,
      leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
      attempts: sql`${jobs.attempts} + 1`, // counted at claim time, so a crash still uses up an attempt
      updatedAt: sql`now()`,
    })
    .where(inArray(jobs.id, due))
    .returning();
}

// ── Finish ───────────────────────────────────────────────────────────────────
type FinishOk = { outcome: "completed" | "skipped"; reason?: string };

export async function completeJob(db: Database, job: Job, workerId: string, result: FinishOk, startedAt: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(jobs)
      .set({
        status: result.outcome,
        statusReason: result.reason ?? null,
        completedAt: sql`now()`,
        lockedBy: null,
        leaseExpiresAt: null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, workerId), eq(jobs.status, "processing")))
      .returning({ id: jobs.id });
    if (updated.length === 0) return false; // lease lost — someone else owns the outcome now
    await tx.insert(jobAttempts).values({
      jobId: job.id,
      attempt: job.attempts,
      workerId,
      outcome: result.outcome,
      error: result.reason ?? null,
      durationMs: Date.now() - startedAt.getTime(),
      startedAt,
    });
    return true;
  });
}

export type FailOutcome = { status: "retry_scheduled"; nextRunAt: Date; kind: string } | { status: "failed"; kind: string } | { status: "lease_lost" };

export async function failJob(
  db: Database,
  job: Job,
  workerId: string,
  err: unknown,
  startedAt: Date,
  random: () => number = Math.random,
): Promise<FailOutcome> {
  const env = getEnv();
  const c = classifyError(err);
  const exhausted = job.attempts >= job.maxAttempts;
  const final = c.kind === "permanent" || exhausted;
  const delay = c.retryAfterMs ?? backoffDelayMs(job.attempts, { baseSeconds: env.RETRY_BASE_DELAY_SECONDS, maxSeconds: env.RETRY_MAX_DELAY_SECONDS }, random);
  const nextRunAt = new Date(Date.now() + delay);
  const reason = final
    ? c.kind === "permanent"
      ? "Permanent error — not retried"
      : `Gave up after ${job.attempts} of ${job.maxAttempts} attempts`
    : null;

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(jobs)
      .set({
        status: final ? "failed" : "retry_scheduled",
        runAt: final ? job.runAt : nextRunAt,
        lastError: c.message,
        errorKind: c.kind,
        statusReason: reason,
        lockedBy: null,
        leaseExpiresAt: null,
        updatedAt: sql`now()`,
        completedAt: final ? sql`now()` : null,
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, workerId), eq(jobs.status, "processing")))
      .returning({ id: jobs.id });
    if (updated.length === 0) return { status: "lease_lost" as const };

    await tx.insert(jobAttempts).values({
      jobId: job.id,
      attempt: job.attempts,
      workerId,
      outcome: c.kind === "permanent" ? "permanent_error" : "transient_error",
      error: c.message,
      durationMs: Date.now() - startedAt.getTime(),
      nextRunAt: final ? null : nextRunAt,
      startedAt,
    });
    await writeAudit(tx, WORKER_ACTOR(workerId), {
      eventType: final ? "job.failed" : "job.retry_scheduled",
      entityType: "job",
      entityId: job.id,
      contactId: job.contactId,
      message: final
        ? `${job.type} failed (${reason}): ${c.message}`
        : `${job.type} attempt ${job.attempts}/${job.maxAttempts} failed (${c.kind}): ${c.message}. Retry at ${nextRunAt.toISOString()}`,
      metadata: { attempt: job.attempts, kind: c.kind, nextRunAt: final ? null : nextRunAt },
    });
    if (final && job.workflowRunId) {
      await tx
        .update(workflowRuns)
        .set({ status: "failed", stopReason: `Step ${job.type} failed: ${c.message}`, finishedAt: sql`now()` })
        .where(and(eq(workflowRuns.id, job.workflowRunId), eq(workflowRuns.status, "running")));
    }
    return final ? { status: "failed" as const, kind: c.kind } : { status: "retry_scheduled" as const, nextRunAt, kind: c.kind };
  });
}

// ── Crash recovery ───────────────────────────────────────────────────────────
/**
 * A job stuck in `processing` past its lease means the worker died or hung.
 * Put it back in the queue (or fail it if attempts are used up), with history.
 */
export async function recoverAbandonedJobs(db: Database, recoveredBy: string): Promise<number> {
  return db.transaction(async (tx) => {
    const stale = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "processing"), sql`${jobs.leaseExpiresAt} < now()`))
      .for("update", { skipLocked: true });
    for (const j of stale) {
      const exhausted = j.attempts >= j.maxAttempts;
      const msg = `Lease expired: worker ${j.lockedBy ?? "unknown"} stopped responding (crash or hang)`;
      await tx
        .update(jobs)
        .set({
          status: exhausted ? "failed" : "retry_scheduled",
          runAt: sql`now()`,
          lastError: msg,
          errorKind: "transient",
          statusReason: exhausted ? `Gave up after ${j.attempts} of ${j.maxAttempts} attempts` : "Recovered after worker crash",
          lockedBy: null,
          leaseExpiresAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(jobs.id, j.id));
      await tx.insert(jobAttempts).values({
        jobId: j.id,
        attempt: j.attempts,
        workerId: j.lockedBy,
        outcome: "abandoned",
        error: msg,
        startedAt: j.lockedAt ?? new Date(),
        nextRunAt: exhausted ? null : new Date(),
      });
      await writeAudit(tx, WORKER_ACTOR(recoveredBy), {
        eventType: "job.recovered",
        entityType: "job",
        entityId: j.id,
        contactId: j.contactId,
        message: `${j.type} recovered from abandoned processing (${msg})${exhausted ? " — no attempts left, marked failed" : " — requeued"}`,
      });
    }
    return stale.length;
  });
}

// ── Manual actions ───────────────────────────────────────────────────────────
export type ManualResult = { status: "ok"; message: string } | { status: "not_found" } | { status: "not_allowed"; error: string };

export async function retryJobNow(db: Database, actor: Actor, jobId: string, supportedTypes: string[]): Promise<ManualResult> {
  return db.transaction(async (tx) => {
    const [j] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
    if (!j) return { status: "not_found" as const };
    if (j.status !== "failed" && j.status !== "retry_scheduled") {
      return { status: "not_allowed" as const, error: `Only failed or retry-scheduled jobs can be retried (this one is ${j.status})` };
    }
    if (!supportedTypes.includes(j.type)) {
      return { status: "not_allowed" as const, error: `No worker handler exists for “${j.type}” yet, so retrying cannot succeed` };
    }
    await tx
      .update(jobs)
      .set({
        status: "pending",
        runAt: sql`now()`,
        // A failed job has used its attempts; a manual retry grants exactly one more.
        maxAttempts: sql`greatest(${jobs.maxAttempts}, ${jobs.attempts} + 1)`,
        statusReason: "Manual retry requested",
        completedAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(jobs.id, jobId));
    if (j.workflowRunId) {
      await tx
        .update(workflowRuns)
        .set({ status: "running", stopReason: null, finishedAt: null })
        .where(and(eq(workflowRuns.id, j.workflowRunId), eq(workflowRuns.status, "failed")));
    }
    await writeAudit(tx, actor, {
      eventType: "job.manual_retry",
      entityType: "job",
      entityId: jobId,
      contactId: j.contactId,
      message: `Manual retry of ${j.type} requested (was ${j.status} after ${j.attempts} attempt(s); last error: ${j.lastError ?? "none"})`,
    });
    return { status: "ok" as const, message: "Queued — the worker will pick it up on its next poll" };
  });
}

export async function cancelJob(db: Database, actor: Actor, jobId: string, reason: string): Promise<ManualResult> {
  return db.transaction(async (tx) => {
    const [j] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
    if (!j) return { status: "not_found" as const };
    if (j.status !== "pending" && j.status !== "retry_scheduled") {
      return { status: "not_allowed" as const, error: `Only pending or retry-scheduled jobs can be cancelled (this one is ${j.status})` };
    }
    await tx.update(jobs).set({ status: "cancelled", statusReason: reason, completedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(jobs.id, jobId));
    await writeAudit(tx, actor, {
      eventType: "job.cancelled",
      entityType: "job",
      entityId: jobId,
      contactId: j.contactId,
      message: `${j.type} cancelled: ${reason}`,
    });
    return { status: "ok" as const, message: "Job cancelled" };
  });
}

/** Cancel every not-yet-run job of a workflow run (used when a run stops or is cancelled). */
export async function cancelPendingJobsForRun(tx: DbOrTx, workflowRunId: string, reason: string, exceptJobId?: string): Promise<number> {
  const rows = await tx
    .update(jobs)
    .set({ status: "cancelled", statusReason: reason, completedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(jobs.workflowRunId, workflowRunId),
        inArray(jobs.status, ["pending", "retry_scheduled"]),
        exceptJobId ? sql`${jobs.id} <> ${exceptJobId}` : undefined,
      ),
    )
    .returning({ id: jobs.id });
  return rows.length;
}

/** Cancel every not-yet-run job for an appointment (Phase 7: its 24h/1h reminders) — used on cancel/reschedule. */
export async function cancelPendingJobsForAppointment(tx: DbOrTx, appointmentId: string, reason: string): Promise<number> {
  const rows = await tx
    .update(jobs)
    .set({ status: "cancelled", statusReason: reason, completedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(jobs.appointmentId, appointmentId), inArray(jobs.status, ["pending", "retry_scheduled"])))
    .returning({ id: jobs.id });
  return rows.length;
}

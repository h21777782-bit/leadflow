/**
 * WORKER RUNTIME — shared by `npm run worker` (long-running) and tests/demos (runOnce).
 *
 * Loop: heartbeat → recover abandoned jobs → claim due jobs (SKIP LOCKED) →
 *       run each handler → complete / fail with backoff → sleep → repeat.
 * One bad job never stops the loop: every error is caught and recorded on that job.
 */
import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { workerHeartbeats } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { PermanentJobError } from "@/lib/job-errors";
import { claimDueJobs, completeJob, failJob, recoverAbandonedJobs, type Job } from "@/server/queue/queue";
import { CRM_SYNC_CONTACT, CRM_SYNC_OPPORTUNITY, CRM_UPDATE_OPPORTUNITY, handleSyncContact, handleSyncOpportunity, handleUpdateOpportunity } from "@/server/workflows/crm-sync";
import { FOLLOWUP_JOB, handleFollowUp, type HandlerResult } from "@/server/workflows/nurture";
import { handleProcessWebhook, WEBHOOK_PROCESS_JOB } from "@/server/workflows/webhook-process";

type Handler = (db: Database, job: Job, workerId: string) => Promise<HandlerResult>;

/** Job types this worker can execute. Anything else fails permanently with a clear message. */
export const HANDLERS: Record<string, Handler> = {
  [FOLLOWUP_JOB]: handleFollowUp,
  [CRM_SYNC_CONTACT]: handleSyncContact,
  [CRM_SYNC_OPPORTUNITY]: handleSyncOpportunity,
  [CRM_UPDATE_OPPORTUNITY]: handleUpdateOpportunity,
  [WEBHOOK_PROCESS_JOB]: handleProcessWebhook,
};
export const SUPPORTED_JOB_TYPES = Object.keys(HANDLERS);

export type ProcessOutcome = "completed" | "skipped" | "retry_scheduled" | "failed" | "lease_lost" | "error";
export type Logger = (msg: string) => void;

export async function processJob(db: Database, job: Job, workerId: string, log: Logger = () => {}): Promise<ProcessOutcome> {
  const startedAt = new Date();
  try {
    const handler = HANDLERS[job.type];
    if (!handler) throw new PermanentJobError(`No handler for job type “${job.type}” in this version of the worker`);
    const r = await handler(db, job, workerId);
    const ok = await completeJob(db, job, workerId, r.outcome === "completed" ? { outcome: "completed", reason: r.note } : { outcome: "skipped", reason: r.reason }, startedAt);
    log(`${ok ? "✔" : "⚠"} ${job.type} ${job.id.slice(0, 8)} attempt ${job.attempts}: ${r.outcome}${r.outcome === "skipped" ? ` (${r.reason})` : ""}${ok ? "" : " — lease lost, result discarded"}`);
    return ok ? r.outcome : "lease_lost";
  } catch (err) {
    try {
      const f = await failJob(db, job, workerId, err, startedAt);
      const msg = err instanceof Error ? err.message : String(err);
      log(`✖ ${job.type} ${job.id.slice(0, 8)} attempt ${job.attempts}/${job.maxAttempts}: ${msg} → ${f.status}${f.status === "retry_scheduled" ? ` at ${f.nextRunAt.toISOString()}` : ""}`);
      return f.status;
    } catch (inner) {
      // Even recording the failure failed (e.g. DB down). The lease will expire and recovery requeues it.
      log(`‼ could not record failure for job ${job.id}: ${inner instanceof Error ? inner.message : String(inner)}`);
      return "error";
    }
  }
}

export async function runOnce(db: Database, workerId: string, log: Logger = () => {}) {
  const env = getEnv();
  const recovered = await recoverAbandonedJobs(db, workerId);
  if (recovered) log(`↺ recovered ${recovered} abandoned job(s)`);
  const claimed = await claimDueJobs(db, workerId, env.WORKER_BATCH_SIZE);
  const outcomes: ProcessOutcome[] = [];
  for (const job of claimed) outcomes.push(await processJob(db, job, workerId, log));
  return { recovered, claimed: claimed.length, outcomes };
}

async function heartbeat(db: Database, workerId: string, status: string, startedAt: Date, done: { ok: number; failed: number }) {
  await db
    .insert(workerHeartbeats)
    .values({ workerId, hostname: hostname(), status, startedAt, lastSeenAt: new Date(), jobsCompleted: done.ok, jobsFailed: done.failed })
    .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { status, lastSeenAt: sql`now()`, jobsCompleted: done.ok, jobsFailed: done.failed } });
}

/** Long-running loop. Stops cleanly when `signal` aborts: finishes the current batch, then exits. */
export async function runWorker(db: Database, opts: { workerId: string; signal: AbortSignal; log?: Logger }) {
  const env = getEnv();
  const log = opts.log ?? console.log;
  const startedAt = new Date();
  const done = { ok: 0, failed: 0 };
  log(`worker ${opts.workerId} started (poll ${env.WORKER_POLL_MS}ms, batch ${env.WORKER_BATCH_SIZE}, lease ${env.JOB_LEASE_SECONDS}s, mock=${env.MOCK_MODE})`);
  while (!opts.signal.aborted) {
    try {
      await heartbeat(db, opts.workerId, "running", startedAt, done);
      const r = await runOnce(db, opts.workerId, log);
      for (const o of r.outcomes) {
        if (o === "completed" || o === "skipped") done.ok++;
        else if (o === "failed") done.failed++;
      }
      if (r.claimed > 0) continue; // more work may be waiting — don't sleep
    } catch (err) {
      log(`‼ worker loop error (will retry): ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(env.WORKER_POLL_MS, opts.signal);
  }
  try {
    await heartbeat(db, opts.workerId, "stopped", startedAt, done);
  } catch {
    /* DB may be gone during shutdown */
  }
  log(`worker ${opts.workerId} stopped cleanly (${done.ok} done, ${done.failed} failed)`);
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

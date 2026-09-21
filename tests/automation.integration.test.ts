/**
 * Phase 4 integration tests against real Postgres (TEST_DATABASE_URL).
 * Covers the job queue, the worker runtime and the nurture workflow end to end —
 * the guarantees the UI and the demo scripts depend on. Fictional leads only.
 */
import { hasTestDb } from "./helpers/test-db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, getDb } from "@/db/client";
import { appointments, contacts, jobAttempts, jobs, messages, opportunities, workerHeartbeats, workflowRuns } from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { backoffWindowMs } from "@/lib/backoff";
import { FAILURE_SWITCH_KEY } from "@/server/integrations/messaging/mock-provider";
import { claimDueJobs, cancelJob, completeJob, enqueueJob, failJob, recoverAbandonedJobs, retryJobNow } from "@/server/queue/queue";
import { setSetting } from "@/server/services/app-settings";
import { changeStage } from "@/server/services/opportunities";
import { logInboundReply } from "@/server/services/lead-intelligence";
import { createContact } from "@/server/services/contacts";
import type { Actor } from "@/server/services/types";
import { ingestLeadEvent } from "@/server/services/intake";
import { HANDLERS, processJob, runOnce, SUPPORTED_JOB_TYPES } from "@/server/worker/runner";
import { runWorker } from "@/server/worker/runner";
import { cancelWorkflowRun, defaultSteps, FOLLOWUP_JOB, handleFollowUp, setOptOut, startNurtureWorkflow } from "@/server/workflows/nurture";

const actor: Actor = { type: "user", userId: null, label: "test-runner" };
const db = () => getDb();
let seq = 0;
function uniq() {
  seq += 1;
  return `${Date.now()}-${seq}`;
}

async function makeLead(prefix: string) {
  const tag = `phase-4-test`;
  const r = await createContact(db(), actor, {
    firstName: prefix,
    lastName: "Test",
    email: `${prefix.toLowerCase()}-${uniq()}@automation.example`,
    leadSource: "website_form",
    tags: tag,
  });
  if (r.status !== "created") throw new Error(`makeLead(${prefix}) failed: ${JSON.stringify(r)}`);
  const workflow = r.workflow;
  if (!workflow || workflow.status !== "started") throw new Error(`makeLead(${prefix}) did not start a workflow: ${JSON.stringify(workflow)}`);
  return { contactId: r.contactId, opportunityId: r.opportunityId!, runId: workflow.runId, jobId: workflow.jobId, firstRunAt: workflow.firstRunAt };
}

async function getJobRow(jobId: string) {
  const [j] = await db().select().from(jobs).where(eq(jobs.id, jobId));
  return j;
}

/** Makes a job claimable right now without waiting for its real delay. */
async function forceDue(jobId: string) {
  await db().update(jobs).set({ runAt: sql`now() - interval '1 second'` }).where(eq(jobs.id, jobId));
}

async function claimAndProcessOne(jobId: string, workerId = "test-worker") {
  await forceDue(jobId);
  const claimed = await claimDueJobs(db(), workerId, 10);
  const job = claimed.find((j) => j.id === jobId);
  if (!job) throw new Error(`job ${jobId} was not claimed (status may not be pending/retry_scheduled)`);
  const outcome = await processJob(db(), job, workerId);
  return outcome;
}

async function setFailureMode(mode: "off" | "transient" | "permanent") {
  await setSetting(db(), FAILURE_SWITCH_KEY, mode);
}

describe.skipIf(!hasTestDb)("automation engine (integration)", () => {
  beforeAll(async () => {
    await migrate(db(), { migrationsFolder: "./drizzle" });
    await seedDatabase(db());
  });
  beforeEach(setFailureMode.bind(null, "off"));
  afterAll(async () => {
    await closeDb();
  });

  // ── Workflow start ───────────────────────────────────────────────────────
  it("starts the nurture workflow with the first follow-up scheduled at the configured delay", async () => {
    const before = Date.now();
    const lead = await makeLead("Astrid");
    const job = await getJobRow(lead.jobId);
    expect(job.type).toBe(FOLLOWUP_JOB);
    expect(job.status).toBe("pending");
    const [step1] = defaultSteps(30);
    const expectedMs = step1.delaySeconds * 1000;
    const actualMs = job.runAt.getTime() - before;
    expect(actualMs).toBeGreaterThan(expectedMs - 3000);
    expect(actualMs).toBeLessThan(expectedMs + 5000);
    const [run] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, lead.runId));
    expect(run.status).toBe("running");
    expect(run.currentStep).toBe("waiting:followup_1");
  });

  it("same lead event delivered twice, and 5 times concurrently, creates exactly one contact/opportunity/run/job", async () => {
    const eventId = `evt-${uniq()}`;
    const lead = { firstName: "Concurrent", lastName: "Event", email: `concurrent-${uniq()}@automation.example`, leadSource: "website_form" };
    const first = await ingestLeadEvent(db(), actor, { source: "website", eventId, lead });
    expect(first.status).toBe("processed");
    const second = await ingestLeadEvent(db(), actor, { source: "website", eventId, lead });
    expect(second.status).toBe("duplicate_event");

    const eventId2 = `evt-${uniq()}`;
    const lead2 = { firstName: "Race", lastName: "Event", email: `race-event-${uniq()}@automation.example`, leadSource: "website_form" };
    const results = await Promise.all(Array.from({ length: 5 }, () => ingestLeadEvent(db(), actor, { source: "website", eventId: eventId2, lead: lead2 })));
    expect(results.filter((r) => r.status === "processed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate_event")).toHaveLength(4);
    const processed = results.find((r) => r.status === "processed")!;
    if (processed.status !== "processed") throw new Error("unreachable");
    const [{ n: contactCount }] = await db().select({ n: sql<number>`count(*)::int` }).from(contacts).where(eq(contacts.id, processed.contactId));
    expect(contactCount).toBe(1);
    const [{ n: oppCount }] = await db().select({ n: sql<number>`count(*)::int` }).from(opportunities).where(eq(opportunities.contactId, processed.contactId));
    expect(oppCount).toBe(1);
    const [{ n: runCount }] = await db().select({ n: sql<number>`count(*)::int` }).from(workflowRuns).where(eq(workflowRuns.contactId, processed.contactId));
    expect(runCount).toBe(1);
    // Phase 5 also enqueues crm.sync_contact + crm.sync_opportunity outbox jobs (their own
    // duplicate-safety is covered by tests/crm-integration.test.ts) — scope this check to the
    // follow-up job specifically, which is this test's actual concern.
    const [{ n: jobCount }] = await db().select({ n: sql<number>`count(*)::int` }).from(jobs).where(and(eq(jobs.contactId, processed.contactId), eq(jobs.type, FOLLOWUP_JOB)));
    expect(jobCount).toBe(1);
  });

  // ── Claiming ─────────────────────────────────────────────────────────────
  it("concurrent claiming by several workers never claims the same job twice", async () => {
    const leads = await Promise.all(Array.from({ length: 6 }, (_, i) => makeLead(`Claim${i}`)));
    await Promise.all(leads.map((l) => forceDue(l.jobId)));
    const workerIds = ["wA", "wB", "wC", "wD"];
    const batches = await Promise.all(workerIds.map((w) => claimDueJobs(db(), w, 5)));
    const claimedIds = batches.flat().map((j) => j.id).filter((id) => leads.some((l) => l.jobId === id));
    expect(new Set(claimedIds).size).toBe(claimedIds.length); // no duplicates
    expect(claimedIds.length).toBe(leads.length); // every job claimed exactly once, by exactly one worker
  });

  // ── Follow-up chain ──────────────────────────────────────────────────────
  it("runs the full chain (1 → 2 → 3) with the configured delays, then completes the run", async () => {
    const lead = await makeLead("Chain");
    const before2 = Date.now();
    const out1 = await claimAndProcessOne(lead.jobId);
    expect(out1).toBe("completed");
    const [run1] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, lead.runId));
    expect(run1.currentStep).toBe("waiting:followup_2");
    const [job2] = await db().select().from(jobs).where(and(eq(jobs.workflowRunId, lead.runId), eq(jobs.idempotencyKey, `wf:${lead.runId}:followup_2`)));
    expect(job2.runAt.getTime() - before2).toBeGreaterThan(86_400 * 1000 - 5000);

    const before3 = Date.now();
    const out2 = await claimAndProcessOne(job2.id);
    expect(out2).toBe("completed");
    const [job3] = await db().select().from(jobs).where(and(eq(jobs.workflowRunId, lead.runId), eq(jobs.idempotencyKey, `wf:${lead.runId}:followup_3`)));
    expect(job3.runAt.getTime() - before3).toBeGreaterThan(259_200 * 1000 - 5000);

    const out3 = await claimAndProcessOne(job3.id);
    expect(out3).toBe("completed");
    const [run3] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, lead.runId));
    expect(run3.status).toBe("completed");
    expect(run3.stopReason).toBe("sequence_finished");
    const sent = await db().select().from(messages).where(and(eq(messages.workflowRunId, lead.runId), eq(messages.status, "sent")));
    expect(sent).toHaveLength(3); // exactly one message per step
  });

  // ── Stop conditions ──────────────────────────────────────────────────────
  it("stops with reason 'lead_replied' when the lead replies before the follow-up sends", async () => {
    const lead = await makeLead("Reply");
    await logInboundReply(db(), actor, lead.contactId, { channel: "email", body: "Yes let's talk" });
    const out = await claimAndProcessOne(lead.jobId);
    expect(out).toBe("skipped");
    const [run] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, lead.runId));
    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("lead_replied");
  });

  it("stops with reason 'appointment_booked' when an appointment exists", async () => {
    const lead = await makeLead("Appt");
    await db().insert(appointments).values({
      contactId: lead.contactId,
      opportunityId: lead.opportunityId,
      title: "Discovery call",
      startsAt: new Date(Date.now() + 86_400_000),
      endsAt: new Date(Date.now() + 86_400_000 + 1_800_000),
      timezone: "UTC",
      status: "scheduled",
    });
    const out = await claimAndProcessOne(lead.jobId);
    expect(out).toBe("skipped");
    const [run] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, lead.runId));
    expect(run.stopReason).toBe("appointment_booked");
  });

  it("stops with reason 'deal_won' when the deal is marked won", async () => {
    const lead = await makeLead("Won");
    expect((await changeStage(db(), actor, { opportunityId: lead.opportunityId, toStage: "won" })).status).toBe("changed");
    const out = await claimAndProcessOne(lead.jobId);
    expect(out).toBe("skipped");
    const [run] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, lead.runId));
    expect(run.stopReason).toBe("deal_won");
  });

  it("stops with reason 'deal_lost' when the deal is marked lost", async () => {
    const lead = await makeLead("Lost");
    expect((await changeStage(db(), actor, { opportunityId: lead.opportunityId, toStage: "lost", reason: "Went with a competitor" })).status).toBe("changed");
    const out = await claimAndProcessOne(lead.jobId);
    expect(out).toBe("skipped");
    const [run] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, lead.runId));
    expect(run.stopReason).toBe("deal_lost");
  });

  it("stops with reason 'opted_out' when the contact opts out", async () => {
    const lead = await makeLead("OptOut");
    expect((await setOptOut(db(), actor, lead.contactId, true)).status).toBe("ok");
    const out = await claimAndProcessOne(lead.jobId);
    expect(out).toBe("skipped");
    const [run] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, lead.runId));
    expect(run.stopReason).toBe("opted_out");
  });

  it("manual cancel stops the run and cancels the pending job with the given reason, without running the handler", async () => {
    const lead = await makeLead("ManualCancel");
    const r = await cancelWorkflowRun(db(), actor, lead.runId, "Ops decided to pause outreach");
    expect(r.status).toBe("ok");
    const [run] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, lead.runId));
    expect(run.status).toBe("cancelled");
    expect(run.stopReason).toBe("Ops decided to pause outreach");
    const job = await getJobRow(lead.jobId);
    expect(job.status).toBe("cancelled");
    expect(job.statusReason).toContain("Ops decided to pause outreach");
    // the handler never ran — no message exists for this step
    const [msg] = await db().select().from(messages).where(eq(messages.idempotencyKey, `wf:${lead.runId}:followup_1`));
    expect(msg).toBeUndefined();
  });

  // ── Failures & retries ───────────────────────────────────────────────────
  it("a transient failure schedules a retry inside the expected backoff window", async () => {
    const lead = await makeLead("Transient");
    await setFailureMode("transient");
    const at = Date.now();
    const out = await claimAndProcessOne(lead.jobId);
    expect(out).toBe("retry_scheduled");
    const job = await getJobRow(lead.jobId);
    expect(job.status).toBe("retry_scheduled");
    expect(job.attempts).toBe(1);
    expect(job.errorKind).toBe("transient");
    const win = backoffWindowMs(1, { baseSeconds: 15, maxSeconds: 3600 });
    const delta = job.runAt.getTime() - at;
    expect(delta).toBeGreaterThanOrEqual(win.min - 1000);
    expect(delta).toBeLessThanOrEqual(win.max + 3000);
  });

  it("fails permanently after exactly 1 attempt on a permanent error", async () => {
    const lead = await makeLead("Permanent");
    await setFailureMode("permanent");
    const out = await claimAndProcessOne(lead.jobId);
    expect(out).toBe("failed");
    const job = await getJobRow(lead.jobId);
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1);
    expect(job.errorKind).toBe("permanent");
    const attempts = await db().select().from(jobAttempts).where(eq(jobAttempts.jobId, lead.jobId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcome).toBe("permanent_error");
  });

  it("fails after exactly 5 attempts (maxAttempts), with 5 attempt rows, all transient", async () => {
    const lead = await makeLead("FiveAttempts");
    await setFailureMode("transient");
    let last: string | undefined;
    for (let i = 0; i < 5; i++) last = await claimAndProcessOne(lead.jobId);
    expect(last).toBe("failed");
    const job = await getJobRow(lead.jobId);
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(5);
    expect(job.statusReason).toBe("Gave up after 5 of 5 attempts");
    const attempts = await db().select().from(jobAttempts).where(eq(jobAttempts.jobId, lead.jobId)).orderBy(asc(jobAttempts.attempt));
    expect(attempts).toHaveLength(5);
    expect(attempts.every((a) => a.outcome === "transient_error")).toBe(true);
  });

  it("Retry Now moves a failed job back to pending and it completes on the next run", async () => {
    const lead = await makeLead("RetryNow");
    await setFailureMode("permanent");
    expect(await claimAndProcessOne(lead.jobId)).toBe("failed");
    await setFailureMode("off");
    const r = await retryJobNow(db(), actor, lead.jobId, SUPPORTED_JOB_TYPES);
    expect(r.status).toBe("ok");
    const job = await getJobRow(lead.jobId);
    expect(job.status).toBe("pending");
    const claimed = await claimDueJobs(db(), "retry-worker", 10);
    const mine = claimed.find((j) => j.id === lead.jobId)!;
    expect(mine).toBeDefined();
    const outcome = await processJob(db(), mine, "retry-worker");
    expect(outcome).toBe("completed");
    const sent = await db().select().from(messages).where(eq(messages.idempotencyKey, `wf:${lead.runId}:followup_1`));
    expect(sent).toHaveLength(1); // exactly one message despite the earlier failed attempt
  });

  it("retryJobNow refuses a job with no worker handler, and refuses one that is not failed/retry_scheduled", async () => {
    const lead = await makeLead("NoHandler");
    const [row] = await db().insert(jobs).values({ type: "highlevel.sync_contact", idempotencyKey: `nohandler:${uniq()}`, runAt: sql`now()`, status: "failed", attempts: 5, maxAttempts: 5, contactId: lead.contactId }).returning({ id: jobs.id });
    const r = await retryJobNow(db(), actor, row.id, SUPPORTED_JOB_TYPES);
    expect(r.status).toBe("not_allowed");
    if (r.status === "not_allowed") expect(r.error).toContain("No worker handler");

    const stillPending = await retryJobNow(db(), actor, lead.jobId, SUPPORTED_JOB_TYPES);
    expect(stillPending.status).toBe("not_allowed"); // it's "pending", not failed/retry_scheduled
  });

  it("idempotency: calling the handler twice for the same step sends exactly one message and enqueues the next step once", async () => {
    const lead = await makeLead("Idempotent");
    await forceDue(lead.jobId);
    const [job] = await claimDueJobs(db(), "idem-worker", 10).then((rows) => rows.filter((r) => r.id === lead.jobId));
    const r1 = await handleFollowUp(db(), job, "idem-worker");
    expect(r1.outcome).toBe("completed");
    // Simulate a crash-and-retry of the SAME attempt: call the handler again with the same job row.
    const r2 = await handleFollowUp(db(), job, "idem-worker");
    expect(r2.outcome).toBe("completed");
    const sent = await db().select().from(messages).where(eq(messages.idempotencyKey, `wf:${lead.runId}:followup_1`));
    expect(sent).toHaveLength(1);
    const nextJobs = await db().select().from(jobs).where(eq(jobs.idempotencyKey, `wf:${lead.runId}:followup_2`));
    expect(nextJobs).toHaveLength(1);
  });

  // ── Crash recovery & lease safety ────────────────────────────────────────
  it("recovers a job whose lease expired (worker crash) back to retry_scheduled with an 'abandoned' attempt row", async () => {
    const lead = await makeLead("Expired");
    await forceDue(lead.jobId);
    const [claimed] = await claimDueJobs(db(), "dead-worker", 10).then((rows) => rows.filter((r) => r.id === lead.jobId));
    expect(claimed.status).toBe("processing");
    await db().update(jobs).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(jobs.id, lead.jobId));
    const recovered = await recoverAbandonedJobs(db(), "recoverer");
    expect(recovered).toBeGreaterThanOrEqual(1);
    const job = await getJobRow(lead.jobId);
    expect(job.status).toBe("retry_scheduled");
    expect(job.lockedBy).toBeNull();
    const attempts = await db().select().from(jobAttempts).where(eq(jobAttempts.jobId, lead.jobId));
    expect(attempts.some((a) => a.outcome === "abandoned")).toBe(true);
  });

  it("exhausts attempts on lease recovery just like a normal failure (goes to 'failed', not retried forever)", async () => {
    const lead = await makeLead("ExhaustedExpired");
    for (let i = 0; i < 4; i++) {
      await forceDue(lead.jobId);
      const [claimed] = await claimDueJobs(db(), `lease-worker-${i}`, 10).then((rows) => rows.filter((r) => r.id === lead.jobId));
      await db().update(jobs).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(jobs.id, claimed.id));
      await recoverAbandonedJobs(db(), `recoverer-${i}`);
    }
    const job = await getJobRow(lead.jobId);
    expect(job.attempts).toBe(4);
    expect(job.status).toBe("retry_scheduled");
    await forceDue(lead.jobId);
    const [claimed] = await claimDueJobs(db(), "lease-worker-final", 10).then((rows) => rows.filter((r) => r.id === lead.jobId));
    await db().update(jobs).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(jobs.id, claimed.id));
    await recoverAbandonedJobs(db(), "recoverer-final");
    const final = await getJobRow(lead.jobId);
    expect(final.status).toBe("failed");
  });

  it("a stale worker cannot overwrite the result once its lease has been recovered", async () => {
    const lead = await makeLead("Stale");
    await forceDue(lead.jobId);
    const [claimed] = await claimDueJobs(db(), "stale-worker", 10).then((rows) => rows.filter((r) => r.id === lead.jobId));
    expect(claimed.status).toBe("processing");
    // Lease expires (worker hung); another process recovers it.
    await db().update(jobs).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(jobs.id, lead.jobId));
    await recoverAbandonedJobs(db(), "recoverer");
    const afterRecovery = await getJobRow(lead.jobId);
    expect(afterRecovery.status).toBe("retry_scheduled");
    // The original (stale) worker, unaware it was recovered, finally finishes and tries to complete it.
    const ok = await completeJob(db(), claimed, "stale-worker", { outcome: "completed" }, new Date());
    expect(ok).toBe(false); // lease lost — the result is discarded
    const stillRecovered = await getJobRow(lead.jobId);
    expect(stillRecovered.status).toBe("retry_scheduled"); // not overwritten back to completed
  });

  it("a stale worker's failJob is also refused once the lease has moved on", async () => {
    const lead = await makeLead("StaleFail");
    await forceDue(lead.jobId);
    const [claimed] = await claimDueJobs(db(), "stale-worker-2", 10).then((rows) => rows.filter((r) => r.id === lead.jobId));
    await db().update(jobs).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(jobs.id, lead.jobId));
    await recoverAbandonedJobs(db(), "recoverer-2");
    const f = await failJob(db(), claimed, "stale-worker-2", new Error("too late"), new Date());
    expect(f.status).toBe("lease_lost");
  });

  // ── Cancel ───────────────────────────────────────────────────────────────
  it("cancelJob only allows cancelling pending/retry_scheduled jobs", async () => {
    const lead = await makeLead("CancelPending");
    const r = await cancelJob(db(), actor, lead.jobId, "No longer needed");
    expect(r.status).toBe("ok");
    const job = await getJobRow(lead.jobId);
    expect(job.status).toBe("cancelled");
    const again = await cancelJob(db(), actor, lead.jobId, "twice");
    expect(again.status).toBe("not_allowed");
  });

  // ── Worker runtime ───────────────────────────────────────────────────────
  it("runOnce recovers abandoned jobs, claims due jobs, and processes them", async () => {
    const lead = await makeLead("RunOnce");
    await forceDue(lead.jobId);
    const r = await runOnce(db(), "runonce-worker", () => {});
    expect(r.claimed).toBeGreaterThanOrEqual(1);
    expect(r.outcomes).toContain("completed");
    const job = await getJobRow(lead.jobId);
    expect(job.status).toBe("completed");
  });

  it("every supported job type has a registered handler", () => {
    for (const type of SUPPORTED_JOB_TYPES) expect(typeof HANDLERS[type]).toBe("function");
  });

  it(
    "the long-running worker shuts down cleanly on SIGINT/SIGTERM (abort signal): finishes the batch and marks itself stopped",
    async () => {
      const workerId = `graceful-${uniq()}`;
      const controller = new AbortController();
      const runPromise = runWorker(db(), { workerId, signal: controller.signal, log: () => {} });
      await new Promise((resolve) => setTimeout(resolve, 30)); // let it enter the loop at least once
      controller.abort();
      await runPromise;
      const [hb] = await db().select().from(workerHeartbeats).where(eq(workerHeartbeats.workerId, workerId));
      expect(hb.status).toBe("stopped");
    },
    10_000,
  );

  // ── Idempotent enqueue ───────────────────────────────────────────────────
  it("enqueueJob is idempotent: the same idempotency key never creates a second job", async () => {
    const key = `dup-key-${uniq()}`;
    const a = await enqueueJob(db(), { type: FOLLOWUP_JOB, idempotencyKey: key, runAt: new Date(), payload: {} });
    const b = await enqueueJob(db(), { type: FOLLOWUP_JOB, idempotencyKey: key, runAt: new Date(), payload: {} });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.jobId).toBe(b.jobId);
    const rows = await db().select().from(jobs).where(eq(jobs.idempotencyKey, key));
    expect(rows).toHaveLength(1);
  });

  it("only one nurture run per contact — starting it again returns the existing run", async () => {
    const lead = await makeLead("OneRun");
    const again = await startNurtureWorkflow(db(), actor, lead.contactId, "manual.retry");
    expect(again.status).toBe("existing");
    if (again.status === "existing") expect(again.runId).toBe(lead.runId);
    const runs = await db().select().from(workflowRuns).where(eq(workflowRuns.contactId, lead.contactId));
    expect(runs).toHaveLength(1);
  });
});

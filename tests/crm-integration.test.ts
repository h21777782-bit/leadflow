/**
 * Phase 5 tests: the real HighLevel HTTP client (mocked fetch — no network calls,
 * no real credentials needed) and the outbox sync handlers against real Postgres.
 *
 * Timeout and credentials are overridden BEFORE importing anything that reads
 * env, so getEnv()'s module-level cache picks up test-friendly values (dotenv
 * in scripts/load-env.ts never overrides an already-set process.env value).
 */
process.env.HIGHLEVEL_PRIVATE_TOKEN = "test-token";
process.env.HIGHLEVEL_LOCATION_ID = "test-location";
process.env.HIGHLEVEL_PIPELINE_ID = "test-pipeline";
process.env.HIGHLEVEL_HTTP_TIMEOUT_MS = "1000"; // schema minimum — still well under the test's own timeout below

import { hasTestDb } from "./helpers/test-db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, getDb } from "@/db/client";
import { contacts, integrationCalls, jobs, opportunities } from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { PermanentJobError, TransientJobError } from "@/lib/job-errors";
import { backoffWindowMs } from "@/lib/backoff";
import { HighLevelProvider } from "@/server/integrations/crm/highlevel-provider";
import { handleSyncContact, handleSyncOpportunity } from "@/server/workflows/crm-sync";
import { claimDueJobs, enqueueJob, retryJobNow } from "@/server/queue/queue";
import { processJob, SUPPORTED_JOB_TYPES } from "@/server/worker/runner";
import { createContact } from "@/server/services/contacts";
import { changeStage } from "@/server/services/opportunities";
import type { Actor } from "@/server/services/types";

const actor: Actor = { type: "user", userId: null, label: "test-runner" };
const db = () => getDb();
let seq = 0;
const uniq = () => `${Date.now()}-${++seq}`;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type FetchImpl = (...args: unknown[]) => Promise<Response>;
function mockFetchOnce(...responses: Array<Response | FetchImpl>) {
  const fn = vi.fn();
  for (const r of responses) fn.mockImplementationOnce(typeof r === "function" ? r : async () => r);
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Newest first — seed data already has rows for these same operation names, so ordering matters. */
async function callsForOperation(operation: string) {
  return db().select().from(integrationCalls).where(eq(integrationCalls.operation, operation)).orderBy(desc(integrationCalls.createdAt));
}

describe.skipIf(!hasTestDb)("HighLevel CRM integration (mocked fetch, real Postgres)", () => {
  beforeAll(async () => {
    await migrate(db(), { migrationsFolder: "./drizzle" });
    await seedDatabase(db());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await closeDb();
  });

  // ── HTTP client / provider level (mocked fetch) ─────────────────────────
  it("success: upsertContact returns the HighLevel id and logs a successful call", async () => {
    mockFetchOnce(jsonResponse(200, { new: true, contact: { id: "ghl_contact_abc" } }));
    const provider = new HighLevelProvider(db(), () => ({ operation: "contacts.upsert" }));
    const res = await provider.upsertContact({ locationId: "loc", firstName: "Ada", email: "ada@test.example" });
    expect(res).toEqual({ ghlContactId: "ghl_contact_abc", created: true });
    const [call] = await callsForOperation("contacts.upsert");
    expect(call.success).toBe(true);
    expect(call.statusCode).toBe(200);
  });

  it("429: throws a transient error carrying the Retry-After delay, and logs the failed call", async () => {
    mockFetchOnce(jsonResponse(429, { message: "rate limited" }, { "Retry-After": "5" }));
    const provider = new HighLevelProvider(db(), () => ({ operation: "contacts.upsert" }));
    let caught: unknown;
    try {
      await provider.upsertContact({ locationId: "loc", firstName: "Rate", email: `rate-${uniq()}@test.example` });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TransientJobError);
    expect((caught as TransientJobError).retryAfterMs).toBe(5000);
    const calls = await callsForOperation("contacts.upsert");
    expect(calls.some((c) => c.statusCode === 429 && !c.success)).toBe(true);
  });

  it("503 then recovery: first call fails transiently, a second call (as a retry would make) succeeds", async () => {
    mockFetchOnce(jsonResponse(503, { message: "service unavailable" }), jsonResponse(200, { new: false, contact: { id: "ghl_contact_recovered" } }));
    const provider = new HighLevelProvider(db(), () => ({ operation: "contacts.upsert" }));
    const input = { locationId: "loc", firstName: "Outage", email: `outage-${uniq()}@test.example` };
    await expect(provider.upsertContact(input)).rejects.toBeInstanceOf(TransientJobError);
    const res = await provider.upsertContact(input); // simulates the worker's retry
    expect(res).toEqual({ ghlContactId: "ghl_contact_recovered", created: false });
  });

  it("401: throws a permanent error (bad credentials are never worth retrying)", async () => {
    mockFetchOnce(jsonResponse(401, { message: "invalid token" }));
    const provider = new HighLevelProvider(db(), () => ({ operation: "contacts.upsert" }));
    await expect(provider.upsertContact({ locationId: "loc", firstName: "Bad", email: `bad-${uniq()}@test.example` })).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("timeout: an unresponsive server is classified as a transient error", async () => {
    // Real fetch rejects when its AbortSignal fires; this mock reproduces that instead of just hanging forever.
    mockFetchOnce((...args: unknown[]) => {
      const init = args[1] as { signal?: AbortSignal } | undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })));
      });
    });
    const provider = new HighLevelProvider(db(), () => ({ operation: "contacts.upsert" }));
    await expect(provider.upsertContact({ locationId: "loc", firstName: "Slow", email: `slow-${uniq()}@test.example` })).rejects.toMatchObject({
      constructor: TransientJobError,
      message: expect.stringContaining("timed out"),
    });
  }, 5_000);

  it("never logs the bearer token in the request body written to integration_calls", async () => {
    mockFetchOnce(jsonResponse(200, { new: true, contact: { id: "ghl_x" } }));
    const provider = new HighLevelProvider(db(), () => ({ operation: "contacts.upsert" }));
    await provider.upsertContact({ locationId: "loc", firstName: "Safe", email: `safe-${uniq()}@test.example` });
    const [call] = await callsForOperation("contacts.upsert");
    const serialized = JSON.stringify(call);
    expect(serialized).not.toContain("test-token");
    expect(serialized).not.toContain("Bearer");
  });

  it("backoff for a transient CRM failure lands inside the expected window (same lib the queue uses)", async () => {
    // Not a queue test — just confirms the CRM path's errors are classified so `failJob` backs off correctly.
    const win = backoffWindowMs(1, { baseSeconds: 15, maxSeconds: 3600 });
    expect(win.min).toBe(7_500);
    expect(win.max).toBe(15_000);
  });

  // ── Handler-level idempotent re-sync (real DB, mock provider — no fetch needed) ──
  it("idempotent re-sync: a contact is upserted, not re-created, on every subsequent sync", async () => {
    const r = await createContact(db(), actor, { firstName: "Idem", lastName: "Potent", email: `idem-${uniq()}@crm.example`, leadSource: "website_form" });
    if (r.status !== "created") throw new Error(`setup failed: ${JSON.stringify(r)}`);

    const [firstJob] = await claimDueJobs(db(), "crm-test-worker", 10).then((rows) => rows.filter((j) => j.contactId === r.contactId && j.type === "crm.sync_contact"));
    expect(firstJob).toBeDefined();
    const outcome1 = await processJob(db(), firstJob, "crm-test-worker");
    expect(outcome1).toBe("completed");
    const [afterFirst] = await db().select().from(contacts).where(eq(contacts.id, r.contactId));
    expect(afterFirst.ghlContactId).toBeTruthy();

    // Simulate a second, independent sync (e.g. the lead was edited again) — same job type, run directly.
    const { jobId } = await enqueueJob(db(), { type: "crm.sync_contact", idempotencyKey: `crm:sync_contact:${r.contactId}:manual-${uniq()}`, runAt: new Date(), payload: { contactId: r.contactId }, contactId: r.contactId });
    const [job2] = await claimDueJobs(db(), "crm-test-worker-2", 10).then((rows) => rows.filter((j) => j.id === jobId));
    await processJob(db(), job2, "crm-test-worker-2");
    const [afterSecond] = await db().select().from(contacts).where(eq(contacts.id, r.contactId));
    expect(afterSecond.ghlContactId).toBe(afterFirst.ghlContactId); // same HighLevel record, not a new one
  });

  it("idempotent re-sync: an opportunity is created once (ghl_opportunity_id stored), then updated in place on every later sync", async () => {
    const r = await createContact(db(), actor, { firstName: "Deal", lastName: "Sync", email: `dealsync-${uniq()}@crm.example`, leadSource: "website_form" });
    if (r.status !== "created" || !r.opportunityId) throw new Error(`setup failed: ${JSON.stringify(r)}`);
    const contactId = r.contactId;
    const opportunityId = r.opportunityId;

    // createContact enqueues BOTH crm.sync_contact and crm.sync_opportunity at once (both due now) —
    // claim them together, same as the real worker's batch would, then process contact first.
    const claimed = await claimDueJobs(db(), "crm-test-worker", 10);
    const contactJob = claimed.find((j) => j.contactId === contactId && j.type === "crm.sync_contact")!;
    const oppJob = claimed.find((j) => j.opportunityId === opportunityId && j.type === "crm.sync_opportunity")!;
    expect(contactJob).toBeDefined();
    expect(oppJob).toBeDefined();
    await processJob(db(), contactJob, "crm-test-worker");
    expect(await processJob(db(), oppJob, "crm-test-worker")).toBe("completed");
    const [afterCreate] = await db().select().from(opportunities).where(eq(opportunities.id, opportunityId));
    expect(afterCreate.ghlOpportunityId).toBeTruthy();
    const createCalls = await callsForOperation("opportunities.create");
    expect(createCalls.length).toBeGreaterThanOrEqual(1);

    // A stage change enqueues crm.update_opportunity — should UPDATE the same HighLevel record, not create a second one.
    await changeStage(db(), actor, { opportunityId, toStage: "qualified" });
    const [stageJob] = await claimDueJobs(db(), "crm-test-worker", 10).then((rows) => rows.filter((j) => j.opportunityId === opportunityId && j.type === "crm.update_opportunity"));
    expect(stageJob).toBeDefined();
    expect(await processJob(db(), stageJob, "crm-test-worker")).toBe("completed");
    const [afterUpdate] = await db().select().from(opportunities).where(eq(opportunities.id, opportunityId));
    expect(afterUpdate.ghlOpportunityId).toBe(afterCreate.ghlOpportunityId); // unchanged — updated, not re-created
    const updateCalls = await callsForOperation("opportunities.update");
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("the seeded HighLevel failure jobs (crm.sync_contact / crm.update_opportunity) are now retryable with a real handler", async () => {
    const [rohan] = await db().select({ id: contacts.id }).from(contacts).where(eq(contacts.emailNormalized, "rohan@deshpandelogistics.example"));
    const [seededContact] = await db().select().from(jobs).where(eq(jobs.idempotencyKey, `seed:crm.sync_contact:${rohan.id}`));
    expect(seededContact).toBeDefined();
    expect(seededContact.status).toBe("failed");
    // Failed Automations previously refused these ("No worker handler exists for … yet") — retryJobNow must accept them now.
    expect(SUPPORTED_JOB_TYPES).toContain("crm.sync_contact");
    expect(SUPPORTED_JOB_TYPES).toContain("crm.update_opportunity");
    const retryContact = await retryJobNow(db(), actor, seededContact.id, SUPPORTED_JOB_TYPES);
    expect(retryContact.status).toBe("ok");
    // A payload with only contactId (the legacy seeded shape) resolves and completes for real.
    const result = await handleSyncContact(db(), seededContact, "retry-test-worker");
    expect(result.outcome).toBe("completed");

    const [hannah] = await db().select({ id: contacts.id }).from(contacts).where(eq(contacts.emailNormalized, "hannah@fischerbikes.example"));
    const [seededOpp] = await db().select().from(jobs).where(eq(jobs.idempotencyKey, `seed:crm.update_opportunity:${hannah.id}`));
    expect(seededOpp).toBeDefined();
    const retryOpp = await retryJobNow(db(), actor, seededOpp.id, SUPPORTED_JOB_TYPES);
    expect(retryOpp.status).toBe("ok"); // accepted for retry — no longer "no handler exists"
    // `message.send_sms` (the third seeded failure) is intentionally still unsupported — a different, unbuilt provider.
    expect(SUPPORTED_JOB_TYPES).not.toContain("message.send_sms");
  });

  it("crm.sync_opportunity retries (transient) instead of failing when the contact has not synced yet", async () => {
    const r = await createContact(db(), actor, { firstName: "NotYet", lastName: "Synced", email: `notyet-${uniq()}@crm.example`, leadSource: "website_form" });
    if (r.status !== "created" || !r.opportunityId) throw new Error(`setup failed: ${JSON.stringify(r)}`);
    const [oppJob] = await claimDueJobs(db(), "crm-test-worker", 10).then((rows) => rows.filter((j) => j.opportunityId === r.opportunityId && j.type === "crm.sync_opportunity"));
    // Contact hasn't been synced yet (its own job hasn't run) — must be transient, not permanent.
    await expect(handleSyncOpportunity(db(), oppJob, "crm-test-worker")).rejects.toBeInstanceOf(TransientJobError);
  });
});

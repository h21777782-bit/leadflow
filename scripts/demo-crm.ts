/**
 * DEMO — SIMULATED HIGHLEVEL OUTAGE, RETRY, RECOVERY
 *   new lead → crm.sync_contact enqueued → demo failure switch → 503 → job
 *   fails and is scheduled to retry → switch off → worker recovers → contact
 *   synced → full audit trail shown.
 *
 * Fictional lead only (.example domain), tagged "demo-automation". Runs
 * entirely in MOCK_MODE (no real HighLevel credentials needed or used —
 * every "HighLevel" response below is [SIMULATED]).
 * Safe to run repeatedly: it first removes leads from previous runs.
 *
 *   npm run demo:crm
 */
import "./load-env";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { auditLogs, contacts, integrationCalls, jobs } from "@/db/schema";
import { CRM_FAILURE_SWITCH_KEY } from "@/server/integrations/crm";
import { setSetting } from "@/server/services/app-settings";
import { createContact } from "@/server/services/contacts";
import type { Actor } from "@/server/services/types";
import { runOnce } from "@/server/worker/runner";

const actor: Actor = { type: "user", userId: null, label: "demo:crm script" };
const TAG = "demo-automation";

async function reset() {
  const db = getDb();
  const old = await db.select({ id: contacts.id }).from(contacts).where(sql`${TAG} = any(${contacts.tags}) and ${contacts.emailNormalized} like 'demo-crm-%'`);
  if (old.length) await db.delete(contacts).where(inArray(contacts.id, old.map((o) => o.id)));
  await setSetting(db, CRM_FAILURE_SWITCH_KEY, "off");
  console.log(`Reset: removed ${old.length} lead(s) from earlier demo:crm runs, failure switch set to off.`);
}

async function forceDue(jobId: string) {
  await getDb().update(jobs).set({ runAt: sql`now() - interval '1 second'` }).where(eq(jobs.id, jobId));
}

async function main() {
  console.log("LeadFlow — DEMO: simulated HighLevel outage, retry, recovery\n" + "─".repeat(60));
  console.log("Every HighLevel call below is [SIMULATED] — MOCK_MODE, no real API is contacted.");
  await reset();
  const db = getDb();

  console.log("\n▶ 1. New lead arrives — a crm.sync_contact job is enqueued (outbox pattern)");
  const r = await createContact(db, actor, {
    firstName: "Demo",
    lastName: "CrmOutage",
    email: `demo-crm-${Date.now()}@automation.example`,
    country: "DE",
    leadSource: "referral",
    serviceInterest: "crm_automation",
    budgetAmount: "7000",
    tags: TAG,
    notes: "[DEMO] fictional lead used by npm run demo:crm",
  });
  if (r.status !== "created") throw new Error(`Could not create lead: ${JSON.stringify(r)}`);
  const [syncJob] = await db.select().from(jobs).where(sql`${jobs.contactId} = ${r.contactId} and ${jobs.type} = 'crm.sync_contact'`);
  if (!syncJob) throw new Error("crm.sync_contact job was not enqueued");
  console.log(`  job ${syncJob.id.slice(0, 8)} (crm.sync_contact) pending`);

  console.log("\n▶ 2. Demo CRM failure switch → 503 (simulates a HighLevel outage)");
  await setSetting(db, CRM_FAILURE_SWITCH_KEY, "503");
  await forceDue(syncJob.id);
  const r1 = await runOnce(db, "demo-crm-worker", (m) => console.log(`  ${m}`));
  console.log(`  outcomes: [${r1.outcomes.join(", ")}]`);
  const [afterFail] = await db.select().from(jobs).where(eq(jobs.id, syncJob.id));
  console.log(`  job status: ${afterFail.status} — “${afterFail.lastError}” — next retry at ${afterFail.runAt.toISOString()}`);
  if (afterFail.status !== "retry_scheduled") throw new Error(`Expected retry_scheduled, got ${afterFail.status}`);

  console.log("\n▶ 3. Demo CRM failure switch → OFF (the outage is over) — worker recovers on its own retry schedule");
  await setSetting(db, CRM_FAILURE_SWITCH_KEY, "off");
  await forceDue(syncJob.id); // demo only: forces the already-scheduled retry due now instead of waiting out the backoff
  const r2 = await runOnce(db, "demo-crm-worker", (m) => console.log(`  ${m}`));
  console.log(`  outcomes: [${r2.outcomes.join(", ")}]`);

  const [final] = await db.select().from(jobs).where(eq(jobs.id, syncJob.id));
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, r.contactId));
  console.log("\n▶ 4. Result");
  console.log(`  job status: ${final.status} (attempts: ${final.attempts})`);
  console.log(`  contact.ghl_contact_id: ${contact.ghlContactId}`);
  if (final.status !== "completed" || !contact.ghlContactId) throw new Error("Expected the job to complete and the contact to be synced");

  console.log("\n▶ 5. Full audit trail (integration_calls + audit_logs) for this lead");
  const calls = await db.select().from(integrationCalls).where(eq(integrationCalls.jobId, syncJob.id)).orderBy(integrationCalls.createdAt);
  for (const c of calls) console.log(`  [call] ${c.provider} ${c.operation} attempt ${c.attempt} → ${c.statusCode ?? "—"} ${c.success ? "OK" : "FAILED"}${c.error ? `: ${c.error}` : ""}`);
  const audit = await db.select().from(auditLogs).where(eq(auditLogs.contactId, r.contactId)).orderBy(desc(auditLogs.createdAt));
  for (const a of audit.filter((a) => a.eventType.startsWith("crm."))) console.log(`  [audit] ${a.eventType}: ${a.message}`);

  console.log(`\nDone. Open /integrations for the failure switch + recent calls, and /contacts/${r.contactId} for the activity log.`);
}

main()
  .catch((err) => {
    console.error("✖ Demo failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

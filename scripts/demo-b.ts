/**
 * DEMO B — FAILURE, RETRY, RECOVERY
 *   demo failure switch → transient → follow-up job fails with error + retry time shown
 *   → switch off → Retry Now → success → proves exactly ONE message exists despite the failure.
 *
 * Fictional lead only (.example domain), tagged "demo-automation".
 * Safe to run repeatedly: it first removes leads from previous runs.
 *
 *   npm run demo:b
 */
import "./load-env";
import { eq, inArray, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { contacts, jobs, messages } from "@/db/schema";
import { FAILURE_SWITCH_KEY } from "@/server/integrations/messaging/mock-provider";
import { retryJobNow } from "@/server/queue/queue";
import { setSetting } from "@/server/services/app-settings";
import { createContact } from "@/server/services/contacts";
import type { Actor } from "@/server/services/types";
import { runOnce, SUPPORTED_JOB_TYPES } from "@/server/worker/runner";

const actor: Actor = { type: "user", userId: null, label: "demo:b script" };
const TAG = "demo-automation";

// Scoped to this script's own email prefix (not the whole demo-automation tag) so
// demo:a, demo:b and demo:c can be run in any order without deleting each other's lead.
async function reset() {
  const db = getDb();
  const old = await db.select({ id: contacts.id }).from(contacts).where(sql`${TAG} = any(${contacts.tags}) and ${contacts.emailNormalized} like 'demo-b-%'`);
  if (old.length) await db.delete(contacts).where(inArray(contacts.id, old.map((o) => o.id)));
  await setSetting(db, FAILURE_SWITCH_KEY, "off");
  console.log(`Reset: removed ${old.length} lead(s) from earlier demo:b runs, failure switch set to off.`);
}

async function forceDue(jobId: string) {
  await getDb().update(jobs).set({ runAt: sql`now() - interval '1 second'` }).where(eq(jobs.id, jobId));
}

async function main() {
  console.log("LeadFlow — DEMO B: simulated outage, retry, recovery\n" + "─".repeat(60));
  await reset();
  const db = getDb();

  console.log("\n▶ 1. New lead arrives");
  const r = await createContact(db, actor, {
    firstName: "Demo",
    lastName: "Failure",
    email: `demo-b-${Date.now()}@automation.example`,
    country: "GB",
    leadSource: "google_ads",
    serviceInterest: "paid_ads",
    budgetAmount: "4000",
    tags: TAG,
    notes: "[DEMO] fictional lead used by npm run demo:b",
  });
  if (r.status !== "created" || !r.workflow || r.workflow.status !== "started") throw new Error(`Setup failed: ${JSON.stringify(r)}`);
  const jobId = r.workflow.jobId;
  console.log(`  workflow started, followup_1 job ${jobId.slice(0, 8)} scheduled`);

  console.log("\n▶ 2. Demo failure switch → TRANSIENT (simulates the messaging provider being down)");
  await setSetting(db, FAILURE_SWITCH_KEY, "transient");
  await forceDue(jobId);
  const r1 = await runOnce(db, "demo-b-worker", (m) => console.log(`  ${m}`));
  console.log(`  outcomes: [${r1.outcomes.join(", ")}]`);
  const [afterFail] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  console.log(`  job status: ${afterFail.status} — error: “${afterFail.lastError}” — next retry at ${afterFail.runAt.toISOString()}`);
  if (afterFail.status !== "retry_scheduled") throw new Error(`Expected retry_scheduled, got ${afterFail.status}`);

  console.log("\n▶ 3. Demo failure switch → OFF (the outage is over)");
  await setSetting(db, FAILURE_SWITCH_KEY, "off");

  console.log("\n▶ 4. Retry Now (as if a person clicked the button on the Failed Automations page)");
  // The job is still in its backoff window, so it wouldn't be picked up yet — Retry Now forces it due.
  const retry = await retryJobNow(db, actor, jobId, SUPPORTED_JOB_TYPES);
  console.log(`  retryJobNow → ${retry.status}${retry.status === "ok" ? `: ${retry.message}` : ""}`);
  const r2 = await runOnce(db, "demo-b-worker", (m) => console.log(`  ${m}`));
  console.log(`  outcomes: [${r2.outcomes.join(", ")}]`);

  const [final] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  const sent = await db.select().from(messages).where(eq(messages.contactId, r.contactId));
  console.log("\n▶ 5. Result");
  console.log(`  job status: ${final.status} (attempts: ${final.attempts})`);
  console.log(`  messages for this lead: ${sent.length} — exactly one, even though the first attempt failed`);
  if (sent.length !== 1) throw new Error(`Expected exactly 1 message, found ${sent.length}`);

  console.log(`\nDone. Open /failed-automations and /contacts/${r.contactId} to see the attempt history and audit trail.`);
}

main()
  .catch((err) => {
    console.error("✖ Demo B failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

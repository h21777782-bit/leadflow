/**
 * DEMO C — CANCELLATION BY REPLY
 *   lead with a pending follow-up → lead replies → worker runs → follow-up
 *   is skipped with reason "Lead replied", and the workflow stops.
 *
 * Fictional lead only (.example domain), tagged "demo-automation".
 * Safe to run repeatedly: it first removes leads from previous runs.
 *
 *   npm run demo:c
 */
import "./load-env";
import { eq, inArray, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { contacts, jobs, workflowRuns } from "@/db/schema";
import { FAILURE_SWITCH_KEY } from "@/server/integrations/messaging/mock-provider";
import { logInboundReply } from "@/server/services/lead-intelligence";
import { setSetting } from "@/server/services/app-settings";
import { createContact } from "@/server/services/contacts";
import type { Actor } from "@/server/services/types";
import { runOnce } from "@/server/worker/runner";

const actor: Actor = { type: "user", userId: null, label: "demo:c script" };
const TAG = "demo-automation";

// Scoped to this script's own email prefix (not the whole demo-automation tag) so
// demo:a, demo:b and demo:c can be run in any order without deleting each other's lead.
async function reset() {
  const db = getDb();
  const old = await db.select({ id: contacts.id }).from(contacts).where(sql`${TAG} = any(${contacts.tags}) and ${contacts.emailNormalized} like 'demo-c-%'`);
  if (old.length) await db.delete(contacts).where(inArray(contacts.id, old.map((o) => o.id)));
  await setSetting(db, FAILURE_SWITCH_KEY, "off");
  console.log(`Reset: removed ${old.length} lead(s) from earlier demo:c runs.`);
}

async function main() {
  console.log("LeadFlow — DEMO C: cancellation when the lead replies\n" + "─".repeat(60));
  await reset();
  const db = getDb();

  console.log("\n▶ 1. New lead arrives, follow-up 1 scheduled");
  const r = await createContact(db, actor, {
    firstName: "Demo",
    lastName: "Cancellation",
    email: `demo-c-${Date.now()}@automation.example`,
    country: "IN",
    leadSource: "referral",
    serviceInterest: "web_design",
    budgetAmount: "5000",
    tags: TAG,
    notes: "[DEMO] fictional lead used by npm run demo:c",
  });
  if (r.status !== "created" || !r.workflow || r.workflow.status !== "started") throw new Error(`Setup failed: ${JSON.stringify(r)}`);
  const jobId = r.workflow.jobId;
  console.log(`  followup_1 job ${jobId.slice(0, 8)} scheduled for ${r.workflow.firstRunAt.toISOString()}`);

  console.log("\n▶ 2. Lead replies before the follow-up sends");
  const reply = await logInboundReply(db, actor, r.contactId, { channel: "email", body: "[DEMO] Thanks, yes I'm still interested — can we talk this week?" });
  if (reply.status !== "logged") throw new Error(`Could not log reply: ${JSON.stringify(reply)}`);
  console.log("  inbound message recorded");

  console.log("\n▶ 3. Worker runs (this demo forces the follow-up due immediately instead of waiting the real delay)");
  await db.update(jobs).set({ runAt: sql`now() - interval '1 second'` }).where(eq(jobs.id, jobId));
  const result = await runOnce(db, "demo-c-worker", (m) => console.log(`  ${m}`));
  console.log(`  outcomes: [${result.outcomes.join(", ")}]`);

  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, r.workflow.runId));
  console.log("\n▶ 4. Result");
  console.log(`  job status: ${job.status} — “${job.statusReason}”`);
  console.log(`  workflow run status: ${run.status} — stop reason “${run.stopReason}”`);
  if (job.status !== "skipped" || run.stopReason !== "lead_replied") {
    throw new Error(`Expected job skipped / stopReason lead_replied, got ${job.status} / ${run.stopReason}`);
  }

  console.log(`\nDone. Open /contacts/${r.contactId} to see the reply, the skipped follow-up and the stopped workflow.`);
}

main()
  .catch((err) => {
    console.error("✖ Demo C failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

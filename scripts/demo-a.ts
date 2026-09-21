/**
 * DEMO A — SUCCESS PATH
 *   new lead → score + owner → follow-up scheduled → worker runs → completed
 *   → simulated message sent → activity log updated.
 *
 * Fictional lead only (.example domain), tagged "demo-automation".
 * Safe to run repeatedly: it first removes leads from previous runs.
 *
 *   npm run demo:a
 */
import "./load-env";
import { eq, inArray, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { contacts, jobs, messages } from "@/db/schema";
import { FAILURE_SWITCH_KEY } from "@/server/integrations/messaging/mock-provider";
import { setSetting } from "@/server/services/app-settings";
import { createContact } from "@/server/services/contacts";
import type { Actor } from "@/server/services/types";
import { runOnce } from "@/server/worker/runner";

const actor: Actor = { type: "user", userId: null, label: "demo:a script" };
const TAG = "demo-automation";

// Scoped to this script's own email prefix (not the whole demo-automation tag) so
// demo:a, demo:b and demo:c can be run in any order without deleting each other's lead.
async function reset() {
  const db = getDb();
  const old = await db.select({ id: contacts.id }).from(contacts).where(sql`${TAG} = any(${contacts.tags}) and ${contacts.emailNormalized} like 'demo-a-%'`);
  if (old.length) await db.delete(contacts).where(inArray(contacts.id, old.map((o) => o.id)));
  await setSetting(db, FAILURE_SWITCH_KEY, "off");
  console.log(`Reset: removed ${old.length} lead(s) from earlier demo:a runs, failure switch set to off.`);
}

async function main() {
  console.log("LeadFlow — DEMO A: success path\n" + "─".repeat(60));
  await reset();
  const db = getDb();

  console.log("\n▶ 1. New lead arrives (website form)");
  const r = await createContact(db, actor, {
    firstName: "Demo",
    lastName: "Success",
    email: `demo-a-${Date.now()}@automation.example`,
    phone: "+1 415 555 0100",
    company: "Success Path Co",
    country: "US",
    leadSource: "website_form",
    serviceInterest: "seo",
    budgetAmount: "6000",
    tags: TAG,
    notes: "[DEMO] fictional lead used by npm run demo:a",
  });
  if (r.status !== "created") throw new Error(`Could not create lead: ${JSON.stringify(r)}`);
  const sc = r.intelligence.score;
  console.log(`  score  ${sc ? `${sc.result.score} (${sc.result.band.toUpperCase()})` : "not computed"}`);
  const rt = r.intelligence.routing;
  console.log(`  owner  ${rt && "userName" in rt ? `${rt.status} → ${rt.userName}` : (rt?.reason ?? "n/a")}`);
  if (!r.workflow || r.workflow.status !== "started") throw new Error(`Workflow did not start: ${JSON.stringify(r.workflow)}`);
  console.log(`  workflow  “new_lead_nurture” started, followup_1 scheduled for ${r.workflow.firstRunAt.toISOString()}`);

  console.log("\n▶ 2. Worker runs (this demo forces the follow-up due immediately instead of waiting the real delay)");
  await db.update(jobs).set({ runAt: sql`now() - interval '1 second'` }).where(eq(jobs.id, r.workflow.jobId));
  const result = await runOnce(db, "demo-a-worker", (m) => console.log(`  ${m}`));
  console.log(`  runOnce → recovered ${result.recovered}, claimed ${result.claimed}, outcomes [${result.outcomes.join(", ")}]`);

  const [msg] = await db.select().from(messages).where(eq(messages.contactId, r.contactId));
  console.log("\n▶ 3. Result");
  console.log(`  message  [${msg.status.toUpperCase()}]${msg.provider === "mock" ? " SIMULATED —" : ""} “${msg.subject}” to ${msg.toAddress}`);
  console.log(`  provider message id: ${msg.providerMessageId}`);

  console.log(`\nDone. Open /contacts/${r.contactId} to see the score, owner, follow-up timeline, message and activity log.`);
}

main()
  .catch((err) => {
    console.error("✖ Demo A failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

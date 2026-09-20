/**
 * DEMO SCENARIO — scoring & routing, executed through the REAL services
 * (same functions the UI and tests call) against your development database.
 *
 * Fictional leads only (.example domains), tagged "demo-scenario".
 * Safe to run repeatedly: it first removes leads from previous runs and
 * restores rep availability to the seed state.
 *
 *   npm run demo:routing
 */
import "./load-env";
import { eq, inArray, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { contacts, users } from "@/db/schema";
import { SEED_USERS } from "@/db/seed-data";
import { createContact, updateContact } from "@/server/services/contacts";
import { logInboundReply, updateRepStatus, type LeadChangeOutcome } from "@/server/services/lead-intelligence";
import type { Actor } from "@/server/services/types";

const actor: Actor = { type: "user", userId: null, label: "demo:routing script" };
const TAG = "demo-scenario";

function show(step: string, o: LeadChangeOutcome | null | undefined) {
  console.log(`\n▶ ${step}`);
  if (!o) return;
  const s = o.score;
  if (s) {
    const arrow = s.previous.score === null ? `${s.result.score}` : `${s.previous.score} → ${s.result.score}`;
    console.log(`  score  ${arrow} (${s.result.band.toUpperCase()})`);
    for (const f of s.result.factors) console.log(`         ${f.factor.padEnd(11)} ${String(f.points).padStart(2)}/${f.max}  ${f.reason}`);
  }
  const r = o.routing;
  if (r) {
    if (r.status === "assigned" || r.status === "reassigned") console.log(`  owner  ${r.status.toUpperCase()} → ${r.userName}\n         ${r.reason}`);
    else console.log(`  owner  ${r.status.toUpperCase()}: ${r.reason}`);
  }
  if (o.errors.length) console.log(`  ERRORS ${o.errors.join("; ")}`);
}

async function repId(key: string) {
  const email = SEED_USERS.find((u) => u.key === key)!.email;
  const [u] = await getDb().select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!u) throw new Error(`Rep ${key} missing — run npm run db:seed first`);
  return u.id;
}

async function printRerouted(title: string, r: Awaited<ReturnType<typeof updateRepStatus>>) {
  const list = r.status === "updated" ? r.rerouted : [];
  console.log(`\n▶ ${title} → ${list.length} lead(s) re-evaluated`);
  for (const x of list) {
    const [c] = await getDb().select({ first: contacts.firstName, last: contacts.lastName }).from(contacts).where(eq(contacts.id, x.contactId));
    const o = x.outcome;
    const what = !o ? "no change" : "userName" in o ? `${o.status} → ${o.userName}` : o.status === "unassigned" ? `UNASSIGNED (${o.reason})` : `${o.status} (${o.reason})`;
    console.log(`  ${c.first} ${c.last ?? ""}: ${what}`);
  }
}

async function createLead(input: Record<string, string>) {
  const r = await createContact(getDb(), actor, { ...input, tags: TAG, notes: "[demo scenario] fictional lead" });
  if (r.status !== "created") throw new Error(`Could not create ${input.firstName}: ${JSON.stringify(r)}`);
  return r;
}

async function main() {
  const db = getDb();
  console.log("LeadFlow — DEMO SCENARIO: scoring & routing (fictional data)\n" + "─".repeat(60));
  console.log("Tip: run `npm run db:seed` first for identical output every time (this script also re-routes seed leads).");

  // Reset from previous runs
  const old = await db.select({ id: contacts.id }).from(contacts).where(sql`${TAG} = any(${contacts.tags})`);
  if (old.length) await db.delete(contacts).where(inArray(contacts.id, old.map((o) => o.id)));
  for (const u of SEED_USERS.filter((x) => x.role === "sales_rep")) {
    await db.update(users).set({ isAvailable: u.isAvailable, isActive: u.isActive, maxOpenLeads: u.maxOpenLeads }).where(eq(users.email, u.email));
  }
  console.log(`Reset: removed ${old.length} lead(s) from earlier runs, restored rep availability.`);

  // 1. New lead from Dubai
  const leilaInput = { firstName: "Leila", lastName: "Farouk", email: "leila@farouk-design.example", phone: "+971 50 765 4321", country: "AE", company: "Farouk Design", leadSource: "website_form", serviceInterest: "web_design", budgetAmount: "3000" };
  const leila = await createLead(leilaInput);
  show("1. New lead: Leila Farouk (UAE, web design, $3,000)", leila.intelligence);

  // 2. Budget goes up → score changes, owner is sticky
  const up = await updateContact(db, actor, leila.contactId, { ...leilaInput, budgetAmount: "15000", tags: TAG, notes: "[demo scenario] fictional lead" });
  show("2. Leila's budget changes to $15,000", up.status === "updated" ? up.intelligence : null);

  // 3. She replies
  const reply = await logInboundReply(db, actor, leila.contactId, { channel: "email", body: "[demo scenario] Yes, can we talk Thursday?" });
  show("3. Leila replies to our email", reply.status === "logged" ? reply.outcome : null);

  // 4. CRM lead from the US
  const ben = await createLead({ firstName: "Ben", lastName: "Ortiz", email: "ben@ortiz-roofing.example", country: "US", company: "Ortiz Roofing", leadSource: "google_ads", serviceInterest: "crm_automation", budgetAmount: "9000" });
  show("4. New lead: Ben Ortiz (US, CRM automation, $9,000)", ben.intelligence);

  // 5. Daniel goes on leave → his not-yet-contacted leads are re-routed
  const daniel = await repId("daniel");
  await printRerouted("5. Daniel Brooks marked UNAVAILABLE", await updateRepStatus(db, actor, daniel, { isAvailable: false }));

  // 6. Neha also away → her early leads move; a new CRM lead has nobody eligible
  const neha = await repId("neha");
  await printRerouted("6a. Neha Kulkarni also marked UNAVAILABLE", await updateRepStatus(db, actor, neha, { isAvailable: false }));
  const carla = await createLead({ firstName: "Carla", lastName: "Mendes", email: "carla@mendes-dental.example", country: "US", company: "Mendes Dental", leadSource: "meta_ads", serviceInterest: "crm_automation" });
  show("6b. New lead while both CRM reps are away: Carla Mendes (US, CRM, no budget given)", carla.intelligence);

  // 7. Daniel returns → every waiting lead is retried
  await printRerouted("7. Daniel Brooks back to AVAILABLE — waiting unassigned leads retried", await updateRepStatus(db, actor, daniel, { isAvailable: true }));

  // 8. Neha returns → remaining waiting leads retried; already-owned leads are NOT taken back (sticky)
  await printRerouted("8. Neha Kulkarni back to AVAILABLE — only still-unassigned leads are retried", await updateRepStatus(db, actor, neha, { isAvailable: true }));

  console.log("\nDone. Open /dashboard, /contacts and each lead's page to see scores, owners, routing decisions and audit entries.");
}

main()
  .catch((err) => {
    console.error("✖ Demo failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

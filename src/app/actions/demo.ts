"use server";

import { inArray, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { contacts } from "@/db/schema";
import { createContact } from "@/server/services/contacts";
import { getActingUser } from "@/server/services/actor";
import { DEMO_TAG } from "@/lib/demo";

const FIRST_NAMES = ["Priya", "Marcus", "Elena", "Samuel", "Noor", "Diego", "Hana", "Liam"];
const COMPANIES = ["Bright Path Studio", "Nova Digital", "Summit Roofing", "Clearwater Dental", "Alpine Fitness", "Harbor Legal"];
const SOURCES = ["website_form", "google_ads", "meta_ads", "referral"] as const;
const SERVICES = ["web_design", "seo", "crm_automation", "paid_ads"] as const;

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Creates a fresh fictional lead through the exact same service the real intake form uses,
 * then redirects to a page showing its REAL audit-log timeline — not a scripted animation. */
export async function createDemoLeadAction(): Promise<void> {
  const db = getDb();
  const firstName = pick(FIRST_NAMES);
  const company = pick(COMPANIES);
  const email = `demo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@leadflow-demo.example`;
  const r = await createContact(db, await getActingUser(db), {
    firstName,
    lastName: "Demo",
    email,
    company,
    country: "US",
    leadSource: pick(SOURCES),
    serviceInterest: pick(SERVICES),
    budgetAmount: String(1000 + Math.floor(Math.random() * 12) * 500),
    tags: DEMO_TAG,
    notes: "[DEMO] Created from the /demo Demo Scenario page",
  });
  revalidatePath("/demo");
  if (r.status !== "created") {
    // Extremely unlikely (a fresh timestamped email colliding), but never silently fail.
    redirect(`/demo?error=${encodeURIComponent(r.status)}`);
  }
  redirect(`/demo?contactId=${r.contactId}`);
}

/** Deletes ONLY demo-tagged records — cascades to their opportunities, jobs, messages, audit logs, etc. */
export async function resetDemoDataAction(): Promise<void> {
  const db = getDb();
  const rows = await db.select({ id: contacts.id }).from(contacts).where(sql`${DEMO_TAG} = any(${contacts.tags})`);
  if (rows.length) await db.delete(contacts).where(inArray(contacts.id, rows.map((r) => r.id)));
  revalidatePath("/demo");
  redirect("/demo");
}

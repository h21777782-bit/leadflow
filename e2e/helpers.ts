import "../scripts/load-env";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Page } from "@playwright/test";
import { getDb } from "@/db/client";
import { contacts, jobs } from "@/db/schema";

/** Creates a fresh contact (+ New lead opportunity) through the real intake form, with a name unique to this test run so assertions never collide with leftover data from earlier runs. */
export async function createTestContact(page: Page, label: string): Promise<{ id: string; name: string; email: string }> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const name = `PwE2E-${label}-${suffix}`;
  const email = `pw-e2e-${label}-${suffix}@leadflow-e2e.example`;

  await page.goto("/contacts/new");
  await page.getByLabel("First name").fill(name);
  await page.getByLabel("Last name").fill("Test");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Lead source").selectOption("website_form");
  await page.getByRole("button", { name: "Create contact" }).click();
  await page.waitForURL(/\/contacts\/[0-9a-f-]+\?created=1/);

  const id = new URL(page.url()).pathname.split("/").pop()!;
  return { id, name: `${name} Test`, email };
}

/** Cascades to the contact's opportunities/jobs/audit logs — keeps repeated local
 * test runs from piling up Kanban cards indefinitely (which eventually pushes
 * cards outside the viewport and breaks the drag-and-drop test). */
export async function deleteTestContact(id: string): Promise<void> {
  await getDb().delete(contacts).where(eq(contacts.id, id));
}

/**
 * Inserts a failed job directly (bypassing the UI) so "Retry now" has something
 * deterministic to act on — the seeded demo failures get consumed as tests retry
 * them, so a test can't rely on one always being present.
 */
export async function seedFailedJob(contactId: string, error: string): Promise<{ id: string }> {
  const db = getDb();
  const [row] = await db
    .insert(jobs)
    .values({
      type: "crm.sync_contact",
      status: "failed",
      idempotencyKey: `e2e-${randomUUID()}`,
      attempts: 5,
      maxAttempts: 5,
      lastError: error,
      contactId,
      payload: {},
    })
    .returning({ id: jobs.id });
  return { id: row.id };
}

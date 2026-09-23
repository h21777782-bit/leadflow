import { expect, test } from "@playwright/test";
import { createTestContact, deleteTestContact, seedFailedJob } from "./helpers";

test("Retry now re-queues a failed job and it drops off the failed list", async ({ page }) => {
  // Seed our own failed job rather than relying on the finite set of demo-seeded
  // failures, which earlier test runs (or a previous run of this same test) may
  // have already consumed by retrying them.
  const { id: contactId } = await createTestContact(page, "retry");
  const errorText = `[e2e] synthetic failure ${Date.now()}`;

  try {
    await seedFailedJob(contactId, errorText);

    await page.goto("/failed-automations");
    const row = page.locator("tbody tr", { hasText: errorText });
    await expect(row).toBeVisible();
    const rowsBefore = await page.locator("tbody tr").count();

    await row.getByRole("button", { name: "Retry now" }).click();
    // retryJobAction calls revalidatePath("/failed-automations") as soon as it resolves,
    // which replaces the whole row list — so the per-row "Queued…" status text is only
    // ever on screen for a moment (a real, minor UX quirk, not something to chase in a
    // test). The row disappearing IS the reliable, observable success signal here: the
    // job moved from failed/retry_scheduled to pending, so it drops out of this list.
    await expect(page.locator("tbody tr", { hasText: errorText })).toHaveCount(0);
    await expect(page.locator("tbody tr")).toHaveCount(rowsBefore - 1);

    // Confirm it's not just a stale client cache — the server-persisted state agrees.
    await page.reload();
    await expect(page.locator("tbody tr", { hasText: errorText })).toHaveCount(0);
  } finally {
    await deleteTestContact(contactId);
  }
});

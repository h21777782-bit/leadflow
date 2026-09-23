import { expect, test } from "@playwright/test";
import { deleteTestContact } from "./helpers";

test("creating a contact through the real intake form redirects to the new lead", async ({ page }) => {
  const email = `pw-e2e-${Date.now()}@leadflow-e2e.example`;
  let contactId: string | undefined;

  try {
    await page.goto("/contacts/new");
    await page.getByLabel("First name").fill("Playwright");
    await page.getByLabel("Last name").fill("E2E");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Company").fill("E2E Testing Co");
    await page.getByLabel("Lead source").selectOption("website_form");
    await page.getByLabel("Budget (USD)").fill("2500");
    await page.getByRole("button", { name: "Create contact" }).click();

    await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]+\?created=1/);
    contactId = new URL(page.url()).pathname.split("/").pop();
    await expect(page.getByRole("status")).toHaveText(/Contact created/);
    await expect(page.getByText(email)).toBeVisible();
  } finally {
    // Keeps repeated local runs from piling up New-lead cards on the pipeline board.
    if (contactId) await deleteTestContact(contactId);
  }
});

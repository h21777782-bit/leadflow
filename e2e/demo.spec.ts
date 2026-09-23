import { expect, test } from "@playwright/test";

test("the demo scenario page creates a real lead and shows its real timeline", async ({ page }) => {
  await page.goto("/demo");

  await page.getByRole("button", { name: "Create a demo lead" }).click();
  await page.waitForURL(/\/demo\?contactId=[0-9a-f-]+/);

  await expect(page.getByRole("heading", { name: /^Timeline for/ })).toBeVisible();
  await expect(page.getByText("1. Duplicate check passed")).toBeVisible();
  await expect(page.getByText("2. Opportunity opened in the pipeline")).toBeVisible();
  await expect(page.getByText("3. Lead scored")).toBeVisible();

  await page.getByRole("link", { name: "Open full lead page →" }).click();
  await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]+$/);
});

test("reset demo data deletes every demo-tagged lead", async ({ page }) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Create a demo lead" }).click();
  await page.waitForURL(/\/demo\?contactId=/);

  await page.getByRole("button", { name: /Reset demo data/ }).click();
  await page.waitForURL(/\/demo$/);

  await expect(page.getByText("No demo leads right now")).toBeVisible();
  await expect(page.getByText("Demo leads (0)")).toBeVisible();
});

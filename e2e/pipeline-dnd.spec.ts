import { expect, test } from "@playwright/test";
import { createTestContact, deleteTestContact } from "./helpers";

test("dragging a card between Kanban columns moves and persists its stage", async ({ page }) => {
  // A dedicated, uniquely-named contact — picking "whatever's first in the column"
  // is fragile once other tests (or previous runs) leave same-named leftover cards.
  const { id, name: contactName } = await createTestContact(page, "dnd");

  try {
    await page.goto("/pipeline");

    const fromColumn = page.locator('section[aria-label="New lead"]');
    const toColumn = page.locator('section[aria-label="Attempting contact"]');
    await expect(fromColumn).toBeVisible();

    const card = fromColumn.locator("li[draggable=true]", { hasText: contactName });
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();

    // The board uses native HTML5 drag-and-drop (draggable + dataTransfer), which
    // locator.dragTo() doesn't reliably trigger — it needs a real mouse sequence
    // with an intermediate move so the browser fires dragstart/dragover, not just
    // a single hover-jump. See Playwright's manual drag-and-drop recipe.
    const sourceBox = await card.boundingBox();
    const targetBox = await toColumn.locator("ul").boundingBox();
    if (!sourceBox || !targetBox) throw new Error("Could not measure drag source/target");
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 10, { steps: 10 });
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 10 });
    await page.mouse.up();

    // Optimistic move should show up immediately in the target column…
    await expect(toColumn.locator("li[draggable=true]", { hasText: contactName })).toBeVisible();
    await expect(fromColumn.locator("li[draggable=true]", { hasText: contactName })).toHaveCount(0);

    // …and the server write must have actually persisted (not just optimistic UI).
    await page.reload();
    await expect(toColumn.locator("li[draggable=true]", { hasText: contactName })).toBeVisible();
    await expect(fromColumn.locator("li[draggable=true]", { hasText: contactName })).toHaveCount(0);
  } finally {
    // Keeps repeated local runs from piling up Kanban cards indefinitely (which eventually
    // pushes cards outside the viewport and makes the boundingBox-based drag unreliable).
    await deleteTestContact(id);
  }
});

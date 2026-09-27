import { expect, test } from "@playwright/test";

import { registerViaMagicLink } from "./helpers/auth";
import { seedDive, seedGarminImport, uniqueTestEmail } from "./helpers/db";

// End-to-end coverage for issue #18: "Merge dives should preselect props smarter". A field with
// data on either side should be preselected over the same field with no data on the other side,
// and between two populated numeric readings the more precise one should be preselected.

const PASSWORD = "a-long-enough-password-123";

test.describe("Garmin merge field preselection", () => {
  test("prefers whichever side has data, and the more precise numeric reading when both do", async ({ page }) => {
    const email = uniqueTestEmail("garmin-merge");
    await registerViaMagicLink(page, email, PASSWORD);

    // The "existing dive" (merge target): a rounder, hand-typed max depth (stored in the same
    // numeric(5,2) column a real logged dive would use), no buddy recorded, and a real notes
    // entry.
    await seedDive(email, {
      title: "Existing dive",
      occurredAt: "2026-08-14T09:15:00.000Z",
      maxDepth: 24,
      notes: "Written in the paper logbook.",
    });

    // The "reviewed Garmin import": a more precise dive-computer depth reading, a buddy recorded,
    // and no notes.
    const { importId } = await seedGarminImport(email, {
      title: "Garmin import",
      occurredAt: "2026-08-14T09:15:00.000Z",
      maxDepth: 23.7,
      buddy: "Sam Diver",
      notes: "",
    });

    await page.goto(`/settings/integrations/garmin/imports/${importId}`);
    await page.getByRole("button", { name: "Merge into existing dive" }).click();
    await expect(page.getByRole("heading", { name: "Merge Garmin import into existing dive" })).toBeVisible();
    await page.getByRole("button", { name: "Choose surviving fields" }).click();
    await expect(page.getByRole("heading", { name: "Choose surviving fields" })).toBeVisible();

    // Both sides have a max depth -- the more precise Garmin reading (23.7, one decimal) wins
    // over the rounder hand-typed one (24, zero decimals). Values are asserted as trimmed text
    // ("24", not "24.00") too: numeric(5,2) always stores a fixed two-decimal scale, so a
    // formatting bug here would silently defeat the precision comparison this test guards.
    const maxDepthRow = page.locator("div.grid", { has: page.locator('input[name="import-merge-maxDepth"]') });
    await expect(maxDepthRow.getByText("23.7", { exact: true })).toBeVisible();
    await expect(maxDepthRow.getByText("24", { exact: true })).toBeVisible();
    const maxDepthRadios = page.locator('input[name="import-merge-maxDepth"]');
    await expect(maxDepthRadios.nth(0)).toBeChecked();
    await expect(maxDepthRadios.nth(1)).not.toBeChecked();

    // Only the import has a buddy -- it wins even though it isn't a numeric/precision field.
    const buddyRadios = page.locator('input[name="import-merge-buddy"]');
    await expect(buddyRadios.nth(0)).toBeChecked();
    await expect(buddyRadios.nth(1)).not.toBeChecked();

    // Only the existing dive has notes -- the target side wins here.
    const notesRadios = page.locator('input[name="import-merge-notes"]');
    await expect(notesRadios.nth(0)).not.toBeChecked();
    await expect(notesRadios.nth(1)).toBeChecked();
  });
});

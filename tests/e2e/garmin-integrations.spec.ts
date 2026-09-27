import { expect, test } from "@playwright/test";

import { registerViaMagicLink } from "./helpers/auth";
import { seedGarminIntegration, uniqueTestEmail } from "./helpers/db";

const PASSWORD = "a-long-enough-password-123";

test("integrations page explains Garmin duplicate/reimport behavior", async ({ page }) => {
  await registerViaMagicLink(page, uniqueTestEmail("garmin-ui"), PASSWORD);

  await page.goto("/settings/integrations");
  await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Garmin" })).toBeVisible();
  await expect(page.getByLabel("Garmin email")).toBeVisible();
  await expect(page.getByLabel("Garmin password")).toBeVisible();
  await expect(page.getByText(/Garmin sync imports raw FIT files directly/i)).toBeVisible();
});

// Issue #24: the fetch dialog offers an unbounded "All time" mode alongside the recent-days window.
test("fetch dialog offers an All time mode that replaces the recent-days input", async ({ page }) => {
  const email = uniqueTestEmail("garmin-all");
  await registerViaMagicLink(page, email, PASSWORD);
  await seedGarminIntegration(email);

  await page.goto("/settings/integrations");
  await page.getByRole("button", { name: "Fetch Garmin activities" }).click();
  await expect(page.getByRole("heading", { name: "Fetch Garmin activities" })).toBeVisible();
  await expect(page.getByLabel("Recent days to check")).toBeVisible();

  await page.getByRole("radio", { name: "All time" }).click();
  await expect(page.getByLabel("Recent days to check")).toHaveCount(0);
  await expect(page.getByText(/every dive workout in your Garmin history/i)).toBeVisible();

  const submit = page.getByRole("button", { name: "Fetch activities" });
  await submit.click();
  await expect(page.getByText(/temporarily unavailable/i)).toBeVisible();
});

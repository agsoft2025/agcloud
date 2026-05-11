import { expect, test } from "@playwright/test";

test("shows the home page starter content", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /agcloud frontend starter/i })).toBeVisible();
  await expect(page.getByText(/this app uses a backend api and livekit/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /login/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /connect to livekit/i })).toBeVisible();
});

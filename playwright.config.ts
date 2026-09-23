import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests against a real running app + real Postgres (no mocking).
 * Reuses whatever dev server is already on PLAYWRIGHT_BASE_URL / :3500 — these
 * tests mutate real rows (Kanban stage, new contacts, demo leads), so they are
 * meant to be run against a disposable dev database, not CI/production data.
 */
const PORT = process.env.PLAYWRIGHT_PORT ?? "3500";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // shared DB — avoid cross-test row contention
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});

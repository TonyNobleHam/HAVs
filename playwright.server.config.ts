import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Inherited by both web-server processes and workers; never touches real accounts.
process.env.HAVS_E2E_FIXTURE_FILE ??= join(
  tmpdir(),
  `havs-browser-fixtures-${randomUUID()}.json`,
);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "server-workspace.spec.ts",
  outputDir: "test-results/server",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5174",
    viewport: { width: 1440, height: 1100 },
    launchOptions: {
      executablePath:
        process.env.CHROMIUM_PATH ||
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node e2e/start-test-server.mjs",
      url: "http://127.0.0.1:3002/api/health",
      reuseExistingServer: false,
      timeout: 30_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
    {
      command: "npm run dev -- --port 5174 --strictPort",
      url: "http://127.0.0.1:5174",
      env: { VITE_API_TARGET: "http://127.0.0.1:3002" },
      reuseExistingServer: false,
      timeout: 30_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
  ],
});

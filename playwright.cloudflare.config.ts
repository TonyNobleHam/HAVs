import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HAVS_E2E_BASE_URL = "http://127.0.0.1:8788";
process.env.HAVS_E2E_FIXTURE_FILE ??= join(
  tmpdir(),
  `havs-cloudflare-browser-fixtures-${randomUUID()}.json`,
);

export default defineConfig({
  testDir: "./e2e",
  // Run the same browser contract against Node/SQLite and Workers/D1.
  testMatch: ["server-workspace.spec.ts", "cloudflare-routing.spec.ts"],
  outputDir: "test-results/cloudflare",
  globalTeardown: "./e2e/cloudflare-test-teardown.mjs",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.HAVS_E2E_BASE_URL,
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
  webServer: {
    command: "npm run build && node e2e/start-cloudflare-test-server.mjs",
    // The HTTP listener opens before D1 fixtures finish; wait for both explicitly.
    wait: { stdout: /HAVS Cloudflare browser fixtures ready/ },
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});

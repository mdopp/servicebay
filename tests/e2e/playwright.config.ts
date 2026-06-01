import { defineConfig, devices } from '@playwright/test'

/**
 * Headless browser-verify harness for the autoloop Box-Verify stage (#1473).
 *
 * Drives the ServiceBay portal UI in a real (headless) Chromium against the
 * `:dev` box, so a path-mandated frontend unit gets *verified* instead of
 * *deferred*. Runs from a fresh sub-agent with no `DISPLAY`.
 *
 * Invocation (from repo root):
 *   npx playwright test --config tests/e2e/playwright.config.ts
 *
 * Target + credentials come from the environment so nothing box-specific is
 * committed (memory `reference_mcp_servicebay_access`):
 *   SB_BOX_URL   default http://192.168.178.100:5888  (the LAN box)
 *   SB_USERNAME  read fresh off the box (rotates every install)
 *   SB_PASSWORD  read fresh off the box (rotates every install)
 *
 * The Playwright browser binary is resolved deterministically from the pinned
 * `@playwright/test` devDependency (1.60.0 → chromium-1223), not the npx cache.
 */
const baseURL = process.env.SB_BOX_URL ?? 'http://192.168.178.100:5888'

export default defineConfig({
  testDir: '.',
  // Specs are `*.e2e.ts` so vitest's `*.{test,spec}` glob never collects them.
  testMatch: '**/*.e2e.ts',
  // These run against a real box; never spread the load across the CI matrix.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // A box that hasn't finished flipping to `:dev` can be slow; keep the
  // per-test budget generous but bounded.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'tests/e2e/.report/results.json' }]],
  use: {
    baseURL,
    headless: true,
    // The `:dev` box serves over plain http on the LAN with a self-signed
    // cert when proxied; don't let TLS abort the verify.
    ignoreHTTPSErrors: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})

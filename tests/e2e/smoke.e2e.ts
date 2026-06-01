import { test, expect } from '@playwright/test'
import { login, assertSurface } from './helpers/portal'

/**
 * Smoke verify (#1473): prove the headless harness can authenticate against the
 * `:dev` box and assert on a rendered UI surface. This is the template a
 * Box-Verify spec follows for a path-mandated frontend unit.
 *
 * Run from repo root, headless, no DISPLAY:
 *   SB_USERNAME=… SB_PASSWORD=… npx playwright test --config tests/e2e/playwright.config.ts
 */
test('authenticate and load the services dashboard', async ({ page }) => {
  await login(page)
  await assertSurface(page, {
    path: '/services',
    urlPattern: /\/services\b/,
  })
  // A named surface is reachable post-auth — the dashboard chrome rendered.
  await expect(page.locator('body')).toBeVisible()
})

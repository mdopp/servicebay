import { expect, type Page } from '@playwright/test'

/**
 * Reusable portal-driving helpers for the headless browser-verify harness (#1473).
 *
 * These let a Box-Verify spec authenticate against the `:dev` box, navigate,
 * and assert on rendered state — without re-deriving the auth flow per spec.
 */

/**
 * Admin credentials read fresh from the environment. They rotate every install
 * (memory `reference_mcp_servicebay_access`), so the caller must export them
 * from the box at verify time — never hard-code or memorize the value.
 */
export function credentials(): { username: string; password: string } {
  const username = process.env.SB_USERNAME
  const password = process.env.SB_PASSWORD
  if (!username || !password) {
    throw new Error(
      'SB_USERNAME / SB_PASSWORD must be set (read fresh off the box: ' +
        '~/.config/containers/systemd/servicebay.container). See memory ' +
        'reference_mcp_servicebay_access.',
    )
  }
  return { username, password }
}

/**
 * Drive the real login form and land on the dashboard.
 *
 * Submitting the on-page form (rather than POSTing the API directly) means the
 * browser sends a same-origin `Origin` header, satisfying the backend CSRF
 * guard the API path requires.
 */
export async function login(page: Page): Promise<void> {
  const { username, password } = credentials()
  await page.goto('/login')
  // The login form uses unassociated <label> elements (no for/id), so match by placeholder.
  await page.getByPlaceholder('System username').fill(username)
  await page.getByPlaceholder('System password').fill(password)
  await page.getByRole('button', { name: 'Login' }).click()
  // The login handler pushes to /services on success.
  await page.waitForURL(/\/(services|dashboard)\b/, { timeout: 30_000 })
}

/**
 * Assert a named UI surface rendered. `urlPattern` guards the route landed and
 * `heading` (optional) pins a visible heading/text on it. Returns once both hold.
 */
export async function assertSurface(
  page: Page,
  opts: { path: string; urlPattern: RegExp; heading?: string | RegExp },
): Promise<void> {
  await page.goto(opts.path)
  await expect(page).toHaveURL(opts.urlPattern, { timeout: 30_000 })
  if (opts.heading) {
    await expect(
      page.getByRole('heading', { name: opts.heading }).first(),
    ).toBeVisible({ timeout: 15_000 })
  }
}

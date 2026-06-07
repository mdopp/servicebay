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
 * The public domain the box's SSO services live under (e.g. `dopp.cloud`), read
 * fresh from the environment. Services are reached at `https://<svc>.<domain>/`
 * and Authelia's portal at `https://auth.<domain>/`. Must be a real subdomain
 * host — the bare apex is Authelia default-deny (403, no identity), only
 * `*.<domain>` is `one_factor` (memory `reference_authelia_apex_deny_vs_wildcard`).
 */
export function publicDomain(): string {
  const domain = process.env.SB_PUBLIC_DOMAIN
  if (!domain) {
    throw new Error(
      'SB_PUBLIC_DOMAIN must be set to the box public domain (e.g. dopp.cloud) ' +
        'so the SSO login smoke can reach <svc>.<domain> and auth.<domain>. ' +
        'Read it off the box config (reverseProxy.publicDomain).',
    )
  }
  return domain
}

/**
 * Drive the real Authelia login portal for an SSO-protected service and assert
 * an authenticated landing back on the service (#1561).
 *
 * Flow — the genuine end-user SSO path:
 *   1. navigate to the service subdomain (`https://<svc>.<domain>/`);
 *   2. Authelia forward-auth / the OIDC client bounces an anonymous visitor to
 *      the Authelia portal (`auth.<domain>`) — if it does NOT, the service is
 *      either unprotected or already authed; we still assert we did not land on
 *      an error/401/403;
 *   3. fill + submit the Authelia first-factor form;
 *   4. assert we are redirected BACK onto the service host (not parked on the
 *      auth portal, not a 401/403/5xx) — i.e. login actually succeeded.
 *
 * A failed login (wrong redirect, stuck on the portal, OAuth error, error page)
 * throws — making the spec RED. This is the assertion #1559 needed: a reinstall
 * that breaks every login can no longer ship a green verify.
 *
 * Credentials are the box admin LLDAP user (`SB_USERNAME`/`SB_PASSWORD`), the
 * same fresh-off-the-box creds the portal helper uses.
 */
export async function ssoLogin(
  page: Page,
  service: string,
): Promise<void> {
  const { username, password } = credentials()
  const domain = publicDomain()
  const serviceHost = `${service}.${domain}`
  const authHost = `auth.${domain}`
  const serviceUrl = `https://${serviceHost}/`

  // 1. Hit the protected service as an anonymous visitor.
  const resp = await page.goto(serviceUrl, { waitUntil: 'domcontentloaded' })
  // A transport-level failure (DNS / cert / upstream down) is an immediate fail.
  if (resp && resp.status() >= 500) {
    throw new Error(`SSO[${service}]: ${serviceHost} returned HTTP ${resp.status()} before login`)
  }

  // 2. We should be on the Authelia portal (forward-auth or OIDC redirect). If
  //    the page never reached the portal AND we're not already on the service,
  //    something redirected us somewhere unexpected.
  const onAuthPortal = () => new URL(page.url()).host === authHost
  const onService = () => new URL(page.url()).host === serviceHost

  if (onAuthPortal()) {
    // 3. Drive the Authelia first-factor form. Authelia's React portal labels
    //    its inputs by id; match on the accessible username/password fields.
    const userField = page
      .getByLabel(/username/i)
      .or(page.locator('input#username'))
      .first()
    const passField = page
      .getByLabel(/password/i)
      .or(page.locator('input#password'))
      .first()
    await userField.fill(username)
    await passField.fill(password)
    await page
      .getByRole('button', { name: /sign in|log in|login/i })
      .first()
      .click()

    // 4. Authelia must redirect back off its own portal onto the service.
    await page.waitForURL(
      (url) => new URL(url).host !== authHost,
      { timeout: 30_000 },
    )
  }

  // Final assertion: we landed on the service host (authenticated), NOT parked
  // on the auth portal and NOT on an OAuth/error surface. Staying on the portal
  // or a *.error.* host means the login failed.
  if (onAuthPortal()) {
    throw new Error(
      `SSO[${service}]: still on the Authelia portal (${page.url()}) after submitting credentials — login did not complete`,
    )
  }
  if (!onService()) {
    throw new Error(
      `SSO[${service}]: after login landed on ${page.url()}, not the service host ${serviceHost} — OIDC/redirect chain is broken`,
    )
  }
  // The service rendered something other than an Authelia/OAuth error.
  const errorIndicator = page.getByText(
    /invalid_client|server_error|access_denied|authentication failed|forbidden|not authorized/i,
  )
  await expect(errorIndicator).not.toBeVisible({ timeout: 5_000 })
}

/**
 * The SSO services to smoke-login, in order. Defaults to the OIDC-backed apps
 * the box ships (`vault`/`photos`/`books`, mirroring `ssoVerify.ts`
 * `OIDC_CLIENT_SUBDOMAINS`); override per box via `SB_SSO_SERVICES` (a
 * comma-separated subdomain list) so an install with a different service set
 * verifies exactly what it has.
 */
export function ssoServices(): string[] {
  const raw = process.env.SB_SSO_SERVICES
  if (raw && raw.trim()) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return ['vault', 'photos', 'books']
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

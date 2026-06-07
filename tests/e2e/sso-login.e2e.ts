import { test } from '@playwright/test'
import { ssoLogin, ssoServices, publicDomain } from './helpers/portal'

/**
 * Per-service SSO login smoke (#1561) — the verify-coverage gap that let a
 * `wipe-configs` reinstall ship green while EVERY login was broken (#1559).
 *
 * Unit tests can't cover functional login; `service: up` / "page renders" both
 * pass on a box where the Authelia/OIDC handshake is dead. This spec drives the
 * REAL end-user login flow per SSO-protected service against the `:dev` box:
 *
 *   navigate to <svc>.<domain>  →  follow the Authelia redirect  →
 *   authenticate  →  assert an authenticated landing back on the service.
 *
 * A broken login on ANY installed service makes this spec RED — so the
 * Box-Verify stage can no longer green-light a reinstall that broke logins.
 *
 * It reuses the #1473 harness (Playwright config + the portal helpers); it does
 * NOT build a parallel framework. The service set is `SB_SSO_SERVICES` (default
 * the OIDC-backed apps that mirror `ssoVerify.ts` `OIDC_CLIENT_SUBDOMAINS`).
 *
 * Invocation (Box-Verify, from repo root, against the `:dev`-flipped box):
 *   SB_PUBLIC_DOMAIN=dopp.cloud \
 *   SB_USERNAME=<admin-user> SB_PASSWORD=<admin-pass> \
 *   SB_SSO_SERVICES=vault,photos,books \
 *   npm run test:e2e -- sso-login
 *
 * Authelia note: the login flow targets a SUBDOMAIN (<svc>.<domain> /
 * auth.<domain>), never the bare apex — the apex is default-deny with no
 * identity (memory `reference_authelia_apex_deny_vs_wildcard`).
 */

const services = ssoServices()

test.describe('SSO login smoke per service (#1561)', () => {
  test.beforeAll(() => {
    // Surface the resolved target up front so a verify run logs exactly what it
    // exercised — a green run that silently tested nothing is the failure mode
    // this issue exists to prevent.
    console.log(
      `SSO login smoke: domain=${publicDomain()} services=[${services.join(', ')}]`,
    )
  })

  for (const service of services) {
    test(`login succeeds through Authelia for ${service}`, async ({ page }) => {
      await ssoLogin(page, service)
    })
  }
})

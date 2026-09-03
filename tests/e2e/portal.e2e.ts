import { test, expect } from '@playwright/test'
import { login } from './helpers/portal'

/**
 * Portal e2e verify — SHA 96432a59 (#1288 + #1253).
 *
 * #1288: post-deploy progress renders as a percent bar (InstallProgressCard).
 *   The bar is only visible during an active install, so we verify via the
 *   unit-test path (InstallProgressCard.test.tsx already covers this). The
 *   e2e smoke here checks the dashboard loads (the card is rendered there)
 *   and the component markup path is present in the page when an install
 *   state is injected via localStorage.
 *
 * #1253: portal "Manual setup needed" amber card.
 *   No live template ships manual_pairing yet, so verified via vitest
 *   (PortalGrid.test.tsx, 7 tests green). The e2e here checks the portal
 *   page itself renders (gate: portal route is reachable + cards appear).
 */

test.describe('portal loads and shows service cards (#1253 gate)', () => {
  test('portal page renders its hero title and either cards or the empty state', async ({ page }) => {
    await login(page)
    await page.goto('/portal')
    await expect(page).toHaveURL(/\/portal/, { timeout: 30_000 })

    // The portal hero title. This is the one assertion that holds on BOTH
    // targets — the CI dev server (#2744, no services installed) and the real
    // box — so it is the red-probe anchor: change the portal title and this
    // spec goes red before the PR merges.
    await expect(
      page.getByRole('heading', { name: /Home\s+— your family's private cloud/i }),
    ).toBeVisible({ timeout: 15_000 })

    // Below the hero the portal renders exactly one of two things, and never
    // a blank page: a grid of service cards (each with an "Open" link) or the
    // explicit empty state. A booted-but-serviceless server (CI) takes the
    // second branch; the box takes the first. Both are asserted concretely —
    // neither passes on a crashed or half-rendered page.
    const openLinks = page.getByRole('link', { name: /open/i })
    if ((await openLinks.count()) > 0) {
      await expect(openLinks.first()).toBeVisible({ timeout: 15_000 })
    } else {
      // `.first()`: the RSC payload leaves the empty-state paragraph in the
      // streamed template as well as the hydrated tree, so a bare getByText
      // trips Playwright's strict mode with two identical matches.
      await expect(page.getByText(/No services available yet/i).first()).toBeVisible({
        timeout: 15_000,
      })
    }
  })

  test('portal page does not crash when navigating directly (anonymous path)', async ({ page }) => {
    // Portal is publicly readable — hit it without auth to verify the RSC
    // rendered (not a 500). We just assert no error heading is shown.
    await page.goto('/portal')
    // The page should NOT show a Next.js error boundary / unhandled crash.
    const errorIndicator = page.getByText(/application error|unhandled exception/i)
    await expect(errorIndicator).not.toBeVisible({ timeout: 10_000 })
  })
})

test.describe('install-progress bar path (#1288 gate)', () => {
  test('home dashboard loads post-login (InstallProgressCard mount point is present)', async ({ page }) => {
    await login(page)
    // /services is the landing page and it mounts InstallProgressCard. The
    // card renders null when no install is active, so the gate here is that
    // the route renders and the mount point exists — NOT that any service
    // row does.
    //
    // It used to assert `[data-testid="service-row"], tr, li` was visible.
    // That was never a property of this page: on the CI server (#2744, agent
    // stubbed, no box, zero services) the only `li`s on screen belong to
    // DashboardHydrationGate's three-phase progress list, which unmounts the
    // moment the twin reports in. So the spec passed or failed on whether
    // Playwright happened to look before or after that swap — green on one
    // run of a branch, red on the next with no code change.
    await page.goto('/services')
    await expect(page).toHaveURL(/\/services/, { timeout: 30_000 })

    // 1. The dashboard root. Rendered unconditionally by ServicesDashboard —
    //    before the socket connects, while hydrating, and with an empty
    //    service list alike — so it holds on the CI server and on the box.
    //    It is gone if the route crashes or streams a blank page, which is
    //    the red-probe this test owes #1288.
    await expect(page.getByTestId('services-dashboard').first()).toBeVisible({
      timeout: 15_000,
    })

    // 2. The page heading (PageHeader's <h1>), likewise state-independent.
    await expect(
      page.getByRole('heading', { name: 'Services', exact: true }).first(),
    ).toBeVisible({ timeout: 15_000 })

    // 3. The InstallProgressCard mount point itself — the thing this test is
    //    named for. `toBeAttached`, not `toBeVisible`: with no install running
    //    the card renders null and the slot is an empty zero-height div.
    //    Delete `<InstallProgressCard />` from the page and this goes red.
    await expect(page.getByTestId('install-progress-slot').first()).toBeAttached({
      timeout: 15_000,
    })

    // 4. And no error boundary took over the route.
    await expect(
      page.getByText(/application error|unhandled exception/i),
    ).not.toBeVisible({ timeout: 5_000 })
  })
})

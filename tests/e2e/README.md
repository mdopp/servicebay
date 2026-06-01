# Headless browser-verify harness (#1473)

A reusable Playwright harness so the autoloop **Box-Verify** stage can drive the
ServiceBay portal UI in a real (headless) browser against the `:dev` box and
assert on rendered state — instead of parking path-mandated frontend units on
"browser /verify unavailable."

## What's here

- `playwright.config.ts` — targets the box (`SB_BOX_URL`), headless, single worker,
  specs matched as `**/*.e2e.ts`.
- `helpers/portal.ts` — `login()` (drives the real login form so the same-origin
  `Origin` header satisfies the backend CSRF guard) and `assertSurface()`.
- `smoke.e2e.ts` — the template: authenticate, then assert a named surface loads.

## Why it's deterministic

`@playwright/test` is pinned to `1.60.0`, which maps to the **chromium-1223**
browser build already present at `~/.cache/ms-playwright/chromium-1223`. The
binary resolves from that cache via the pinned dependency — **not** from a
transient `~/.npm/_npx/<hash>` dir that can be garbage-collected.

## Invocation

From the repo root. Read the box admin credentials **fresh** off the box
(`~/.config/containers/systemd/servicebay.container` — they rotate every install;
see memory `reference_mcp_servicebay_access`):

```bash
SB_BOX_URL=http://192.168.178.100:5888 \
SB_USERNAME=<admin-user> \
SB_PASSWORD=<admin-pass> \
npm run test:e2e
```

Runs headless (no `DISPLAY`). `SB_BOX_URL` defaults to `http://192.168.178.100:5888`.

## Adding a verify spec for a frontend unit

Copy `smoke.e2e.ts`, name it `<feature>.e2e.ts`, and assert on the specific
surface the merged change touches:

```ts
import { test } from '@playwright/test'
import { login, assertSurface } from './helpers/portal'

test('my feature renders', async ({ page }) => {
  await login(page)
  await assertSurface(page, { path: '/settings/networking', urlPattern: /\/settings\/networking\b/ })
})
```

A failing browser assertion is a **red verify**, not a deferral.

## Notes

- Specs are `*.e2e.ts` (outside vitest's `*.{test,spec}` glob) and `tests/e2e/**`
  is excluded in `vitest.config.ts`, so `npm test` never runs them under jsdom.
- This harness only drives the UI; it does not mutate box state. It's meant for
  the `:dev`-flipped box during Box-Verify (see the autoloop box-verify stage).

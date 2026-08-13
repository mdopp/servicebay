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

`@playwright/test` is pinned (see `package.json`), which maps to the chromium
build present under `~/.cache/ms-playwright/`. The binary resolves from that
cache via the pinned dependency — **not** from a transient `~/.npm/_npx/<hash>`
dir that can be garbage-collected.

## Sandbox setup — one command, no root (#2445)

Chromium used to be considered unlaunchable here (#1930): the binary is in the
cache, but the system shared libraries it links against are missing —

```
chrome-headless-shell: error while loading shared libraries:
libnspr4.so: cannot open shared object file: No such file or directory
```

That was never a hard limit, only an unwritten setup. Provision it once:

```bash
npm run browser:sandbox      # idempotent; exit 0 = a real page load rendered visible text
```

`scripts/provision-browser-sandbox.ts` apt-extracts the missing libraries and
`fonts-dejavu-core` into `~/.cache/servicebay-browser-sandbox` (apt with its
state/cache dirs redirected + `dpkg-deb -x`; **no root, no sudo**), generates a
`fonts.conf`, then probes an actual page load and asserts the text renders with
non-zero height. `playwright.config.ts` calls `applyBrowserSandboxEnv()` at
import, so `npm run test:e2e` picks the sysroot up with no extra env.

**Fonts are the non-obvious half.** With no font installed Chromium still lays
the page out, but every text node measures **zero height** — Playwright then
reports every text element as `hidden` and screenshots come back as empty
boxes. It looks exactly like a CSS/visibility bug. If you ever see that, the
sysroot's `fonts.conf` is not being found; re-run with `--force`.

Flags: `--check` (verify only, never touch the network), `--force`
(re-provision), `--print-env` (`eval "$(npm run -s browser:sandbox -- --print-env)"`).

An API-level smoke test is still the right tool when the assertion is really
about a payload rather than a rendering — e.g.
`packages/frontend/src/app/api/system/disk-import/status/route.test.ts` asserts
the routing-tree shape the disk-import page binds to. But it is no longer a
*substitute* for a browser check: a rendered-DOM criterion gets a rendered DOM.

## Invocation

From the repo root. The box admin credentials are **operator-supplied** — export
them yourself (they rotate every install). An automated run (autoloop box-verify)
must **not** derive them from the box; without them it skips the browser layer and
reports that criterion as owed (#2532).

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

- `locator.fill('')` does **not** clear a React controlled input (`fill('x')`
  does; `press('Control+a')` then `press('Backspace')` does). A spec that clears
  a field with `fill('')` silently asserts nothing.
- Specs are `*.e2e.ts` (outside vitest's `*.{test,spec}` glob) and `tests/e2e/**`
  is excluded in `vitest.config.ts`, so `npm test` never runs them under jsdom.
- This harness only drives the UI; it does not mutate box state. It's meant for
  the `:dev`-flipped box during Box-Verify (see the autoloop box-verify stage).

import type { NextConfig } from "next";

// We do NOT enable Next's standalone output: we ship our own custom HTTP
// server (`server.ts`) that wires Socket.IO, MCP, PTY sessions, and the SSH
// pool around `next()`. Standalone is incompatible with that pattern under
// Next 16. The runtime container instead bundles `server.ts` to CJS via
// `scripts/build-server.mjs` and runs it under plain `node`.
//
// #905 migrated the production build from webpack to Turbopack (Next 16
// default) by splitting logger.ts into a client-safe stub (logger-client.ts)
// that the frontend imports, and the full SQLite-backed logger that stays
// server-only. Previously a webpack `resolve.fallback` hack was needed
// because the client bundle transitively pulled `fs`/`path`/`better-sqlite3`.
//
// Known Next 16.2.4 quirk still worked around at build time:
// - `routes-manifest.json` omits `onMatchHeaders` → patched in
//   `scripts/patch-routes-manifest.mjs` (otherwise `app.prepare()` throws
//   "Cannot read properties of undefined (reading 'map')" in `setupFsCheck`).
// - tsx + AsyncLocalStorage → render path crashes with `forceStatic`
//   undefined. Avoided entirely by running compiled CJS through node.
const nextConfig: NextConfig = {
  serverExternalPackages: ['socket.io', 'node-pty', 'ssh2', 'better-sqlite3'],
  // Compile workspace packages from TypeScript source. #762 (Phase 3.1)
  // extracted @servicebay/api-client; without this Next would try to
  // load its "main" as JS at runtime.
  transpilePackages: ['@servicebay/api-client', '@servicebay/frontend', '@servicebay/backend'],
  // The dev-only "Issues" indicator defaults to bottom-left, where it overlaps
  // the sidebar's GitHub link. Move it to bottom-right so it sits in empty
  // canvas space. Production builds never render the indicator.
  devIndicators: {
    position: 'bottom-right',
  },
  // `/` used to redirect to `/services` — removed in #802/#803 when the
  // Overview Dashboard landed at the root path. If you're hunting for
  // the redirect, it's now a real page: src/app/(dashboard)/page.tsx.
  //
  // #2555: the Settings redirects are CONFIG redirects, not redirect-only
  // `page.tsx` server components. A page-level `redirect()` under
  // `settings/layout.tsx` is resolved inside React on the client (the root
  // `loading.tsx` makes the document flush 200 before the page renders), where
  // it competes with the layout's own async config load. That crashed `/settings`
  // outright — see the comment in `settings/layout.tsx`. A config redirect is a
  // real 307 answered before any render, so there is no React involved at all.
  // Keep the `/settings` destination in sync with `DEFAULT_GROUP` in
  // `src/app/(dashboard)/settings/_lib/ia.ts` — `tests/frontend/settings-redirects.test.ts`
  // fails if they drift. It is spelled out literally because Next evaluates
  // `redirects()` from the compiled config in its own scope: a module-level
  // const referenced in here is `undefined` at call time, and `ia.ts` can't be
  // imported (it pulls in `lucide-react`).
  async redirects() {
    return [
      // Settings lands on the first cross-cutting group.
      { source: '/settings', destination: '/settings/network-domain', permanent: false },
      // Services left Settings (spec §4.4 / §8) — old bookmarks still resolve.
      { source: '/settings/services', destination: '/services', permanent: false },
      { source: '/settings/services/:name', destination: '/services/:name', permanent: false },
    ];
  },
};

export default nextConfig;

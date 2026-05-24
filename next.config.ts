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
};

export default nextConfig;

import type { NextConfig } from "next";

// We do NOT enable Next's standalone output: we ship our own custom HTTP
// server (`server.ts`) that wires Socket.IO, MCP, PTY sessions, and the SSH
// pool around `next()`. Standalone is incompatible with that pattern under
// Next 16. The runtime container instead bundles `server.ts` to CJS via
// `scripts/build-server.mjs` and runs it under plain `node`.
//
// Two known Next 16.2.4 quirks ServiceBay works around at build time:
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
  async redirects() {
    return [
      {
        source: '/',
        destination: '/services',
        permanent: false,
      },
    ];
  },
  // `src/lib/logger.ts` is imported by both server and client code and lazily
  // `require()`s `better-sqlite3` / `fs` / `path` only on the server. Webpack
  // resolves those `require` calls statically, so without this fallback the
  // client bundle fails to compile (`Module not found: Can't resolve 'fs'`).
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        fs: false,
        path: false,
        'better-sqlite3': false,
      };
    }
    return config;
  },
};

export default nextConfig;

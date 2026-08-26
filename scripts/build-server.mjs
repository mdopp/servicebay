#!/usr/bin/env node
// Compile the custom server (server.ts + all imported lib code) to a single
// CommonJS bundle that runs under plain `node`. This sidesteps a Next 16 +
// tsx incompatibility: tsx's loader hooks cause Next's AsyncLocalStorage
// modules (work-async-storage, work-unit-async-storage) to be imported into
// multiple module instances, so `getStore()` returns undefined inside render
// and every page render crashes with "Cannot read properties of undefined
// (reading 'forceStatic')". Running compiled CJS through node gives a single
// instance and the render path works.
//
// Native modules and modules that don't bundle cleanly are kept external —
// node loads them at runtime.
//
// The options live in `serverBundleOptions()` rather than inline so a test can
// bundle a module with the EXACT production config and assert the bundle's
// behaviour, not just the source's (#2650 — the assist catalog was blind on the
// box for weeks while every source-level test stayed green).

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// External: native bindings + anything large enough that bundling is
// counterproductive. We don't bundle `next` because (a) it's huge and (b) we
// need a single shared instance at runtime.
//
// FOOTGUN, do not add a package here casually (#2650): an external is resolved
// by *node at runtime*, from `/app/node_modules`, NOT by esbuild from the
// importer's directory. A bundled dependency that carries its own pinned copy
// of that package (npm keeps it under `node_modules/<dep>/node_modules/…`)
// therefore silently gets the ROOT version instead — a different major, with a
// different API. `js-yaml` used to be on this list: `gray-matter` bundles
// against js-yaml **3** (`yaml.safeLoad`), the root has **4** (where safeLoad
// throws "removed in js-yaml 4"), so every frontmatter parse in the shipped
// bundle failed while the same code read straight from source was fine.
export const SERVER_BUNDLE_EXTERNAL = [
  'next',
  'next/*',
  'react',
  'react-dom',
  'react/*',
  'react-dom/*',
  'better-sqlite3',
  'node-pty',
  'ssh2',
  'socket.io',
  'socket.io-client',
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/sdk/*',
  'jose',
  '@xterm/xterm',
  '@xterm/addon-fit',
  'mustache',
  'nodemailer',
  'semver',
  'zod',
  'uuid',
  'diff',
  'elkjs',
  '@xyflow/react',
  'react-markdown',
  'react-simple-code-editor',
  'react-highlight-words',
  'prismjs',
  'lucide-react',
];

/**
 * The esbuild options the shipped server bundle is built with. `overrides` lets
 * a caller swap the entry point / outfile (a test bundles one module instead of
 * `server.ts`) while keeping every setting that decides HOW the code is
 * compiled — format, target, platform, externals, aliases — identical.
 *
 * @param {import('esbuild').BuildOptions} [overrides]
 * @returns {import('esbuild').BuildOptions}
 */
export function serverBundleOptions(overrides = {}) {
  return {
    entryPoints: [path.join(repoRoot, 'packages', 'backend', 'src', 'server.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(repoRoot, 'dist-server', 'server.cjs'),
    external: SERVER_BUNDLE_EXTERNAL,
    // Resolve the `@/*` alias used inside src/**/*.ts and the
    // `@servicebay/api-client` workspace package (#762 — Phase 3.1).
    // Phase 3.3 (#764) moved `@/lib/*` into packages/backend/.
    alias: {
      '@/lib': path.join(repoRoot, 'packages', 'backend', 'src', 'lib'),
      '@': path.join(repoRoot, 'packages', 'frontend', 'src'),
      '@servicebay/api-client': path.join(repoRoot, 'packages', 'api-client', 'src', 'index.ts'),
    },
    // Emit reasonable error messages from rejected promises etc.
    sourcemap: 'inline',
    legalComments: 'none',
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    // Strip any client-only imports that sneak in via shared types.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
    },
    logLevel: 'info',
    ...overrides,
  };
}

// Only build when run as a script — importing this module (the bundled-artefact
// test does) must not kick off a build.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await build(serverBundleOptions());
  console.log('✓ server bundle written to dist-server/server.cjs');
}

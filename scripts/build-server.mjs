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

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// External: native bindings + anything large enough that bundling is
// counterproductive. We don't bundle `next` because (a) it's huge and (b) we
// need a single shared instance at runtime.
const external = [
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
  'js-yaml',
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

await build({
  entryPoints: [path.join(repoRoot, 'server.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(repoRoot, 'dist-server', 'server.cjs'),
  external,
  // Resolve the @/* alias used inside src/**/*.ts.
  alias: {
    '@': path.join(repoRoot, 'src'),
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
});

console.log('✓ server bundle written to dist-server/server.cjs');

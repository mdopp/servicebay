#!/usr/bin/env node
// Workaround for a Next.js 16.2.4 bug: the production build omits
// `onMatchHeaders` from `.next/routes-manifest.json`, but the runtime
// (`setupFsCheck` in `router-utils/filesystem.js:294`) calls `.map()` on it
// during `app.prepare()` of a custom server. Result: a startup
// "Cannot read properties of undefined (reading 'map')" rejection that takes
// the whole process down.
//
// We patch the manifest in-place. Idempotent: if the field is already there
// we leave it alone. Drop this script once the upstream fix lands and we
// upgrade past it.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(here, '..', 'packages', 'frontend', '.next', 'routes-manifest.json');

const raw = await readFile(manifestPath, 'utf8');
const manifest = JSON.parse(raw);

const patches = [];
if (!Array.isArray(manifest.onMatchHeaders)) {
  manifest.onMatchHeaders = [];
  patches.push('onMatchHeaders');
}

if (patches.length === 0) {
  console.log('routes-manifest.json: already has onMatchHeaders, no patch needed');
  process.exit(0);
}

await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`routes-manifest.json: patched (${patches.join(', ')})`);

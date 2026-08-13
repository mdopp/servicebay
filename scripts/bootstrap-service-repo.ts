/**
 * Standards-bootstrap for a new service repo (#2513).
 *
 * The mechanics of "a new service repo's CLAUDE.md carries the
 * get_service_standards pointer from day one" are deterministic, so they live in
 * a script rather than in prose an agent re-interprets (CLAUDE.md § "Deterministic
 * execution → scripts"). The block itself comes from
 * packages/backend/src/lib/mcp/serviceRepoBootstrap.ts — the same source the
 * `get_service_standards` MCP tool serves as its `repoBootstrap` block, so a
 * pasted copy and a scripted copy can never disagree.
 *
 * Usage (from a mdopp/servicebay checkout):
 *   npm run standards:bootstrap                      # print the block (stdout)
 *   npm run standards:bootstrap -- --print
 *   npm run standards:bootstrap -- --write <repo>    # insert/refresh <repo>/CLAUDE.md
 *   npm run standards:bootstrap -- --check <repo>    # exit 1 if missing or drifted
 *
 * Exits 0 (ok / written), 1 (check failed), 2 (usage or I/O error).
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  BOOTSTRAP_MARKER_BEGIN,
  applyStandardsPointer,
  checkStandardsPointer,
  renderStandardsPointerBlock,
} from '../packages/backend/src/lib/mcp/serviceRepoBootstrap.js';

type Mode = 'print' | 'write' | 'check';

interface Args {
  mode: Mode;
  target: string;
}

export function parseArgs(argv: string[]): Args {
  let mode: Mode = 'print';
  let target = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--print') mode = 'print';
    else if (a === '--write' || a === '--check') {
      mode = a === '--write' ? 'write' : 'check';
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) target = argv[++i];
    } else if (!a.startsWith('--') && !target) target = a;
  }
  return { mode, target: target || '.' };
}

/** `<target>` may be the repo dir or the CLAUDE.md path itself. */
export function resolveClaudeMd(target: string): string {
  const abs = path.resolve(target);
  if (existsSync(abs) && statSync(abs).isDirectory()) return path.join(abs, 'CLAUDE.md');
  return abs;
}

function main() {
  const { mode, target } = parseArgs(process.argv.slice(2));

  if (mode === 'print') {
    console.log(renderStandardsPointerBlock());
    return;
  }

  const file = resolveClaudeMd(target);
  const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';

  if (mode === 'check') {
    if (!existsSync(file)) {
      console.error(`standards-bootstrap: ${file} does not exist — a service repo without a CLAUDE.md has no pointer into the standards catalog (#2513).`);
      process.exit(1);
    }
    const { ok, problems } = checkStandardsPointer(existing);
    if (ok) {
      console.log(`standards-bootstrap: ${file} carries an up-to-date standards pointer.`);
      return;
    }
    console.error(`standards-bootstrap: ${file} does not satisfy the bootstrap step.\n`);
    for (const p of problems) console.error(`  · ${p}`);
    process.exit(1);
  }

  const next = applyStandardsPointer(existing);
  if (next === existing) {
    console.log(`standards-bootstrap: ${file} already up to date.`);
    return;
  }
  writeFileSync(file, next, 'utf-8');
  const verb = existing.includes(BOOTSTRAP_MARKER_BEGIN) ? 'refreshed' : 'wrote';
  console.log(`standards-bootstrap: ${verb} the standards pointer in ${file}.`);
}

// Run only as a CLI — parseArgs/resolveClaudeMd are imported by the test suite.
if (/bootstrap-service-repo\.ts$/.test(process.argv[1] ?? '')) {
  try {
    main();
  } catch (err) {
    console.error('standards-bootstrap crashed:', err);
    process.exit(2);
  }
}

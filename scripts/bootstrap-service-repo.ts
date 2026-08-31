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
 *   npm run standards:bootstrap -- --flavor generic --write <repo>
 *
 * `--flavor servicebay` (default) is for a repo that will run on a ServiceBay
 * box; `--flavor generic` is for any other project of the operator's and points
 * at the cross-repo working agreements (#2701).
 *
 * Exits 0 (ok / written), 1 (check failed), 2 (usage or I/O error).
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  BOOTSTRAP_FLAVORS,
  BOOTSTRAP_MARKER_BEGIN,
  applyStandardsPointer,
  checkStandardsPointer,
  renderStandardsPointerBlock,
  type BootstrapFlavor,
} from '../packages/backend/src/lib/mcp/serviceRepoBootstrap.js';

type Mode = 'print' | 'write' | 'check';

interface Args {
  mode: Mode;
  target: string;
  /** Which generated block to write/print/compare against (#2701). */
  flavor: BootstrapFlavor;
}

function isFlavor(v: string): v is BootstrapFlavor {
  return (BOOTSTRAP_FLAVORS as readonly string[]).includes(v);
}

export function parseArgs(argv: string[]): Args {
  let mode: Mode = 'print';
  let target = '';
  let flavor: BootstrapFlavor = 'servicebay';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--print') mode = 'print';
    else if (a === '--flavor') {
      const v = argv[i + 1];
      if (v && isFlavor(v)) { flavor = v; i++; }
      else throw new Error(`--flavor expects one of: ${BOOTSTRAP_FLAVORS.join(', ')}`);
    } else if (a === '--write' || a === '--check') {
      mode = a === '--write' ? 'write' : 'check';
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) target = argv[++i];
    } else if (!a.startsWith('--') && !target) target = a;
  }
  return { mode, target: target || '.', flavor };
}

/** `<target>` may be the repo dir or the CLAUDE.md path itself. */
export function resolveClaudeMd(target: string): string {
  const abs = path.resolve(target);
  if (existsSync(abs) && statSync(abs).isDirectory()) return path.join(abs, 'CLAUDE.md');
  return abs;
}

function main() {
  const { mode, target, flavor } = parseArgs(process.argv.slice(2));

  if (mode === 'print') {
    console.log(renderStandardsPointerBlock(flavor));
    return;
  }

  const file = resolveClaudeMd(target);
  const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';

  if (mode === 'check') {
    if (!existsSync(file)) {
      console.error(`standards-bootstrap: ${file} does not exist — a service repo without a CLAUDE.md has no pointer into the standards catalog (#2513).`);
      process.exit(1);
    }
    const { ok, problems } = checkStandardsPointer(existing, flavor);
    if (ok) {
      console.log(`standards-bootstrap: ${file} carries an up-to-date standards pointer.`);
      return;
    }
    console.error(`standards-bootstrap: ${file} does not satisfy the bootstrap step.\n`);
    for (const p of problems) console.error(`  · ${p}`);
    process.exit(1);
  }

  const next = applyStandardsPointer(existing, flavor);
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

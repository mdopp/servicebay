/**
 * The agent CLI as it is DELIVERED (#2908, slice 3 of #2903).
 *
 * `agent_cli.test.ts` imports the CLI as a module inside vitest, which is a
 * comfortable lie: vitest resolves aliases, has `node_modules` on the path and
 * transpiles on the way in. None of that exists on the box. There the CLI is a
 * file in a git checkout that ServiceBay dropped on disk (ADR 0014's delivery,
 * widened by #2908), mounted read-only into a container, started with plain
 * `node`. So these cases run it exactly that way — a copied-out tree, a
 * subprocess, an empty environment, no install step — because the failure this
 * guards against ("it needed a build after all") is invisible to every test
 * that imports the file.
 *
 * They also pin the two structural halves of the acceptance:
 *   - the delivered layout puts the catalog and the CLI under ONE root, the one
 *     a template mounts (`AGENT_KIT_SUBDIRS`);
 *   - the CLI's imports stay inside `node:`, which is what makes "no build, no
 *     npm install" true rather than merely currently-working.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { AddressInfo } from 'net';
import { AGENT_KIT_SUBDIRS, AGENT_KIT_REQUIRED_FILES } from '../../packages/backend/src/lib/assists/delivery';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** A plausible-shaped, entirely fictional token — never a real `sb_` secret. */
const FAKE_TOKEN = 'sb_deadbeef_not-a-real-secret';

/**
 * A stand-in for what the box has after a successful sync: the sparse-checkout
 * set, copied out of the repo, and nothing else — no `node_modules`, no
 * `package.json`, no build output.
 */
let kit: string;
let server: http.Server;
let origin: string;

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}

beforeAll(async () => {
  kit = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-agent-kit-'));
  for (const sub of AGENT_KIT_SUBDIRS) copyDir(path.join(REPO_ROOT, sub), path.join(kit, sub));

  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ name: 'media', activeState: 'active', status: 'running' }]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  fs.rmSync(kit, { recursive: true, force: true });
  await new Promise<void>(resolve => server.close(() => resolve()));
});

/** Run the DELIVERED file with plain node, from a cwd that has nothing in it. */
function runDelivered(args: string[], env: Record<string, string> = {}) {
  return execFileAsync(process.execPath, [path.join(kit, 'agent-cli', 'servicebay.mjs'), ...args], {
    cwd: kit,
    // A deliberately bare environment: PATH + HOME and nothing else, so a
    // hidden dependency on the repo's env (NODE_PATH, a loader hook) shows up
    // as a failure here rather than on the box. The cast is because this
    // repo's ProcessEnv augmentation makes NODE_ENV required, which a
    // delivered CLI must not need.
    env: { PATH: process.env.PATH ?? '', HOME: kit, ...env } as unknown as NodeJS.ProcessEnv,
  }).catch((e: { stdout?: string; stderr?: string; code?: number }) => ({
    stdout: e.stdout ?? '',
    stderr: e.stderr ?? '',
    code: e.code,
  }));
}

describe('the delivered agent kit (#2908)', () => {
  it('lands the catalog and the CLI under one root', () => {
    expect([...AGENT_KIT_SUBDIRS]).toContain('assists');
    expect(fs.readdirSync(path.join(kit, 'assists')).filter(f => f.endsWith('.md')).length).toBeGreaterThan(0);
    for (const rel of AGENT_KIT_REQUIRED_FILES) {
      expect(fs.existsSync(path.join(kit, rel))).toBe(true);
    }
  });

  it('carries no build output and no node_modules — the checkout IS the artifact', () => {
    expect(fs.existsSync(path.join(kit, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(kit, 'package.json'))).toBe(false);
  });

  it('imports node: builtins only, so it can never need an install', () => {
    const source = fs.readFileSync(path.join(kit, 'agent-cli', 'servicebay.mjs'), 'utf-8');
    const specifiers = [...source.matchAll(/(?:^|\n)\s*import\s+[^;]*?from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter(s => !s.startsWith('node:'))).toEqual([]);
  });

  it('runs from the delivered path on plain node, with no build and no npm install', async () => {
    const help = await runDelivered(['--help']);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain('servicebay — read the box from a shell.');
  });

  it('answers a verb from the delivered path against a real server', async () => {
    const out = await runDelivered(['services', '--json'], {
      SERVICEBAY_API_URL: origin,
      SERVICEBAY_MCP_TOKEN: FAKE_TOKEN,
    });
    const payload = JSON.parse(out.stdout) as { ok: boolean; verb: string; data: unknown };
    expect(payload).toMatchObject({ ok: true, verb: 'services' });
    expect(payload.data).toEqual([{ name: 'media', activeState: 'active', status: 'running' }]);
  });

  it('still names the missing token rather than 401-ing, when run from the delivered path', async () => {
    const out = await runDelivered(['services'], { SERVICEBAY_API_URL: origin });
    expect(out.stderr).toMatch(/no ServiceBay API token found/);
  });
});

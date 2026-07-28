import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * #2426 — neither operator script may default to one particular deployment.
 *
 * `scripts/smoke/sso-verify.sh` and `scripts/maintenance/repair-admin-proxy-hosts.sh`
 * used to fall back to the maintainer's own box IP and domain, so a contributor
 * running either one aimed it at a stranger's LAN address (the maintenance
 * script *writes* to that box's NPM). Both now resolve the target the way
 * `scripts/fcos-diagnose.sh` and `tools/sb`'s ResolveTarget already do —
 * flag → env → build/fcos/install-settings.env — and exit 2 with a usage
 * error when nothing resolves.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS = [
  'scripts/smoke/sso-verify.sh',
  'scripts/maintenance/repair-admin-proxy-hosts.sh',
] as const;

/** Run a script with a controlled env; return {code, stdout, stderr}. */
function run(script: string, env: Record<string, string>) {
  try {
    const stdout = execFileSync('bash', [path.join(REPO_ROOT, script)], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      // A clean env: no inherited SB_* from the developer's shell, and a
      // settings file that does not exist unless the case provides one.
      // A clean env — no inherited SB_* from the developer's shell. NODE_ENV
      // is declared non-optional on this repo's ProcessEnv, so it's passed
      // through explicitly rather than cast away.
      env: { NODE_ENV: process.env.NODE_ENV ?? 'test', PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe.each(SCRIPTS)('%s: box target must be supplied', (script) => {
  const noSettings = { SB_SETTINGS_FILE: '/nonexistent/install-settings.env' };

  it('exits 2 with a usage error when neither host nor domain is set', () => {
    const r = run(script, noSettings);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no target host/i);
    // The error names all three ways to supply it, so the operator isn't
    // left guessing.
    expect(r.stderr).toContain('SB_HOST');
    expect(r.stderr).toContain('--host');
    expect(r.stderr).toContain('install-settings.env');
  });

  it('exits 2 when the host resolves but the domain does not', () => {
    const r = run(script, { ...noSettings, SB_HOST: '10.0.0.42' });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no public domain/i);
    expect(r.stderr).toContain('SB_DOMAIN');
  });

  it('never falls back to a hardcoded host or domain', () => {
    const body = fs.readFileSync(path.join(REPO_ROOT, script), 'utf-8');
    // No `${SB_HOST:-<literal>}` / `${SB_DOMAIN:-<literal>}` shape at all:
    // the only permitted fallback is a settings_value lookup.
    const badDefault = /\$\{SB_(HOST|DOMAIN):-(?!\$\()/;
    expect(badDefault.test(body), `${script} still has a literal SB_HOST/SB_DOMAIN default`).toBe(false);
    // And the two values #2426 was filed over are gone from the file
    // entirely — including the prose comments, which named them too.
    expect(body).not.toContain('192.168.178.100');
    expect(body).not.toContain('dopp.cloud');
    // No real LAN address anywhere. Loopback is fine (it's the box's own
    // interface, not an identity), and `10.0.0.x` is the placeholder the
    // usage examples tell the operator to replace.
    const leaked = (body.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []).filter(
      a => !a.startsWith('127.') && !a.startsWith('10.0.0.') && a !== '0.0.0.0',
    );
    expect(leaked, `unexpected IP literal(s) in ${script}`).toEqual([]);
  });

  it('resolves host + domain from install-settings.env when the env vars are unset', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-target-'));
    const settings = path.join(dir, 'install-settings.env');
    // Loopback so the run past the resolution gate fails fast (connection
    // refused) instead of burning an ssh connect timeout.
    fs.writeFileSync(settings, 'STATIC_IP=127.0.0.1\nPUBLIC_DOMAIN="example.test"\n');
    try {
      const r = run(script, { SB_SETTINGS_FILE: settings });
      // Both values resolved, so neither usage error fires. The run then
      // proceeds and fails on the *next* real dependency (no reachable box)
      // — a different, non-2 failure.
      expect(r.stderr).not.toMatch(/no target host|no public domain/i);
      expect(r.code).not.toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

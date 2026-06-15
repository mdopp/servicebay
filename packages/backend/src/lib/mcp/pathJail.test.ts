import { describe, it, expect } from 'vitest';
import { jailPath, realPathInJail, JAIL_ROOT } from './pathJail';

// #1872: the read_file / list_dir MCP tools must never read outside the
// /mnt/data jail. The lexical gate rejects `..`-escape, absolute-escape and
// NUL; the server pairs it with a server-side realpath check for symlinks.
describe('jailPath (#1872)', () => {
  it('accepts the root itself', () => {
    const r = jailPath(JAIL_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(JAIL_ROOT);
  });

  it('anchors a relative path under the root', () => {
    const r = jailPath('stacks/auth/config.yml');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(`${JAIL_ROOT}/stacks/auth/config.yml`);
  });

  it('accepts an absolute path already inside the root', () => {
    const r = jailPath(`${JAIL_ROOT}/backups/x.tar.gz`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(`${JAIL_ROOT}/backups/x.tar.gz`);
  });

  it('collapses harmless interior `..` that stays in the jail', () => {
    const r = jailPath('stacks/../backups/x');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(`${JAIL_ROOT}/backups/x`);
  });

  it('rejects a `..` sequence that climbs out of the jail', () => {
    const r = jailPath('../../etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/escapes the allowed root/);
  });

  it('rejects an absolute path outside the jail', () => {
    const r = jailPath('/etc/shadow');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/escapes the allowed root/);
  });

  it('rejects a sibling-prefix path (/mnt/data-evil)', () => {
    const r = jailPath('/mnt/data-evil/secret');
    expect(r.ok).toBe(false);
  });

  it('rejects a NUL byte', () => {
    const r = jailPath('ok\0/../../etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/NUL/);
  });

  it('rejects an empty path', () => {
    expect(jailPath('').ok).toBe(false);
  });
});

// #1872 (2nd box-verify RED): on Fedora CoreOS `/mnt/data` is a symlink to
// `/var/mnt/data`, so `realpath -m` resolves a legit target to /var/mnt/data/…
// realPathInJail must compare resolved-target against the *resolved* root.
describe('realPathInJail (#1872 symlinked jail root)', () => {
  // Simulate the FCoS case: literal root /mnt/data resolves to /var/mnt/data.
  const RESOLVED_ROOT = '/var/mnt/data';

  it('accepts a legit target under the resolved (symlinked) root', () => {
    expect(realPathInJail(`${RESOLVED_ROOT}/stacks/auth/config.yml`, RESOLVED_ROOT)).toBe(true);
  });

  it('accepts the resolved root itself', () => {
    expect(realPathInJail(RESOLVED_ROOT, RESOLVED_ROOT)).toBe(true);
  });

  it('rejects an escape that resolves outside the resolved root', () => {
    expect(realPathInJail('/etc/passwd', RESOLVED_ROOT)).toBe(false);
  });

  it('rejects a sibling-prefix of the resolved root (/var/mnt/data-evil)', () => {
    expect(realPathInJail(`${RESOLVED_ROOT}-evil/secret`, RESOLVED_ROOT)).toBe(false);
  });

  it('does NOT accept a /mnt/data path when the root resolved elsewhere', () => {
    // A target still under the literal root but the symlink resolved away:
    // only the resolved root counts as inside.
    expect(realPathInJail(`${JAIL_ROOT}/x`, RESOLVED_ROOT)).toBe(false);
  });

  it('falls back to the literal JAIL_ROOT when resolvedRoot is empty', () => {
    expect(realPathInJail(`${JAIL_ROOT}/stacks/x`, '')).toBe(true);
    expect(realPathInJail(`${JAIL_ROOT}/stacks/x`)).toBe(true);
    expect(realPathInJail('/etc/passwd', '')).toBe(false);
    // sibling-prefix still rejected on the literal fallback path
    expect(realPathInJail(`${JAIL_ROOT}-evil/x`, '')).toBe(false);
  });

  it('treats an empty realpath result as inside (lexical gate already vetted)', () => {
    expect(realPathInJail('', RESOLVED_ROOT)).toBe(true);
  });
});

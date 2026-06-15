import { describe, it, expect } from 'vitest';
import { jailPath, JAIL_ROOT } from './pathJail';

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

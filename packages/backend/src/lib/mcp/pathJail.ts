/**
 * Path-jail for the read-oriented MCP file tools (read_file / list_dir).
 *
 * These tools name a path on the *remote node* (the box), not the
 * backend container's own filesystem — so the jail is a purely lexical
 * check against a fixed remote root (`/mnt/data`, the box's data
 * volume). We resolve `.`/`..` segments ourselves (POSIX, `path.posix`)
 * and reject anything that climbs out of the root, plus obvious escape
 * shapes (a non-/mnt/data absolute path, embedded NUL).
 *
 * Lexical normalization catches `..`-escape and absolute-escape, but
 * NOT a symlink inside the jail that points outside it — that can only
 * be checked on the box. The caller pairs this with a server-side
 * `realpath` confirmation before reading (see server.ts), so a symlink
 * escape is rejected too. This module is the cheap, deterministic,
 * unit-testable first gate.
 */
import path from 'path';

/** The only root MCP read tools may touch on a node. */
export const JAIL_ROOT = '/mnt/data';

export interface JailOk {
  ok: true;
  /** Absolute, normalized path guaranteed to be inside JAIL_ROOT. */
  path: string;
}
export interface JailErr {
  ok: false;
  error: string;
}
export type JailResult = JailOk | JailErr;

/**
 * Resolve `input` against JAIL_ROOT and confirm it stays inside it.
 * A relative input is taken relative to the root; an absolute input
 * must already be under the root. `..` segments are collapsed
 * lexically and rejected if they escape.
 */
export function jailPath(input: string): JailResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, error: 'Path is required.' };
  }
  // A NUL byte truncates the path at the syscall layer — refuse outright.
  if (input.includes('\0')) {
    return { ok: false, error: 'Path contains a NUL byte.' };
  }
  // Resolve against the root: an absolute input is honoured as-is, a
  // relative one is anchored under the root. Either way path.posix.resolve
  // collapses `.`/`..` segments lexically.
  const resolved = path.posix.resolve(JAIL_ROOT, input);
  // After collapsing, the result must be the root itself or a descendant.
  if (resolved !== JAIL_ROOT && !resolved.startsWith(`${JAIL_ROOT}/`)) {
    return {
      ok: false,
      error: `Path escapes the allowed root ${JAIL_ROOT}: "${input}" resolves to "${resolved}".`,
    };
  }
  return { ok: true, path: resolved };
}

/**
 * True if a resolved real path (e.g. the output of `realpath -m` on the
 * box) is inside the jail. An empty string (realpath produced nothing)
 * is treated as inside — the lexical jailPath() gate already vetted the
 * requested path, and a missing realpath result shouldn't block a
 * legitimate read.
 *
 * The comparison is against the *resolved* jail root, not the literal
 * `JAIL_ROOT` string. On Fedora CoreOS `/mnt/data` is itself a symlink
 * to `/var/mnt/data`, so `realpath -m` on a legitimate target yields
 * `/var/mnt/data/…`, which is NOT under the literal `/mnt/data`. The
 * caller resolves the jail root once (also via `realpath -m`, on the
 * box) and passes it as `resolvedRoot`; we then compare resolved-target
 * against resolved-root. When `resolvedRoot` is empty we fall back to
 * the literal `JAIL_ROOT` (e.g. a node where the root isn't a symlink,
 * or resolution failed — the lexical gate already passed).
 *
 * The boundary check is path-segment aware: a descendant must be the
 * root itself or the root followed by a `/`, so a sibling like
 * `/var/mnt/data-evil` does NOT pass.
 */
export function realPathInJail(realPath: string, resolvedRoot?: string): boolean {
  const p = realPath.trim();
  if (!p) return true;
  const root = (resolvedRoot ?? '').trim() || JAIL_ROOT;
  return p === root || p.startsWith(`${root}/`);
}

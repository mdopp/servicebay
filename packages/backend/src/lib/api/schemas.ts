import { z } from 'zod';

// Identifiers that flow into shell commands on the agent must be strict.
// Podman container names: alphanumeric, plus `_-.`, must start with [a-zA-Z0-9].
export const ContainerId = z.string()
  .min(1)
  .max(255)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.\-]*$/, 'invalid container id');

// Quadlet/systemd unit names. Allow common unit characters and an optional
// extension suffix. No spaces, no shell metacharacters.
export const ServiceName = z.string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9@_.\-:]+$/, 'invalid service name');

// Trash-bucket entry ids. A strict basename — the id is interpolated into
// `rm -rf`/`mv` command strings rooted at the trash dir, so no separators, no
// traversal, no shell metacharacters. Mirrors the check `purgeTrash` has always
// applied (services/serviceLifecycle.ts) so both trash paths share one rule.
// `..` and a leading dot are rejected on top of the character class: `..` alone
// satisfies the class but resolves to the trash root's parent.
export const TRASH_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const TrashId = z.string()
  .min(1)
  .max(255)
  .regex(TRASH_ID_PATTERN, 'invalid trash id')
  .refine(s => !s.includes('..'), 'parent traversal not allowed')
  .refine(s => !s.startsWith('.'), 'leading dot not allowed');

/** Imperative form of {@link TrashId} for non-zod call sites. Throws on reject. */
export function assertTrashId(trashId: string): void {
  if (!TrashId.safeParse(trashId).success) {
    throw new Error(`Invalid trash id: ${trashId}`);
  }
}

// Companion files a deploy writes into the Quadlet directory
// (`~/.config/containers/systemd/<name>`). A path separator or a `..`
// segment here escapes that directory and lets a request overwrite an
// arbitrary file owned by the agent user, so this is a basename only.
export const QuadletFileName = z.string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9@_.\-]*$/, 'invalid file name')
  .refine(s => !s.includes('..'), 'parent traversal not allowed');

// Absolute host paths a deploy asks the agent to write (`extraFiles`). The
// parent directory is interpolated UNQUOTED into `mkdir -p <dir>` and the
// write auto-retries with `sudo: true` on failure (services/serviceLifecycle
// .ts writeExtraConfigFiles), so a shell metacharacter here is command
// execution and a `..` segment is a root-owned write anywhere on the box.
// Containment to the service's own scope is a separate check — see
// services/deployRequest.ts.
export const HostFilePath = z.string()
  .min(2)
  .max(4096)
  .regex(/^\/[A-Za-z0-9/@_.\-+]*$/, 'must be an absolute path without shell metacharacters')
  .refine(s => !s.split('/').includes('..'), 'parent traversal not allowed')
  .refine(s => !s.endsWith('/'), 'must name a file, not a directory');

// Environment variable names supplied by a caller. They are written as
// `KEY='value'` lines into a file the agent `source`s with bash, so an
// unconstrained key escapes the assignment and runs as a command.
export const EnvVarName = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'invalid environment variable name');

// Template migration scripts. The filename is both the registry lookup key
// and a path segment interpolated into `python3 <dir>/<filename>`; the
// `vN-to-vM.py` convention is enforced by the registry scanner
// (registry.ts getTemplateMigrationScripts) and mirrored here.
export const MigrationScriptFileName = z.string()
  .max(64)
  .regex(/^v\d+-to-v\d+\.py$/, 'invalid migration script filename');

// Node names are user-supplied labels; allow alnum + `_-` only.
export const NodeName = z.string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_\-]+$/, 'invalid node name');

// Hostname / IPv4 / bracketed IPv6 — no shell metacharacters.
export const HostString = z.string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9._\-:[\]]+$/, 'invalid host');

// A health check target. Reject anything that could escape into a shell.
const SHELL_META = /[;&|`$<>(){}\\\n\r\t"'*?]/;
export const HealthCheckTarget = z.string()
  .min(1)
  .max(2048)
  .refine(s => !SHELL_META.test(s), 'target contains shell metacharacters');

// Filenames must not contain path separators or traversal segments.
export const BackupFileName = z.string()
  .min(1)
  .max(255)
  .refine(s => !s.includes('/') && !s.includes('\\'), 'path separators are not allowed')
  .refine(s => !s.startsWith('.'), 'leading dot not allowed')
  .refine(s => !s.includes('..'), 'parent traversal not allowed');

// Health-check IDs. Auto-managed checks use deterministic, human-readable IDs
// (`domain:<host>`, `letsdebug:<host>`, `lan_ip_drift`, …) while user-created
// checks use UUIDs. Both shapes need to pass route validators. Constrained to
// filename-safe chars + colon (POSIX accepts the latter; we never run on
// Windows). Path separators stay rejected so traversal is impossible.
export const CheckIdString = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, {
  message: 'invalid check id',
});


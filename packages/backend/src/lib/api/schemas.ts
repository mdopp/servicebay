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


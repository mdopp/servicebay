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

// A monitoring check target. Reject anything that could escape into a shell.
const SHELL_META = /[;&|`$<>(){}\\\n\r\t"'*?]/;
export const MonitoringCheckTarget = z.string()
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


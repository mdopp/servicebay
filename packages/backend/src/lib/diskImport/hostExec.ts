// Disk-import — host-exec seam + share-root path guards (issue #1694).
//
// Both the mounter and the plan-applier run host commands through the agent's
// `safe_exec` path (structured argv, allow-listed binary). They depend only on
// this thin `SafeExec` function type, so the real wiring (an AgentExecutor's
// `execSafe`) and the test mocks both satisfy the same shape — and a test can
// assert the exact argv every call produced.

/** Result of a single `safe_exec` argv invocation. */
export interface SafeExecResult {
  stdout: string;
  stderr: string;
  /** Process exit code. Non-zero = the command failed (callers check this). */
  code: number;
}

/**
 * Runs one allow-listed binary with an explicit argv (no shell). This is the
 * ONLY way disk-import touches the host. The implementation rejects (throws) on
 * a transport/agent error reply — see project memory `agent.sendCommand rejects
 * on error replies`: callers must NOT treat a thrown EACCES as success.
 */
export type SafeExec = (argv: string[], options?: { timeoutMs?: number }) => Promise<SafeExecResult>;

/**
 * The share data root that every import target lives under, RELATIVE-joined.
 * Engine `target`s (e.g. `photos/IMG_0001.jpg`) are appended to this. The path
 * is normalised host-side; this module's guards ensure no target escapes it.
 */
export const SHARE_DATA_ROOT = '/mnt/data/stacks/file-share/data';

/** Folder (under the share root) superseded conflict versions are parked in. */
export const SUPERSEDED_DIR = '_superseded';

/**
 * Assert a relative `target` (from the engine) stays inside the share data
 * root, then return the absolute on-disk path. Rejects absolute paths, `..`
 * traversal, leading slashes, NUL bytes, and any segment that would climb out
 * of the share — a malicious filename on the source disk must never be able to
 * make the importer write outside `file-share/data/`.
 */
export function resolveShareTarget(relTarget: string): string {
  return joinUnderRoot(SHARE_DATA_ROOT, relTarget, 'target');
}

/** Like {@link resolveShareTarget} but for the `_superseded/<date>/...` tree. */
export function resolveSupersededPath(relPath: string): string {
  return joinUnderRoot(SHARE_DATA_ROOT, `${SUPERSEDED_DIR}/${relPath}`, 'superseded path');
}

function joinUnderRoot(root: string, rel: string, label: string): string {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error(`disk-import: empty ${label}`);
  }
  if (rel.includes('\0')) {
    throw new Error(`disk-import: NUL byte in ${label}`);
  }
  if (rel.startsWith('/')) {
    throw new Error(`disk-import: absolute ${label} not allowed: ${JSON.stringify(rel)}`);
  }
  // Normalise separators and reject any `..` segment outright (don't try to be
  // clever — a single `..` is a hard refusal).
  const segments = rel.replace(/\\/g, '/').split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw new Error(`disk-import: path traversal in ${label}: ${JSON.stringify(rel)}`);
    }
  }
  const clean = segments.filter(s => s !== '' && s !== '.').join('/');
  if (clean.length === 0) {
    throw new Error(`disk-import: ${label} resolves to the share root itself: ${JSON.stringify(rel)}`);
  }
  const abs = `${root}/${clean}`;
  // Defence in depth: the assembled absolute path must start with the root.
  if (abs !== root && !abs.startsWith(`${root}/`)) {
    throw new Error(`disk-import: ${label} escapes the share root: ${JSON.stringify(rel)}`);
  }
  return abs;
}

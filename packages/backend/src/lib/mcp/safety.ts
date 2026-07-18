/**
 * MCP safety layer.
 *
 * Real security boundaries on every mutating MCP tool:
 *
 *   1. Read-only mode  — config.mcp.allowMutations must be true (or absent
 *                        on pre-existing installs, for back-compat).
 *   2. Per-tool scope  — bearer tokens carry a subset of
 *                        read/lifecycle/mutate/destroy and refuse tools
 *                        outside their scope (see TOOL_SCOPES in server.ts).
 *   3. Pre-mutation    — destructive tools trigger a labelled
 *      snapshot         createSystemBackup() so the operator always has a
 *                        one-click rewind point.
 *   4. Audit log       — every tool call is recorded with caller, args
 *                        (redacted), and outcome.
 *
 * Plus one *advisory tripwire*, not a boundary: `exec_command` runs the
 * supplied command against a regex denylist of cliché-class destructive
 * shell patterns (`rm -rf /`, `mkfs`, `dd of=/dev/sd*`, …) and refuses
 * matches unless the operator opts in via `config.mcp.allowDangerousExec`.
 * The denylist is bypassable with trivial quoting / encoding (#579) —
 * its job is to catch typo-class mistakes, not adversarial input.
 *
 * No tool gets to mutate state without going through this module.
 */
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';

/** Standard shape MCP tool handlers return — same as MCP SDK's CallToolResult. */
export interface ToolErrorResult {
  isError: true;
  content: { type: 'text'; text: string }[];
}

function errorResult(message: string): ToolErrorResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * Treat absent `allowMutations` as enabled to avoid silently breaking
 * MCP clients that worked on installs predating this flag. Fresh installs
 * are gated because the onboarding wizard writes `false` explicitly.
 */
async function mutationsAllowed(): Promise<boolean> {
  try {
    const config = await getConfig();
    return config.mcp?.allowMutations !== false;
  } catch {
    return true;
  }
}

/**
 * Gate a mutating tool. Returns null if allowed; an error result otherwise.
 * Caller pattern:
 *
 *     const blocked = await guardMutation('manage_service');
 *     if (blocked) return blocked;
 *     // ...do the mutation...
 */
export async function guardMutation(toolName: string): Promise<ToolErrorResult | null> {
  if (!(await mutationsAllowed())) {
    logger.warn('mcp:safety', `Blocked mutating tool ${toolName} — config.mcp.allowMutations is false`);
    return errorResult(
      `MCP mutations are disabled on this ServiceBay. Enable them in Settings → Integrations → MCP Server (or set config.mcp.allowMutations=true) before calling ${toolName}.`
    );
  }
  return null;
}

/**
 * Tripwire patterns for the most obviously-destructive shell commands.
 *
 * IMPORTANT: this is NOT a security boundary (#579). A regex denylist
 * over arbitrary POSIX shell is fundamentally leaky — quoting,
 * variable expansion, command substitution, here-strings, and `sh -c`
 * indirection all bypass naive matching. The real boundaries between
 * an MCP caller and the host are:
 *
 *   1. `config.mcp.allowMutations` gates the tool entirely.
 *   2. The per-tool scope check (`exec_command` requires `destroy`).
 *   3. `snapshotBeforeMutation` takes a config snapshot pre-exec.
 *   4. The audit log records every call.
 *
 * What this list catches: typo-class mistakes (LLM autocompletes the
 * literal `rm -rf /`), and the most cliché commands a confused
 * assistant might emit. Operators with a real reason set
 * `config.mcp.allowDangerousExec = true` to bypass.
 *
 * Anything that determined-adversarial input could obviously bypass
 * (quoting, escapes, encoded forms) is acceptable — the boundary
 * isn't this regex.
 */
const OBVIOUSLY_DESTRUCTIVE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  // The flag-group is `-[rRfF]\w*` (not `-[rRfF]+\w*`): `[rRfF]` ⊆ `\w`, so
  // `[rRfF]+\w*` and `[rRfF]\w*` accept the identical set of tokens, but the
  // `+`/`\w*` overlap made the outer `(… )*` backtrack super-linearly on a
  // long flag run with no trailing `/` (js/redos). The single-char form is
  // linear and matches exactly the same commands.
  { pattern: /\brm\s+(-[rRfF]\w*\s+)*\/(?:\s|$)/, reason: '`rm -rf /` would wipe the rootfs' },
  { pattern: /\brm\s+(-[rRfF]\w*\s+)*\/(mnt|var|home|etc|usr|boot)(\s|\/)/, reason: 'recursive rm of a system path' },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: 'mkfs reformats a filesystem' },
  { pattern: /\bdd\b[^|\n]*\bof=\/dev\/(sd|nvme|md|mmcblk|vd)/, reason: 'dd to a raw block device destroys partitions' },
  { pattern: />\s*\/dev\/(sd|nvme|md|mmcblk|vd)\w*/, reason: 'shell redirect to a raw block device' },
  { pattern: /\b(wipefs|sgdisk|fdisk|gdisk|parted|cfdisk)\b/, reason: 'partition table editor' },
  { pattern: /\bshred\b/, reason: 'shred destroys data irreversibly' },
  { pattern: /\bchmod\s+(-R\s+)?[0-7]*[0-7]{3}\s+\/(?:\s|$)/, reason: 'recursive chmod on /' },
  { pattern: /\bchown\s+(-R\s+)?\w+(:\w+)?\s+\/(?:\s|$)/, reason: 'recursive chown on /' },
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|/, reason: 'fork bomb signature' },
  { pattern: /\b>\s*\/etc\/passwd\b/, reason: 'overwrites /etc/passwd' },
  { pattern: /\bsystemctl\s+poweroff\b|\bshutdown\s+(now|-h)/, reason: 'shuts the host down' },
];

/** Inspect an exec command. Returns null if allowed; error otherwise.
 *  See OBVIOUSLY_DESTRUCTIVE_PATTERNS above — this is an advisory
 *  tripwire for cliché-class destructive commands, not a security
 *  boundary. The real boundaries are scope + allowMutations + audit. */
export async function guardExec(command: string): Promise<ToolErrorResult | null> {
  const config = await getConfig().catch(() => null);
  if (config?.mcp?.allowDangerousExec === true) return null;

  for (const { pattern, reason } of OBVIOUSLY_DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      logger.warn('mcp:safety', `Refused exec_command — ${reason}: ${command.slice(0, 200)}`);
      return errorResult(
        `exec_command refused as obviously destructive: ${reason}. ` +
        `This is an advisory tripwire that catches cliché-class commands — ` +
        `it's not a security boundary (quoting / encoding bypass it trivially). ` +
        `If you genuinely need to run this, set config.mcp.allowDangerousExec=true and retry. ` +
        `Matched pattern: ${pattern.source}`
      );
    }
  }
  return null;
}

/**
 * Take a labelled system-config snapshot before a destructive tool runs.
 * Best-effort: a snapshot failure logs a warning but does NOT block the
 * mutation. The reasoning: failing here would make destructive tools
 * unusable when the data volume is full / unmounted, which is exactly
 * when the operator needs to fix something. Better to mutate without a
 * checkpoint than to leave them stuck.
 *
 * The snapshot label encodes the triggering tool + ISO timestamp so the
 * operator can find the relevant pre-mutation backup quickly in
 * Settings → Backups.
 */
export async function snapshotBeforeMutation(toolName: string, args?: Record<string, unknown>): Promise<void> {
  try {
    // Lazy import: keeps the safety module free of the (heavy) backup
    // deps when only the gating helpers are imported.
    const { createSystemBackup, autoSnapshotWouldDuplicate } = await import('@/lib/systemBackup');
    const summary = args ? Object.keys(args).slice(0, 4).join(',') : '';
    const label = `pre-mutation:${toolName}${summary ? `(${summary})` : ''}`;
    // Dedup (#1868): most exec_command calls don't touch config, so skip the
    // snapshot when the config is byte-identical to the latest auto snapshot.
    // Mirrors history.ts's latest-snapshot content compare. This keeps the
    // pre-mutation snapshot pile bounded instead of growing one-per-tool-call.
    if (await autoSnapshotWouldDuplicate()) {
      logger.info('mcp:safety', `Snapshot before ${label} skipped (config unchanged vs latest auto snapshot)`);
      return;
    }
    logger.info('mcp:safety', `Snapshot before ${label}`);
    // The snapshot is tagged `auto` (filename suffix `-auto.tar.gz`); these are
    // the only prune-eligible snapshots (keep newest AUTO_BACKUP_RETENTION).
    await createSystemBackup('auto');
  } catch (e) {
    logger.warn('mcp:safety', `Pre-mutation snapshot failed (continuing): ${e instanceof Error ? e.message : String(e)}`);
  }
}

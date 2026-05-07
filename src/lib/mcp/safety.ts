/**
 * MCP safety layer.
 *
 * Wraps every mutating MCP tool with three guards:
 *
 *   1. Read-only mode  — config.mcp.allowMutations must be true (or absent
 *                        on pre-existing installs, for back-compat).
 *   2. Exec denylist   — exec_command refuses obviously-destructive shell
 *                        patterns (rm -rf /, mkfs, dd of=/dev/sd*, …)
 *                        unless the operator opts in via
 *                        config.mcp.allowDangerousExec.
 *   3. Pre-mutation    — destructive tools trigger a labelled
 *      snapshot         createSystemBackup() so the operator always has a
 *                        one-click rewind point.
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
 *     const blocked = await guardMutation('start_service');
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
 * Default-deny patterns for exec_command. Each entry is a regex tested
 * against the raw command string. Tuned for the FCoS / rootless-podman
 * deployment shape — these target the host's data and OS surface.
 *
 * Operators who genuinely need these can set
 * `config.mcp.allowDangerousExec = true`. We log + reject by default.
 */
const DANGEROUS_EXEC_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[rRfF]+\w*\s+)*\/(?:\s|$)/, reason: '`rm -rf /` would wipe the rootfs' },
  { pattern: /\brm\s+(-[rRfF]+\w*\s+)*\/(mnt|var|home|etc|usr|boot)(\s|\/)/, reason: 'recursive rm of a system path' },
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

/** Inspect an exec command. Returns null if allowed; error otherwise. */
export async function guardExec(command: string): Promise<ToolErrorResult | null> {
  const config = await getConfig().catch(() => null);
  if (config?.mcp?.allowDangerousExec === true) return null;

  for (const { pattern, reason } of DANGEROUS_EXEC_PATTERNS) {
    if (pattern.test(command)) {
      logger.warn('mcp:safety', `Refused exec_command — ${reason}: ${command.slice(0, 200)}`);
      return errorResult(
        `exec_command refused: ${reason}. If you genuinely need this, set config.mcp.allowDangerousExec=true and retry. The denied pattern was: ${pattern.source}`
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
    const { createSystemBackup } = await import('@/lib/systemBackup');
    const summary = args ? Object.keys(args).slice(0, 4).join(',') : '';
    const label = `pre-mutation:${toolName}${summary ? `(${summary})` : ''}`;
    logger.info('mcp:safety', `Snapshot before ${label}`);
    // createSystemBackup ignores extra metadata at the moment; we keep the
    // label in the log line and rely on the timestamp + adjacency in the
    // backup list for matching when the user needs to revert.
    await createSystemBackup();
  } catch (e) {
    logger.warn('mcp:safety', `Pre-mutation snapshot failed (continuing): ${e instanceof Error ? e.message : String(e)}`);
  }
}

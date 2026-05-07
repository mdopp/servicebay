/**
 * Email the operator after every successful destructive MCP call. The
 * point isn't real-time alerting (audit log already covers post-mortem)
 * — it's "if a stolen token is exfiltrating data right now, you find
 * out within minutes instead of hours". Hard to ignore something
 * sitting in your inbox.
 *
 * Coalescing: a runaway agent calling delete_service in a loop would
 * spam the operator's inbox. Coalesce by tool over a 5-minute window:
 * the first event in a window emails immediately; subsequent events
 * within the window are counted; an aggregate email lands at flush
 * time noting how many fired.
 *
 * No-op when SMTP isn't configured (sendEmailAlert short-circuits).
 */
import { sendEmailAlert } from '@/lib/email';
import { logger } from '@/lib/logger';

const COALESCE_WINDOW_MS = 5 * 60_000;

interface PendingNotice {
  count: number;
  firstAt: string;
  lastCaller?: string;
  flushTimer: NodeJS.Timeout;
}
const pending = new Map<string, PendingNotice>();

function summarizeArgs(args?: Record<string, unknown>): string {
  if (!args) return '(no args)';
  const lines: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === 'password' || k === 'secret' || k === 'token' || k === 'credentials') {
      lines.push(`  ${k}: [redacted]`);
      continue;
    }
    if (k === 'command' && typeof v === 'string' && v.length > 200) {
      lines.push(`  ${k}: ${v.slice(0, 200)}…`);
      continue;
    }
    if (k === 'kubeContent' || k === 'yamlContent') {
      const len = typeof v === 'string' ? v.length : 0;
      lines.push(`  ${k}: ${len} chars`);
      continue;
    }
    let str: string;
    try { str = typeof v === 'string' ? v : JSON.stringify(v); } catch { str = '[unserializable]'; }
    if (str.length > 120) str = `${str.slice(0, 120)}…`;
    lines.push(`  ${k}: ${str}`);
  }
  return lines.length ? lines.join('\n') : '(empty)';
}

export async function notifyDestructiveOp(opts: {
  tool: string;
  caller?: string;
  args?: Record<string, unknown>;
  ts: string;
}): Promise<void> {
  try {
    const existing = pending.get(opts.tool);
    if (existing) {
      // Within the coalesce window — count and let the timer flush later.
      existing.count += 1;
      existing.lastCaller = opts.caller;
      return;
    }
    // First event for this tool in the current window — send immediately.
    await sendEmailAlert(
      `MCP destructive op: ${opts.tool}`,
      [
        `A destructive MCP call just succeeded on this ServiceBay.`,
        ``,
        `  Tool:      ${opts.tool}`,
        `  Caller:    ${opts.caller ?? 'unknown'}`,
        `  Timestamp: ${opts.ts}`,
        ``,
        `Arguments:`,
        summarizeArgs(opts.args),
        ``,
        `If this wasn't you, revoke the token at Settings → Integrations → MCP Server → API tokens, then restore from the auto-snapshot taken at the same timestamp under Settings → Backups.`,
      ].join('\n'),
    );
    // Schedule a possible "+N more" follow-up.
    const flushTimer = setTimeout(() => {
      const entry = pending.get(opts.tool);
      pending.delete(opts.tool);
      if (!entry || entry.count < 2) return;
      sendEmailAlert(
        `MCP destructive op: ${opts.tool} ×${entry.count - 1} more`,
        [
          `Continued activity on this ServiceBay since the last alert.`,
          ``,
          `  Tool:           ${opts.tool}`,
          `  Additional ops: ${entry.count - 1}`,
          `  Window since:   ${entry.firstAt}`,
          `  Last caller:    ${entry.lastCaller ?? 'unknown'}`,
          ``,
          `Check Settings → Integrations → MCP Server → Recent MCP activity for the full list.`,
        ].join('\n'),
      ).catch((e: unknown) => logger.warn('mcp:notify', `Coalesced flush email failed: ${e instanceof Error ? e.message : String(e)}`));
    }, COALESCE_WINDOW_MS);
    flushTimer.unref?.();
    pending.set(opts.tool, {
      count: 1,
      firstAt: opts.ts,
      lastCaller: opts.caller,
      flushTimer,
    });
  } catch (e) {
    logger.warn('mcp:notify', `Destructive-op notification failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

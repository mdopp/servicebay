/**
 * MCP audit log — appends a JSON line per tool call so the operator can
 * reconstruct who/what touched the appliance after the fact. JSONL is
 * cheap to grep, easy to render in the UI, survives a process restart,
 * and can be tail-followed.
 *
 * Persistence: append-only `mcp-audit.log` under DATA_DIR. Each line is a
 * single JSON object terminated by '\n'. We rotate at 5 MB (rename to
 * .1.log) and keep one backup file — the operator can always pull the
 * full forensic stream off the host with the existing system backup.
 *
 * Redaction: arg values for known-sensitive parameters are masked before
 * write so an attacker who reads the log doesn't get tokens, passwords,
 * or full command lines for free.
 */
import fsp from 'fs/promises';
import path from 'path';
import { DATA_DIR } from '@/lib/dirs';
import { logger } from '@/lib/logger';
import { currentTraceId } from '@/lib/util/traceContext';

const AUDIT_FILE = path.join(DATA_DIR, 'mcp-audit.log');
const AUDIT_BACKUP_FILE = path.join(DATA_DIR, 'mcp-audit.1.log');
const ROTATE_BYTES = 5 * 1024 * 1024;
const MAX_LINES_RETURNED = 500;

/** A single audit row. Stable shape — operators may grep this directly. */
export interface AuditEntry {
  ts: string;            // ISO timestamp
  tool: string;          // e.g. "delete_service"
  caller?: string;       // session user, falls back to remote IP
  outcome: 'ok' | 'error' | 'blocked';
  durationMs: number;
  args?: Record<string, unknown>;  // redacted
  errorMessage?: string;           // present iff outcome === 'error' or 'blocked'
  /** Request-scoped trace ID (#594). Auto-populated by recordAudit
   *  when the call originates from a tracked HTTP request. Lets the
   *  operator grep the same id across MCP audit, server logs, and
   *  agent SSH command lines (`SB_TRACE=…`). */
  traceId?: string;
}

/** Args fields that get masked. Full-redact rather than truncate so the
 *  log is safe to share verbatim with support. */
const REDACT_KEYS = new Set([
  'password', 'secret', 'token', 'apiKey', 'api_key',
  'authToken', 'credentials', 'pass', 'cookie',
  'privateKey', 'private_key', 'sshKey',
  'kubeContent', 'yamlContent',  // can contain inline credentials
]);
/** Truncate-rather-than-redact: keep the head so the log is still useful. */
const TRUNCATE_KEYS = new Set([
  'command',  // exec_command — keep first 200 chars
]);

function redactArgs(args?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!args) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (REDACT_KEYS.has(k)) {
      out[k] = '[redacted]';
      continue;
    }
    if (TRUNCATE_KEYS.has(k) && typeof v === 'string' && v.length > 200) {
      out[k] = `${v.slice(0, 200)}…(+${v.length - 200} chars)`;
      continue;
    }
    out[k] = v;
  }
  return out;
}

let rotating = false;
async function rotateIfNeeded() {
  if (rotating) return;
  try {
    const stat = await fsp.stat(AUDIT_FILE);
    if (stat.size < ROTATE_BYTES) return;
    rotating = true;
    try {
      // Single backup ring — overwrite the previous .1 if any.
      await fsp.rename(AUDIT_FILE, AUDIT_BACKUP_FILE).catch(() => { /* race: another writer rotated */ });
    } finally {
      rotating = false;
    }
  } catch {
    // File doesn't exist yet — nothing to rotate.
  }
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(AUDIT_FILE), { recursive: true }).catch(() => undefined);
    await rotateIfNeeded();
    const line = JSON.stringify({
      ...entry,
      // Auto-attach the request trace ID if available and the caller
      // didn't already supply one (#594). Pure additive.
      traceId: entry.traceId ?? currentTraceId(),
      args: redactArgs(entry.args),
    }) + '\n';
    // Append-with-flush: O_APPEND on Linux is atomic for writes < PIPE_BUF
    // (~4 KiB), which our entries comfortably fit under. fs.appendFile uses
    // the right flags.
    await fsp.appendFile(AUDIT_FILE, line, 'utf-8');
  } catch (e) {
    logger.warn('mcp:audit', `Failed to record audit entry: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Read the last N audit entries from the current log file (does NOT
 *  read .1.log — operators wanting deep history can grab the file via
 *  the system backup). Returns newest first. */
export async function readRecentAudit(limit = 100): Promise<AuditEntry[]> {
  const cap = Math.min(Math.max(1, limit | 0), MAX_LINES_RETURNED);
  let raw: string;
  try {
    raw = await fsp.readFile(AUDIT_FILE, 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter(Boolean);
  const tail = lines.slice(-cap).reverse();
  const out: AuditEntry[] = [];
  for (const line of tail) {
    try {
      const e = JSON.parse(line) as AuditEntry;
      if (e && typeof e.tool === 'string' && typeof e.ts === 'string') {
        out.push(e);
      }
    } catch { /* malformed line, skip */ }
  }
  return out;
}


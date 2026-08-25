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
import { isSecretKey, redactLogText } from './redact';

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

/**
 * Args whose value is a whole *file/config body* rather than a parameter
 * (#2624). The bytes are masked, the length is kept.
 *
 * The old redactor was a flat, exact-name denylist over the TOP LEVEL of
 * `args` — so it covered `kubeContent`/`yamlContent` but not `content`, and
 * `write_file({path, content, node})` wrote every byte an agent ever pushed
 * under /mnt/data (restored `.env` files, API keys, private keys) into
 * `mcp-audit.log` in plaintext, forever. That is the same fault as #1211 →
 * #2603 → #2616, in its fourth sink: redaction decided per call site, with a
 * top-level-only pass that nested payloads walk straight past.
 *
 * Masking, not dropping: the audit log exists so an operator can see what an
 * agent DID. `write_file` still records the tool, the caller, the outcome, the
 * `path` and `<N chars redacted>` — the event and its target survive intact;
 * only the bytes go. Same rendering as the agent log sink (#2603) so the two
 * read alike.
 *
 * `check-invariants`' `mcp-audit-redaction` rule fails the build if a tool
 * grows a new `*Content` arg that is not listed here.
 */
const BODY_KEYS = new Set([
  'content',          // write_file, deploy_service extraFiles[].content
  'kubecontent',      // deploy_service, update_service_yaml
  'yamlcontent',      // deploy_service companion YAML
  'podspeccontent',   // update_service_yaml — newer alias for kubeContent
  'advancedconfig',   // create/add_proxy_route — raw nginx directives
  'body',             // create_assist — free-form markdown
]);

/** Key names `isSecretKey`'s word matcher deliberately does not reach, but
 *  which this sink has always masked. Keep them masked. */
const EXTRA_SECRET_KEYS = new Set(['cookie']);

/** Exec-shaped args: keep them legible (that IS the forensic value), but run
 *  them through the log redactor so an inline `--password X` / `token=…` /
 *  `Bearer …` is masked, then cap the head. Covers `exec_command`'s `command`
 *  string and `container_exec`'s argv array. */
const COMMAND_KEYS = new Set(['command', 'args']);
const COMMAND_HEAD = 200;

/** Guard against a pathological/self-referential payload while walking it —
 *  same cap as the agent sink (#2603). */
const REDACT_MAX_DEPTH = 12;

const REDACTED = '[redacted]';

const maskBody = (value: string): string => `<${value.length} chars redacted>`;

function maskCommand(value: string): string {
  const masked = redactLogText(value);
  return masked.length > COMMAND_HEAD
    ? `${masked.slice(0, COMMAND_HEAD)}…(+${masked.length - COMMAND_HEAD} chars)`
    : masked;
}

function redactAuditField(key: string, value: unknown, depth: number): unknown {
  const lower = key.toLowerCase();
  if (isSecretKey(key) || EXTRA_SECRET_KEYS.has(lower)) return REDACTED;
  if (BODY_KEYS.has(lower)) {
    return typeof value === 'string' ? maskBody(value) : REDACTED;
  }
  if (COMMAND_KEYS.has(lower)) {
    if (typeof value === 'string') return maskCommand(value);
    if (Array.isArray(value)) {
      return value.map(item => (typeof item === 'string' ? maskCommand(item) : redactAuditValue(item, depth + 1)));
    }
  }
  return redactAuditValue(value, depth + 1);
}

/** Walk an arg payload to any depth. The nesting is not hypothetical:
 *  `deploy_service` carries `extraFiles: [{path, content}]` and
 *  `install_template` carries `variables: {<NAME>: <value>}`, where the
 *  secret-shaped NAMEs are exactly the template's `type: "secret"` vars. */
function redactAuditValue(value: unknown, depth: number): unknown {
  if (depth >= REDACT_MAX_DEPTH) return '<redacted: max depth>';
  if (Array.isArray(value)) return value.map(item => redactAuditValue(item, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactAuditField(key, item, depth);
  }
  return out;
}

/** Exported for the test suite — `recordAudit` is the only production caller. */
export function redactArgs(args?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!args) return undefined;
  return redactAuditValue(args, 0) as Record<string, unknown>;
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


/**
 * Non-destructive NPM admin re-key (credential-reconciliation).
 *
 * The reinstall-over-persisted-data trap for Nginx Proxy Manager: NPM's
 * SQLite survives a reinstall with an admin password ServiceBay no longer
 * knows (its stored one went empty / diverged), so ServiceBay can't
 * authenticate to NPM's admin API and can't manage proxy routes.
 *
 * An admin login secret isn't an encryption key, so we re-key it in place
 * to a fresh generated password — keeping every proxy host — instead of
 * wiping (`reset_volume`) or needing the operator to know it
 * (`use_existing`). This is the "auto-rekey when safe" path; it backs both
 * the `npm_data_stale` diagnose action and the install-runner self-heal.
 *
 * The hash rewrite runs INSIDE the NPM container so it uses NPM's own
 * bundled bcrypt (cost 13, matching the `$2b$13$` hashes it writes) +
 * better-sqlite3, against the container-relative /data/database.sqlite —
 * robust to whatever the host data-dir is named.
 */

import { agentManager } from '@/lib/agent/manager';
import { getConfig, updateConfig } from '@/lib/config';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { logger } from '@/lib/logger';
import { generateRandomSecret } from '@/lib/stackInstall/randomSecret';
import { shellQuote } from '@/lib/util/shellQuote';

const LOG = 'reverseProxy:npmRekey';

/** Container names podman accepts — letters, digits, and `_.-`. We reject
 *  anything else so a name parsed from `podman ps` stdout can never carry
 *  shell metacharacters into the rekey exec command. */
const CONTAINER_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

/** Resolve NPM's admin API base URL from the running nginx service, or
 *  null when NPM isn't deployed/active. */
export async function findNpmAdminUrl(node: string): Promise<string | null> {
  try {
    const services = await ServiceManager.listServices(node);
    const nginx = services.find(
      s => s.name === 'nginx-web' || (s.name.includes('nginx') && !s.name.startsWith('install-')),
    );
    if (!nginx?.active) return null;
    const ports = (nginx.ports ?? [])
      .map(p => parseInt(String(p.host ?? ''), 10))
      .filter(p => Number.isFinite(p) && p !== 80 && p !== 443);
    const adminPort = ports[0] ?? 81;
    return `http://localhost:${adminPort}`;
  } catch {
    return null;
  }
}

/** POST creds to NPM's /api/tokens. 'ok' = accepted, 'unauthorized' = 401,
 *  'error' = unreachable/other. */
export async function npmTokenStatus(
  adminUrl: string,
  email: string,
  password: string,
): Promise<'ok' | 'unauthorized' | 'error'> {
  try {
    const res = await fetch(`${adminUrl}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: email, secret: password }),
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) return 'ok';
    if (res.status === 401) return 'unauthorized';
    // NPM (jc21) returns HTTP 400 — NOT 401 — for a wrong password, with
    // `error.message_i18n: 'error.invalid-auth'`. Treat that as a credential
    // rejection (→ re-key), distinct from a genuinely malformed request
    // (e.g. empty secret), which stays 'error'. Found via on-box verify.
    if (res.status === 400 && (await isInvalidAuth(res))) return 'unauthorized';
    return 'error';
  } catch {
    return 'error';
  }
}

/** True iff an NPM /api/tokens 400 body is the "invalid email or password"
 *  rejection (rather than a malformed-request 400). */
export async function isInvalidAuth(res: Response): Promise<boolean> {
  const body = (await res.json().catch(() => null)) as { error?: { message_i18n?: string; message?: string } } | null;
  const err = body?.error;
  return err?.message_i18n === 'error.invalid-auth' || /invalid email or password/i.test(err?.message ?? '');
}

/**
 * Whether ServiceBay's stored NPM admin creds currently work.
 *  - 'ok'       — they authenticate; nothing to do.
 *  - 'rejected' — NPM 401s them (stale/diverged) → re-key.
 *  - 'no-creds' — none stored (lost on reinstall) but NPM is up → re-key.
 *  - 'unknown'  — NPM not deployed/reachable → can't tell, skip.
 */
export async function npmAdminCredStatus(node: string): Promise<'ok' | 'rejected' | 'no-creds' | 'unknown'> {
  const adminUrl = await findNpmAdminUrl(node);
  if (!adminUrl) return 'unknown';
  const cfg = await getConfig();
  const npm = cfg.reverseProxy?.npm;
  if (!npm?.email || !npm?.password) return 'no-creds';
  const status = await npmTokenStatus(adminUrl, npm.email, npm.password);
  if (status === 'ok') return 'ok';
  if (status === 'unauthorized') return 'rejected';
  return 'unknown';
}

// Runs inside the NPM container. Reads NEWPW from env; re-keys the first
// non-deleted admin user's password hash. Prints `email=<x>;updated=<n>`.
//
// Concurrency pragmas set immediately after open, BEFORE any query: NPM is
// actively writing this same DB during host creates / cert renewals, so an
// unguarded external opener races and fails with `database is locked` (the
// #1679 class). `busy_timeout=5000` (per-connection, always safe) makes this
// opener WAIT out a concurrent write instead of aborting; `journal_mode=WAL`
// matches NPM's own journal mode (jc21 runs its SQLite in WAL), so readers
// and writers don't block each other. Mirrors the in-repo pattern in
// logger.ts / auth/rateLimit.ts (pragma right after the Database() open).
export const NPM_REKEY_JS = [
  "const bcrypt=require('/app/node_modules/bcrypt');",
  "const Database=require('/app/node_modules/better-sqlite3');",
  "const db=Database('/data/database.sqlite');",
  "db.pragma('busy_timeout = 5000');",
  "db.pragma('journal_mode = WAL');",
  "const u=db.prepare(\"SELECT id,email FROM user WHERE is_deleted=0 ORDER BY id LIMIT 1\").get();",
  "if(!u){process.stdout.write('noadmin');process.exit(0);}",
  "const hash=bcrypt.hashSync(process.env.NEWPW,13);",
  "const r=db.prepare(\"UPDATE auth SET secret=?, modified_on=datetime('now') WHERE user_id=? AND type='password'\").run(hash,u.id);",
  "process.stdout.write('email='+u.email+';updated='+r.changes);",
].join('\n');

export interface RekeyResult {
  ok: boolean;
  message: string;
  email?: string;
}

/**
 * Re-key NPM's admin to a fresh generated password in place (proxy hosts
 * preserved), verify it, and persist it to `reverseProxy.npm`. Never
 * persists creds it can't prove against /api/tokens.
 */
export async function rekeyNpmAdmin(node: string): Promise<RekeyResult> {
  const adminUrl = await findNpmAdminUrl(node);
  if (!adminUrl) {
    return { ok: false, message: 'Nginx Proxy Manager is not deployed/active on this node — nothing to re-key.' };
  }
  const agent = await agentManager.ensureAgent(node);
  const find = await agent.sendCommand('exec', {
    command: `podman ps --format '{{.Names}} {{.Image}}' | awk '/proxy-manager/{print $1; exit}'`,
  }, { timeoutMs: 15_000 });
  const container = ((find as { stdout?: string }).stdout || '').trim().split(/\s+/)[0];
  if (!container) {
    return { ok: false, message: 'Could not find the running NPM container to re-key.' };
  }
  // Defence-in-depth: the container name comes from `podman ps` stdout and is
  // interpolated into a shell command below. Reject anything that isn't a
  // plain podman name so no metacharacter can break out of the command.
  if (!CONTAINER_NAME_RE.test(container)) {
    return { ok: false, message: 'Refusing to re-key: the detected NPM container name is not a valid podman name.' };
  }
  const newPassword = generateRandomSecret(32);
  const b64 = Buffer.from(NPM_REKEY_JS).toString('base64');
  // The pipe (base64 -d → podman exec) requires shell form, so every
  // interpolated value is shell-quoted. NEWPW is also quoted so the generated
  // password is never re-split by the shell.
  const rewrite = await agent.sendCommand('exec', {
    command: `echo ${b64} | base64 -d | podman exec -i -e NEWPW=${shellQuote(newPassword)} ${shellQuote(container)} node -`,
  }, { timeoutMs: 30_000 });
  const out = ((rewrite as { stdout?: string }).stdout || '').trim();
  const m = out.match(/email=(.*);updated=(\d+)/);
  if ((rewrite as { code?: number }).code !== 0 || !m || m[2] === '0') {
    return {
      ok: false,
      message: `Could not re-key the NPM admin password: ${(rewrite as { stderr?: string }).stderr || out || 'unknown error'}`,
    };
  }
  const email = m[1];
  const status = await npmTokenStatus(adminUrl, email, newPassword);
  if (status !== 'ok') {
    return { ok: false, message: `Re-keyed the hash but NPM still rejected the new password (status: ${status}). Nothing was saved.` };
  }
  await updateConfig({ reverseProxy: { npm: { email, password: newPassword } } });
  logger.info(LOG, `Re-keyed NPM admin password for ${email} (non-destructive; proxy hosts preserved)`);
  return { ok: true, message: 'NPM admin password re-keyed and saved — all proxy routes were preserved. ServiceBay can manage NPM again.', email };
}

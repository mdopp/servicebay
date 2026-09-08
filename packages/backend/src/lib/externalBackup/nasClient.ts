/**
 * Userspace client for the config-survival external-backup destination
 * (#1190 / #1215 / #1527).
 *
 * Default transport: **FTP** to the FritzBox USB NAS via `basic-ftp` (pure JS —
 * no native deps, no system binary, no kernel `cifs` mount, no `cap_admin`). We
 * landed on FTP because the FritzBox's SMB is off by default and the maintained
 * JS SMB libraries fail on Node 20+ (their NTLM dependency uses DES, disabled by
 * OpenSSL 3), whereas the FritzBox's FTP works cleanly with a pure-JS client.
 *
 * The destination is configurable (#1527) via `config.externalBackup.target`:
 *   - `fritzbox` (default) — FTP to the FritzBox NAS. Host/credentials default
 *     to `config.gateway` (#1525: the FritzBox is both the gateway and the
 *     USB-NAS host, so one credential source) with optional per-field override.
 *   - `ftp` — a standalone FTP(S) host (not the FritzBox).
 *   - `ssh` — an SFTP server.
 * When no target is configured we fall back to the gateway-derived FritzBox FTP
 * target, so existing boxes are unaffected.
 */
import { Client, type FileInfo } from 'basic-ftp';
import { Readable, Writable } from 'stream';
import { Client as SshClient, type SFTPWrapper } from 'ssh2';
import path from 'path';
import { getConfig, type ExternalBackupTarget } from '../config';
import { logger } from '../logger';

export interface NasTarget {
  host: string;
  user: string;
  password: string;
  /** Explicit FTPS (AUTH TLS). Default false — plain FTP on the LAN. */
  secure: boolean;
}

/** A fully-resolved destination the transport layer can act on. The `dir`
 *  prefix is prepended to every remote path (defaults to the login dir). */
type ResolvedFtpTarget = NasTarget & { transport: 'ftp'; port?: number; dir?: string };
type ResolvedSshTarget = {
  transport: 'ssh';
  host: string;
  port: number;
  user: string;
  password?: string;
  privateKey?: string;
  dir?: string;
};
type ResolvedTarget = ResolvedFtpTarget | ResolvedSshTarget;

const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Backoff before retrying an operation the destination refused at the
 * CONNECTION level (#2876). The FritzBox's FTP server has a small
 * concurrent-session / connection-rate budget: once it trips it sends FIN and
 * answers `ECONNREFUSED` for a few seconds. Without a backoff, every remaining
 * service in a run fails inside the same second — so the same tail of services
 * was never backed up, run after run. Three attempts over ~22 s is enough for
 * the FritzBox to recover and cheap enough not to stretch a nightly run.
 */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

/**
 * Errors that mean "the destination dropped or refused the connection", as
 * opposed to "this file/service is a problem". Matched on both the `code` and
 * the message because basic-ftp surfaces the FritzBox's mid-transfer FIN as a
 * plain message ("Server sent FIN packet unexpectedly, closing connection")
 * with no code, while the socket errors carry a code and no useful message.
 * The `dropped the connection` alternative is what the producer's run summary
 * says, so a recorded `lastMessage` classifies the same way a live error does.
 */
const CONNECTION_ERROR_RE =
  /ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|FIN packet unexpectedly|socket hang up|client is closed|connection (?:closed|reset|lost|dropped|timed out)|dropped the connection/i;

/** True when `error` is a connection-level failure of the destination (#2876) —
 *  the run should back off and retry rather than blame the service. Accepts an
 *  Error, a raw string (a recorded `lastMessage`), or anything else. */
export function isConnectionLevelError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  const message = error instanceof Error ? error.message : String(error);
  return CONNECTION_ERROR_RE.test(`${code} ${message}`);
}

/** Resolve the FritzBox FTP target from `config.gateway`, applying any explicit
 *  `fritzbox`-target overrides. Returns null when no complete creds exist. */
function gatewayFtpTarget(
  gw: { type?: string; host?: string; username?: string; password?: string } | undefined,
  override?: Extract<ExternalBackupTarget, { type: 'fritzbox' }>,
): ResolvedFtpTarget | null {
  const host = override?.host ?? (gw?.type === 'fritzbox' ? gw.host : undefined);
  const user = override?.username ?? (gw?.type === 'fritzbox' ? gw.username : undefined);
  const password = override?.password ?? (gw?.type === 'fritzbox' ? gw.password : undefined);
  if (!host || !user || !password) return null;
  return { transport: 'ftp', host, user, password, secure: override?.secure ?? false };
}

/** Resolve a target spec into the transport layer's shape, pulling gateway
 *  creds for the `fritzbox` case. `gw` is the gateway config to default from. */
function resolveSpec(
  target: ExternalBackupTarget | undefined,
  gw: { type?: string; host?: string; username?: string; password?: string } | undefined,
): ResolvedTarget | null {
  if (!target || target.type === 'fritzbox') {
    return gatewayFtpTarget(gw, target);
  }
  if (target.type === 'ftp') {
    if (!target.host || !target.username || !target.password) return null;
    return {
      transport: 'ftp',
      host: target.host,
      user: target.username,
      password: target.password,
      secure: target.secure ?? false,
      port: target.port,
      dir: target.dir,
    };
  }
  // ssh
  if (!target.host || !target.username || !(target.password || target.privateKey)) return null;
  return {
    transport: 'ssh',
    host: target.host,
    port: target.port ?? 22,
    user: target.username,
    password: target.password,
    privateKey: target.privateKey,
    dir: target.dir,
  };
}

/** Resolve the configured destination into something the transport layer can
 *  use, or null when nothing complete is configured. */
export async function resolveBackupTarget(): Promise<ResolvedTarget | null> {
  const config = await getConfig();
  return resolveSpec(config.externalBackup?.target, config.gateway);
}

/** Resolve FTP connection details from the configured destination, or null when
 *  it isn't a (complete) FTP target. Back-compat shim for the gateway-derived
 *  FritzBox case; SSH targets resolve via `resolveBackupTarget`. */
export async function getNasTarget(): Promise<NasTarget | null> {
  const resolved = await resolveBackupTarget();
  if (!resolved || resolved.transport !== 'ftp') return null;
  return { host: resolved.host, user: resolved.user, password: resolved.password, secure: resolved.secure };
}

function joinDir(dir: string | undefined, remotePath: string): string {
  const clean = remotePath.replace(/^\/+/, '');
  return dir ? path.posix.join(dir.replace(/^\/+/, ''), clean) : clean;
}

// ─── FTP transport (basic-ftp) ───────────────────────────────────────────

async function openFtpClient(t: ResolvedFtpTarget): Promise<Client> {
  const client = new Client(CONNECT_TIMEOUT_MS);
  // Never enable client.ftp.verbose: it logs the FTP command stream including
  // the cleartext `PASS` line (the #1211 credential-leak class).
  try {
    await client.access({ host: t.host, port: t.port, user: t.user, password: t.password, secure: t.secure });
    return client;
  } catch (e) {
    client.close();
    throw e;
  }
}

/** One connection for one operation — the shape used outside a run (probes,
 *  one-off downloads). Inside a run, {@link withNasSession} reuses one. */
async function withFtpClient<T>(t: ResolvedFtpTarget, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await openFtpClient(t);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

// ─── Run-scoped session (#2876) ──────────────────────────────────────────
//
// A 13-service backup run makes 50–70 FTP calls (list for the sweep, list +
// delete for each prune, tar upload, meta upload). One connection PER CALL blew
// through the FritzBox's session budget after ~8 services, and everything after
// that failed with FIN/ECONNREFUSED inside the same second. `withNasSession`
// makes the whole run share ONE control connection, reconnecting only after an
// error, and retries a connection-level failure with a backoff so the run
// continues with the next service instead of burning through the rest.

interface NasSession {
  /** The live control connection, or null before the first op / after a drop. */
  ftp: Client | null;
  /** The login directory, captured on connect — see {@link runFtp}. */
  home: string | null;
  /** Re-entrancy depth: a nested `withNasSession` joins the outer one. */
  depth: number;
  /** Control connections this session had to open (1 = no drop). */
  connects: number;
}

let session: NasSession | null = null;

/**
 * Run `fn` with ONE shared connection to the destination (#2876). Every
 * `nas*` operation `fn` performs reuses it; outside a session each operation
 * connects on its own exactly as before, so nothing but a run changes shape.
 * Re-entrant (a nested call joins the outer session) and always closes.
 */
export async function withNasSession<T>(fn: () => Promise<T>): Promise<T> {
  if (session) {
    session.depth += 1;
    try {
      return await fn();
    } finally {
      session.depth -= 1;
    }
  }
  const opened: NasSession = { ftp: null, home: null, depth: 1, connects: 0 };
  session = opened;
  try {
    return await fn();
  } finally {
    session = null;
    try {
      opened.ftp?.close();
    } catch {
      // Already gone — closing a dropped connection must not mask the result.
    }
    if (opened.connects > 1) {
      logger.info(
        'ExternalBackup',
        `NAS session reconnected ${opened.connects - 1} time(s) during this run.`,
      );
    }
  }
}

/** Plain-`setTimeout` sleep (not `node:timers/promises`) so the backoff is
 *  controllable by a test's fake timers. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * Consulted after each connection-level failure, before the backoff sleep, with
 * the 1-based number of the attempt that just failed. Returning `false` stops
 * the retry loop and re-throws — the caller has decided the drop needs a
 * different answer than waiting (#2888: the share is full, so the caller wants
 * to prune rather than burn the rest of the retry budget on the same disk).
 */
export type ConnectionDropHandler = (error: unknown, attempt: number) => boolean | Promise<boolean>;

/** Retry `attempt` with a backoff while it fails at the CONNECTION level. A
 *  per-service/per-file error is re-thrown immediately — only the destination
 *  dropping us is worth waiting for. `onDrop` can veto the next retry (#2888). */
async function withConnectionRetry<T>(
  attempt: () => Promise<T>,
  onDrop?: ConnectionDropHandler,
): Promise<T> {
  for (let i = 0; ; i += 1) {
    try {
      return await attempt();
    } catch (e) {
      if (i >= RETRY_DELAYS_MS.length || !isConnectionLevelError(e)) throw e;
      if (onDrop && !(await onDrop(e, i + 1))) throw e;
      const delay = RETRY_DELAYS_MS[i];
      logger.warn(
        'ExternalBackup',
        `NAS dropped the connection (${e instanceof Error ? e.message : String(e)}) — ` +
          `retrying in ${delay}ms (attempt ${i + 2}/${RETRY_DELAYS_MS.length + 1}).`,
      );
      await sleep(delay);
    }
  }
}

/**
 * Run one FTP operation on the run's shared connection when there is a session,
 * else on a connection of its own (the historical behaviour).
 *
 * The working directory is reset to the login dir before every reused call:
 * `ensureDir`/`cd` move the cwd, and the callers all pass paths relative to the
 * login dir. With a connection per call that reset was free; sharing one makes
 * it mandatory, or the second `cd('sb-backup')` of a run would resolve against
 * `sb-backup/` and fail.
 */
async function runFtp<T>(
  t: ResolvedFtpTarget,
  fn: (client: Client) => Promise<T>,
  opts: { retry?: boolean; onDrop?: ConnectionDropHandler } = {},
): Promise<T> {
  const s = session;
  if (!s) return withFtpClient(t, fn);
  const once = async (): Promise<T> => {
    try {
      if (s.ftp?.closed) s.ftp = null;
      if (!s.ftp) {
        s.ftp = await openFtpClient(t);
        s.connects += 1;
        s.home = await s.ftp.pwd();
      } else if (s.home) {
        await s.ftp.cd(s.home);
      }
      return await fn(s.ftp);
    } catch (e) {
      // A dropped connection is unusable: throw it away so the retry (or the
      // next operation) reconnects instead of replaying onto a dead socket.
      if (isConnectionLevelError(e)) {
        try {
          s.ftp?.close();
        } catch {
          // Already gone.
        }
        s.ftp = null;
      }
      throw e;
    }
  };
  return opts.retry === false ? once() : withConnectionRetry(once, opts.onDrop);
}

/** SFTP has no session to reuse (ssh2 owns its own connection lifetime), but a
 *  run still gets the backoff+retry so one refused connection does not cascade. */
async function runSftp<T>(
  t: ResolvedSshTarget,
  fn: (sftp: SFTPWrapper) => Promise<T>,
  onDrop?: ConnectionDropHandler,
): Promise<T> {
  if (!session) return withSftp(t, fn);
  return withConnectionRetry(() => withSftp(t, fn), onDrop);
}

function splitRemote(remotePath: string): { dir: string; base: string } {
  const clean = remotePath.replace(/^\/+/, '');
  const slash = clean.lastIndexOf('/');
  return slash < 0 ? { dir: '', base: clean } : { dir: clean.slice(0, slash), base: clean.slice(slash + 1) };
}

// ─── SSH/SFTP transport (ssh2) ───────────────────────────────────────────

async function withSftp<T>(t: ResolvedSshTarget, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const conn = new SshClient();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const fail = (e: Error) => { if (!settled) { settled = true; conn.end(); reject(e); } };
    conn.on('error', fail);
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) return fail(err);
        fn(sftp).then(
          v => { if (!settled) { settled = true; conn.end(); resolve(v); } },
          e => fail(e instanceof Error ? e : new Error(String(e))),
        );
      });
    });
    conn.connect({
      host: t.host,
      port: t.port,
      username: t.user,
      password: t.password,
      privateKey: t.privateKey,
      readyTimeout: CONNECT_TIMEOUT_MS,
    });
  });
}

/** Recursively create the directory `dir` over SFTP. EEXIST is fine. */
async function sftpEnsureDir(sftp: SFTPWrapper, dir: string): Promise<void> {
  if (!dir || dir === '.' || dir === '/') return;
  const parts = dir.split('/').filter(Boolean);
  let cur = dir.startsWith('/') ? '' : '.';
  for (const part of parts) {
    cur = cur === '.' ? part : `${cur}/${part}`;
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(cur, err => {
        if (err && !/exist|failure/i.test(err.message)) return reject(err);
        resolve();
      });
    });
  }
}

// ─── Public operations (transport-agnostic) ──────────────────────────────

/** Probe connectivity + auth without transferring anything. */
export async function testNasConnection(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const t = await resolveBackupTarget();
    if (!t) {
      return { ok: false, error: 'External backup destination not configured — set it in Settings → Backups.' };
    }
    if (t.transport === 'ftp') {
      await withFtpClient(t, client => client.pwd());
    } else {
      await withSftp(t, sftp => new Promise<void>((resolve, reject) => {
        sftp.realpath('.', err => (err ? reject(err) : resolve()));
      }));
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Probe a candidate target without persisting it (Settings → Backups test).
 *  A `fritzbox` candidate fills missing fields from the saved gateway creds. */
export async function testCandidateTarget(
  candidate: ExternalBackupTarget,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const t = resolveSpec(candidate, (await getConfig()).gateway);
    if (!t) {
      return { ok: false, error: 'Incomplete target — fill in host and credentials.' };
    }
    if (t.transport === 'ftp') {
      await withFtpClient(t, client => client.pwd());
    } else {
      await withSftp(t, sftp => new Promise<void>((resolve, reject) => {
        sftp.realpath('.', err => (err ? reject(err) : resolve()));
      }));
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function requireTarget(): Promise<ResolvedTarget> {
  const t = await resolveBackupTarget();
  if (!t) {
    throw new Error('External backup destination not configured — set it in Settings → Backups.');
  }
  return t;
}

export interface NasUploadOptions {
  /** Veto/allow the next connection-level retry — see {@link ConnectionDropHandler}. */
  onConnectionDrop?: ConnectionDropHandler;
  /** Force single-shot (no connection retry) even for a Buffer, for a probe
   *  whose whole point is a fast answer (#2888's capacity write test). */
  retry?: boolean;
}

/** Upload a buffer or stream to `remotePath` (relative to the destination root),
 *  creating parent directories as needed. */
export async function nasUpload(
  remotePath: string,
  data: Buffer | Readable,
  opts: NasUploadOptions = {},
): Promise<void> {
  const t = await requireTarget();
  const full = joinDir(t.dir, remotePath);
  if (t.transport === 'ftp') {
    const { dir, base } = splitRemote(full);
    await runFtp(
      t,
      async client => {
        // ensureDir creates the full path and changes into it; the upload target
        // is then the basename relative to that working directory.
        if (dir) await client.ensureDir(dir);
        // Built per attempt: a retry (#2876) needs a fresh reader, and a Readable
        // handed in by the caller can only be consumed once — hence `retry`.
        await client.uploadFrom(Buffer.isBuffer(data) ? Readable.from(data) : data, base);
      },
      { retry: opts.retry ?? Buffer.isBuffer(data), onDrop: opts.onConnectionDrop },
    );
    return;
  }
  await runSftp(t, async sftp => {
    const { dir } = splitRemote(full);
    if (dir) await sftpEnsureDir(sftp, dir);
    await new Promise<void>((resolve, reject) => {
      const ws = sftp.createWriteStream(full);
      ws.on('close', () => resolve());
      ws.on('error', reject);
      const source = Buffer.isBuffer(data) ? Readable.from(data) : data;
      source.pipe(ws);
    });
  }, opts.onConnectionDrop);
}

/** Download `remotePath` (relative to the destination root) into a Buffer. */
export async function nasDownload(remotePath: string): Promise<Buffer> {
  const t = await requireTarget();
  const full = joinDir(t.dir, remotePath);
  if (t.transport === 'ftp') {
    return runFtp(t, async client => {
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.from(chunk));
          cb();
        },
      });
      await client.downloadTo(sink, full);
      return Buffer.concat(chunks);
    });
  }
  return runSftp(t, sftp => new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const rs = sftp.createReadStream(full);
    rs.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    rs.on('end', () => resolve(Buffer.concat(chunks)));
    rs.on('error', reject);
  }));
}

/** List a directory (relative to the destination root).
 *
 * FritzBox's FTP server IGNORES a path argument to `LIST` — `client.list('sb-backup')`
 * returns the ROOT listing, not the subdir's contents. That silently made every
 * staged backup invisible (`listServiceBackups` filtered the root for `.tar`,
 * found none → empty), which in turn meant the reinstall auto-restore (#1218,
 * gated on `listServiceBackups`) never fired even with a backup present. `cd`
 * into the directory first, then bare `list()`. The `cd` is safe to leave in
 * place: {@link runFtp} resets a reused session's working directory to the
 * login dir before every operation (#2876). */
export async function nasList(dir = ''): Promise<FileInfo[]> {
  const t = await requireTarget();
  const full = joinDir(t.dir, dir);
  if (t.transport === 'ftp') {
    return runFtp(t, async client => {
      if (full) await client.cd(full);
      return client.list();
    });
  }
  return runSftp(t, sftp => new Promise<FileInfo[]>((resolve, reject) => {
    sftp.readdir(full || '.', (err, list) => {
      if (err) return reject(err);
      // Map ssh2's entry shape onto basic-ftp's FileInfo (name + size are all
      // the callers read). The cast keeps the public return type stable.
      resolve(list.map(e => ({ name: e.filename, size: e.attrs.size }) as unknown as FileInfo));
    });
  }));
}

/** Remove a file (relative to the destination root). Idempotent — a missing file
 *  resolves rather than throwing. */
export async function nasRemove(remotePath: string): Promise<void> {
  const t = await requireTarget();
  const full = joinDir(t.dir, remotePath);
  if (t.transport === 'ftp') {
    await runFtp(t, client => client.remove(full, true));
    return;
  }
  await runSftp(t, sftp => new Promise<void>((resolve) => {
    sftp.unlink(full, () => resolve()); // idempotent: ignore a missing-file error
  }));
}

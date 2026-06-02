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

async function withFtpClient<T>(t: ResolvedFtpTarget, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(CONNECT_TIMEOUT_MS);
  // Never enable client.ftp.verbose: it logs the FTP command stream including
  // the cleartext `PASS` line (the #1211 credential-leak class).
  try {
    await client.access({ host: t.host, port: t.port, user: t.user, password: t.password, secure: t.secure });
    return await fn(client);
  } finally {
    client.close();
  }
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

/** Upload a buffer or stream to `remotePath` (relative to the destination root),
 *  creating parent directories as needed. */
export async function nasUpload(remotePath: string, data: Buffer | Readable): Promise<void> {
  const t = await requireTarget();
  const full = joinDir(t.dir, remotePath);
  if (t.transport === 'ftp') {
    const { dir, base } = splitRemote(full);
    const source = Buffer.isBuffer(data) ? Readable.from(data) : data;
    await withFtpClient(t, async client => {
      // ensureDir creates the full path and changes into it; the upload target
      // is then the basename relative to that working directory.
      if (dir) await client.ensureDir(dir);
      await client.uploadFrom(source, base);
    });
    return;
  }
  await withSftp(t, async sftp => {
    const { dir } = splitRemote(full);
    if (dir) await sftpEnsureDir(sftp, dir);
    await new Promise<void>((resolve, reject) => {
      const ws = sftp.createWriteStream(full);
      ws.on('close', () => resolve());
      ws.on('error', reject);
      const source = Buffer.isBuffer(data) ? Readable.from(data) : data;
      source.pipe(ws);
    });
  });
}

/** Download `remotePath` (relative to the destination root) into a Buffer. */
export async function nasDownload(remotePath: string): Promise<Buffer> {
  const t = await requireTarget();
  const full = joinDir(t.dir, remotePath);
  if (t.transport === 'ftp') {
    return withFtpClient(t, async client => {
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
  return withSftp(t, sftp => new Promise<Buffer>((resolve, reject) => {
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
 * into the directory first, then bare `list()`. `withFtpClient` opens a fresh
 * connection per call, so there's no working dir to restore afterwards. */
export async function nasList(dir = ''): Promise<FileInfo[]> {
  const t = await requireTarget();
  const full = joinDir(t.dir, dir);
  if (t.transport === 'ftp') {
    return withFtpClient(t, async client => {
      if (full) await client.cd(full);
      return client.list();
    });
  }
  return withSftp(t, sftp => new Promise<FileInfo[]>((resolve, reject) => {
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
    await withFtpClient(t, client => client.remove(full, true));
    return;
  }
  await withSftp(t, sftp => new Promise<void>((resolve) => {
    sftp.unlink(full, () => resolve()); // idempotent: ignore a missing-file error
  }));
}

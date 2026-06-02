/**
 * Userspace client for the FritzBox USB NAS, used by the config-survival
 * backup feature (#1190 / #1215).
 *
 * Transport: **FTP** via `basic-ftp` (pure JS — no native deps, no system
 * binary, no kernel `cifs` mount, no `cap_admin`). We landed on FTP because
 * the FritzBox's SMB is off by default and the maintained JS SMB libraries
 * fail on Node 20+ (their NTLM dependency uses DES, disabled by OpenSSL 3),
 * whereas the FritzBox's FTP works cleanly with a pure-JS client.
 *
 * Credentials reuse `config.gateway` — the FritzBox USB NAS is the same
 * device and the same FritzBox user as the gateway, so there's one source of
 * truth for the host + login rather than duplicated NAS fields.
 */
import { Client, type FileInfo } from 'basic-ftp';
import { Readable, Writable } from 'stream';
import { getConfig } from '../config';

export interface NasTarget {
  host: string;
  user: string;
  password: string;
  /** Explicit FTPS (AUTH TLS). Default false — plain FTP on the LAN. */
  secure: boolean;
}

const CONNECT_TIMEOUT_MS = 15_000;

/** Resolve FTP connection details from the configured FritzBox gateway, or
 *  null when the gateway isn't configured with credentials. */
export async function getNasTarget(): Promise<NasTarget | null> {
  const gw = (await getConfig()).gateway;
  if (gw?.type !== 'fritzbox' || !gw.host || !gw.username || !gw.password) return null;
  return { host: gw.host, user: gw.username, password: gw.password, secure: false };
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const target = await getNasTarget();
  if (!target) {
    throw new Error('FritzBox NAS not configured — set the gateway (host + credentials) in Settings → Integrations.');
  }
  const client = new Client(CONNECT_TIMEOUT_MS);
  // Never enable client.ftp.verbose: it logs the FTP command stream including
  // the cleartext `PASS` line (the #1211 credential-leak class).
  try {
    await client.access({
      host: target.host,
      user: target.user,
      password: target.password,
      secure: target.secure,
    });
    return await fn(client);
  } finally {
    client.close();
  }
}

/** Probe connectivity + auth without transferring anything. */
export async function testNasConnection(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await withClient(client => client.pwd());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function splitRemote(remotePath: string): { dir: string; base: string } {
  const clean = remotePath.replace(/^\/+/, '');
  const slash = clean.lastIndexOf('/');
  return slash < 0 ? { dir: '', base: clean } : { dir: clean.slice(0, slash), base: clean.slice(slash + 1) };
}

/** Upload a buffer or stream to `remotePath` (relative to the NAS root),
 *  creating parent directories as needed. */
export async function nasUpload(remotePath: string, data: Buffer | Readable): Promise<void> {
  const { dir, base } = splitRemote(remotePath);
  const source = Buffer.isBuffer(data) ? Readable.from(data) : data;
  await withClient(async client => {
    // ensureDir creates the full path and changes into it; the upload target
    // is then the basename relative to that working directory.
    if (dir) await client.ensureDir(dir);
    await client.uploadFrom(source, base);
  });
}

/** Download `remotePath` (relative to the NAS root) into a Buffer. */
export async function nasDownload(remotePath: string): Promise<Buffer> {
  const clean = remotePath.replace(/^\/+/, '');
  return withClient(async client => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    await client.downloadTo(sink, clean);
    return Buffer.concat(chunks);
  });
}

/** List a directory (relative to the NAS root).
 *
 * FritzBox's FTP server IGNORES a path argument to `LIST` — `client.list('sb-backup')`
 * returns the ROOT listing, not the subdir's contents. That silently made every
 * staged backup invisible (`listServiceBackups` filtered the root for `.tar`,
 * found none → empty), which in turn meant the reinstall auto-restore (#1218,
 * gated on `listServiceBackups`) never fired even with a backup present. `cd`
 * into the directory first, then bare `list()`. `withClient` opens a fresh
 * connection per call, so there's no working dir to restore afterwards. */
export async function nasList(dir = ''): Promise<FileInfo[]> {
  const clean = dir.replace(/^\/+/, '');
  return withClient(async client => {
    if (clean) await client.cd(clean);
    return client.list();
  });
}

/** Remove a file (relative to the NAS root). Idempotent — a missing file
 *  resolves rather than throwing. */
export async function nasRemove(remotePath: string): Promise<void> {
  const clean = remotePath.replace(/^\/+/, '');
  await withClient(client => client.remove(clean, true));
}

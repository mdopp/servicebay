/**
 * LLDAP → Samba passdb sync for the file-share template (#494).
 *
 * NOTE on the passdb backend: the design intent was `tdbsam`, but the
 * `servercontainers/samba` image ships `passdb backend = smbpasswd`
 * (verify with `testparm -s | grep passdb`). We drive it through the
 * `smbpasswd` / `pdbedit` CLIs, which work against whichever backend is
 * configured — so this module is backend-agnostic in practice.
 *
 * Samba can't speak OIDC, and rehashing LLDAP's Argon2/bcrypt password
 * into the NT-hash Samba needs is not possible. The locked design is
 * Option A from the issue: keep per-user Samba accounts in the passdb,
 * with passwords set independently by the operator (or randomised at
 * create-time + user resets via the Settings → Integrations UI).
 *
 * This module wraps the `pdbedit` + `smbpasswd` shell incantations
 * that run inside the running `file-share-samba` container. Every
 * function returns a structured `{ ok, ... }` union so the API route
 * can render an actionable error.
 *
 * Idempotent by design: re-running the sync only adds users that are
 * in LLDAP but not yet in tdbsam, and removes users that were in
 * tdbsam but no longer exist in LLDAP. Existing Samba passwords are
 * never overwritten — set/regen is an explicit operator action.
 */

import { agentManager } from '../agent/manager';
import { listLldapUsers } from '../lldap/client';
import crypto from 'crypto';

const SAMBA_CONTAINER_NAME = 'file-share-samba';

export interface SambaUserSummary {
  /** LLDAP user id, used as the Samba username. */
  id: string;
  displayName?: string;
  email?: string;
  /** True iff `pdbedit -L` lists this user in the Samba tdbsam DB. */
  presentInSamba: boolean;
}

export type SambaSyncResult =
  | { ok: true; users: SambaUserSummary[]; added: string[]; removed: string[] }
  | { ok: false; reason: 'lldap_unavailable' | 'samba_unavailable' | 'exec_failed'; message: string };

export type SambaPasswordResult =
  | { ok: true; userId: string; password: string }
  | { ok: false; reason: 'not_in_lldap' | 'samba_unavailable' | 'exec_failed'; message: string };

/**
 * Username pattern. We refuse any LLDAP id that would need shell-escaping —
 * Samba's username is the same string we feed to `smbpasswd` via stdin
 * and to `pdbedit -u`. Conservative ASCII-only matches LLDAP's own
 * default username constraints anyway.
 */
const SAFE_USERNAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * 18 url-safe chars of randomness for the initial Samba password. Long
 * enough that brute-force isn't a concern; the operator is expected to
 * use the "Set Samba password" button to replace this with their own
 * value the first time they mount the share. Same flavour as
 * `crypto.randomBytes(...).toString('base64url')`.
 */
function generatePassword(): string {
  return crypto.randomBytes(14).toString('base64').replace(/[+/=]/g, '').slice(0, 18);
}

async function exec(node: string, cmd: string, opts: { stdin?: string; timeout?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const agent = await agentManager.ensureAgent(node);
  const res = await agent.sendCommand('exec', {
    command: cmd,
    stdin: opts.stdin,
    timeout: opts.timeout ?? 10,
  });
  return {
    code: typeof res.code === 'number' ? res.code : (res.exitCode ?? 1),
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
  };
}

/**
 * Path of the shared volume *inside* the samba container. The `data`
 * share is bind-mounted here from the host (`{{DATA_DIR}}/file-share/data`,
 * owned by the dedicated `file-share` group — see #1311). A Samba user
 * must be able to write this path, so the on-demand POSIX account we
 * create is given the share's owning gid as its primary group.
 */
const SHARE_MOUNT = '/data';

export type EnsurePosixUserResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Idempotently create the POSIX (Unix) account `smbpasswd -a` needs.
 *
 * `smbpasswd -a` does NOT create a Unix user — it `getpwnam`s the name to
 * map a uid and fails ("Failed to add entry for user X") when there is no
 * matching account (#1630). The `servercontainers/samba` image only
 * `useradd`s the single legacy `ACCOUNT_<SHARE_USER>` account at startup,
 * so per-LLDAP-user accounts have nothing to attach to.
 *
 * We create the account on demand:
 *   - skip if `getent passwd <user>` already lists it (idempotent on
 *     password resets and bulk sync);
 *   - otherwise `useradd -M -s /usr/sbin/nologin`, with the user's primary
 *     group set to the gid that owns the share mount so writes to `/data`
 *     succeed (the share is group-owned + setgid + default-ACL per #1311).
 *
 * Best-effort on the group mapping: if the share's owning gid can't be
 * resolved we still create the user (with a default group) so password
 * provisioning isn't blocked — a misconfigured mount is a separate fault.
 */
export async function ensureSambaPosixUser(node: string, userId: string): Promise<EnsurePosixUserResult> {
  // Already present → nothing to do (idempotent).
  const existing = await exec(node, `podman exec ${SAMBA_CONTAINER_NAME} getent passwd ${userId}`, { timeout: 10 });
  if (existing.code === 0 && existing.stdout.trim()) {
    return { ok: true };
  }

  // Resolve the gid that owns the share mount so the new user can write it.
  // `stat -c %g` prints the numeric group id of /data inside the container.
  let shareGid: number | null = null;
  const statRes = await exec(node, `podman exec ${SAMBA_CONTAINER_NAME} stat -c %g ${SHARE_MOUNT}`, { timeout: 10 });
  if (statRes.code === 0) {
    const parsed = Number.parseInt(statRes.stdout.trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 0) shareGid = parsed;
  }

  // Build the useradd. -M: no home dir. -s /usr/sbin/nologin: no shell.
  // -g <gid>: primary group = share owner (so /data is writable). When the
  // gid has no matching group entry, useradd -g <numeric> still works (it
  // accepts a raw gid), so we don't need to groupadd first.
  const groupArg = shareGid !== null ? `-g ${shareGid} ` : '';
  const addCmd = `podman exec ${SAMBA_CONTAINER_NAME} useradd -M -s /usr/sbin/nologin ${groupArg}${userId}`;
  const addRes = await exec(node, addCmd, { timeout: 10 });
  if (addRes.code !== 0) {
    return {
      ok: false,
      message: `Could not create POSIX user '${userId}' in ${SAMBA_CONTAINER_NAME} (useradd exit ${addRes.code}): ${(addRes.stderr || addRes.stdout || '').slice(0, 200)}`,
    };
  }
  return { ok: true };
}

/**
 * Parse the output of `pdbedit -L`. Each line looks like
 *   `username:1001:Full Name`
 * but the locked design only relies on the leading username, so we
 * tolerate anything past the first colon. Empty / non-conforming
 * lines are dropped silently.
 */
export function parsePdbeditList(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.split(':')[0])
    .filter(name => SAFE_USERNAME.test(name));
}

/** List Samba's tdbsam usernames. Returns `null` when the container
 *  isn't reachable (file-share not installed, samba container down). */
async function listSambaUsers(node: string): Promise<string[] | null> {
  const cmd = `podman exec ${SAMBA_CONTAINER_NAME} pdbedit -L`;
  const res = await exec(node, cmd, { timeout: 10 });
  if (res.code !== 0) return null;
  return parsePdbeditList(res.stdout);
}

/**
 * Sync LLDAP users → Samba tdbsam.
 *
 *   - Users in LLDAP missing from Samba: added with a random initial
 *     password (the operator can replace it via Settings → Integrations
 *     → File Share).
 *   - Users in Samba missing from LLDAP: removed via `pdbedit -x`.
 *   - Users present in both: left alone (no password overwrite).
 *
 * Returns the merged view of who's where so the UI can render a
 * per-user "Set password" affordance.
 */
export async function syncSambaWithLldap(node: string = 'Local'): Promise<SambaSyncResult> {
  const lldap = await listLldapUsers();
  if (!lldap.ok) {
    return { ok: false, reason: 'lldap_unavailable', message: lldap.message };
  }
  const lldapUsers = lldap.users.filter(u => SAFE_USERNAME.test(u.id));

  const sambaUsers = await listSambaUsers(node);
  if (sambaUsers === null) {
    return { ok: false, reason: 'samba_unavailable', message: `Could not run \`pdbedit -L\` in ${SAMBA_CONTAINER_NAME}. Is the file-share template deployed and the container running?` };
  }

  const sambaSet = new Set(sambaUsers);
  const lldapSet = new Set(lldapUsers.map(u => u.id));

  const toAdd = lldapUsers.filter(u => !sambaSet.has(u.id));
  const toRemove = sambaUsers.filter(s => !lldapSet.has(s));

  const added: string[] = [];
  for (const u of toAdd) {
    // smbpasswd -a requires an existing POSIX account — create it first
    // (idempotently) or the add fails with "Failed to add entry" (#1630).
    const posix = await ensureSambaPosixUser(node, u.id);
    if (!posix.ok) {
      // Couldn't provision the Unix account — skip the smbpasswd add. The
      // user stays presentInSamba=false so the UI surfaces a retry.
      continue;
    }
    const pw = generatePassword();
    // smbpasswd -s -a <user>: -s reads stdin (newpass\nnewpass), -a adds.
    // Conservative escape of username via SAFE_USERNAME above; password
    // goes via stdin, never the command line.
    const cmd = `podman exec -i ${SAMBA_CONTAINER_NAME} smbpasswd -s -a ${u.id}`;
    const res = await exec(node, cmd, { stdin: `${pw}\n${pw}\n`, timeout: 10 });
    if (res.code === 0) added.push(u.id);
    // If the add fails, the user just stays missing from Samba. The
    // sync result still surfaces them via presentInSamba=false so the
    // UI can retry.
  }

  const removed: string[] = [];
  for (const s of toRemove) {
    const cmd = `podman exec ${SAMBA_CONTAINER_NAME} pdbedit -x -u ${s}`;
    const res = await exec(node, cmd, { timeout: 10 });
    if (res.code === 0) removed.push(s);
  }

  const final = new Set([...sambaSet, ...added].filter(name => !removed.includes(name)));
  return {
    ok: true,
    users: lldapUsers.map((u): SambaUserSummary => ({
      id: u.id,
      displayName: u.displayName,
      email: u.email,
      presentInSamba: final.has(u.id),
    })),
    added,
    removed,
  };
}

/**
 * Set (or regenerate) the Samba password for a specific LLDAP user.
 * Pass `password` to set a chosen value, omit it to roll a fresh
 * random one (returned in the result so the UI can flash it once for
 * the operator to copy).
 *
 * The user must already exist in LLDAP — we refuse to set a Samba
 * password for an identity that's not in the directory, to keep
 * tdbsam in lockstep with LLDAP. To add a new user, run `syncSambaWithLldap`
 * after the LLDAP-side create.
 */
export async function setSambaPassword(
  userId: string,
  options: { node?: string; password?: string } = {},
): Promise<SambaPasswordResult> {
  if (!SAFE_USERNAME.test(userId)) {
    return { ok: false, reason: 'not_in_lldap', message: `'${userId}' is not a valid username.` };
  }
  const node = options.node ?? 'Local';

  // Sanity: the user must exist in LLDAP. This both prevents the
  // orphan-tdbsam-account case and gives the caller a meaningful error
  // when the username has a typo.
  const lldap = await listLldapUsers();
  if (lldap.ok && !lldap.users.some(u => u.id === userId)) {
    return { ok: false, reason: 'not_in_lldap', message: `LLDAP has no user with id '${userId}'. Create the user in LLDAP first.` };
  }
  // If LLDAP itself is unreachable we still let the password set proceed
  // — the operator might be fixing a Samba-only outage and we don't
  // want to gate that on LLDAP availability.

  // smbpasswd -a maps the name to a Unix uid via getpwnam — it does NOT
  // create the POSIX account. Provision it first (idempotently) so the
  // add succeeds and the account can write the share (#1630).
  const posix = await ensureSambaPosixUser(node, userId);
  if (!posix.ok) {
    return { ok: false, reason: 'exec_failed', message: posix.message };
  }

  const password = options.password ?? generatePassword();
  // smbpasswd -s -a: -s reads the password from stdin (newpass\nnewpass\n),
  // -a adds the entry (or updates the password if it already exists).
  const cmd = `podman exec -i ${SAMBA_CONTAINER_NAME} smbpasswd -s -a ${userId}`;
  const res = await exec(node, cmd, { stdin: `${password}\n${password}\n`, timeout: 10 });
  if (res.code !== 0) {
    return {
      ok: false,
      reason: 'exec_failed',
      message: `Could not set Samba password (smbpasswd exit ${res.code}): ${(res.stderr || res.stdout || '').slice(0, 200)}`,
    };
  }
  return { ok: true, userId, password };
}

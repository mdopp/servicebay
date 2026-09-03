/**
 * On-disk state self-heals that run once, before the deploy loop (#2742 —
 * split out of `runner.ts`). Part of the pre-flight phase; `./preflight`
 * calls this, the runner does not.
 *
 * All three exist because a data dir can survive a reinstall while the
 * credential that unlocks it does not:
 *   - Authelia's SQLite storage vs `AUTHELIA_STORAGE_ENCRYPTION_KEY`;
 *   - LLDAP's `users.db` vs `LLDAP_ADMIN_PASSWORD`;
 *   - NPM's cert archive + admin DB vs a freshly generated NPM password.
 *
 * Every one is best-effort: a probe failure logs a recovery one-liner and
 * lets the install continue rather than blocking it.
 */
import crypto from 'node:crypto';
import { getConfig } from '@/lib/config';
import type { JobInput } from '../jobStore';
import { log } from './context';

/** The topo-sorted item shape these heals gate on. */
interface SelectedItem {
  name: string;
  alreadyInstalled?: boolean;
}

/**
 * The wipe decision, pure so the three-way rule is readable on its own:
 *   - a recorded fingerprint that differs from this install's key → wipe;
 *   - a recorded fingerprint that matches (or no new key) → keep;
 *   - no fingerprint at all → the legacy heuristic: wipe iff there IS data
 *     and the key was freshly generated rather than reused from savedSecrets.
 */
function decideAutheliaWipe(args: {
  recordedFp: string;
  newFp: string;
  hasContent: boolean;
  keyWasReused: boolean;
}): { shouldWipe: boolean; reason: string } {
  if (args.recordedFp) {
    return args.newFp && args.recordedFp !== args.newFp
      ? { shouldWipe: true, reason: 'encryption-key fingerprint changed since the last successful deploy' }
      : { shouldWipe: false, reason: '' };
  }
  if (args.hasContent && !args.keyWasReused) {
    // Legacy path: no fingerprint recorded (pre-fix install) but data
    // exists and the new key isn't from savedSecrets — almost certainly
    // a key mismatch.
    return {
      shouldWipe: true,
      reason: 'data dir has content, encryption key was freshly generated, and no fingerprint exists to prove the key matches',
    };
  }
  return { shouldWipe: false, reason: '' };
}

/** Probe both the recorded key fingerprint and whether the data dir holds
 *  anything else, in ONE agent round-trip. Output format:
 *  "FP=<hex|>\nCONTENT=<something|>". */
async function probeAutheliaDataDir(
  agent: { sendCommand: (cmd: string, args: { command: string }) => Promise<{ stdout?: string }> },
  autheliaDataPath: string,
  fingerprintPath: string,
): Promise<{ recordedFp: string; hasContent: boolean }> {
  const probe = await agent.sendCommand('exec', {
    command:
      `printf 'FP=%s\\n' "$(cat "${fingerprintPath}" 2>/dev/null || true)"; ` +
      `printf 'CONTENT=%s\\n' "$([ -d "${autheliaDataPath}" ] && find "${autheliaDataPath}" -mindepth 1 -maxdepth 1 -not -name .sb-key-fingerprint | head -1 || true)"`,
  });
  const out = probe.stdout || '';
  return {
    recordedFp: (out.match(/^FP=([a-f0-9]{64})$/m)?.[1] || '').trim(),
    hasContent: !!(out.match(/^CONTENT=(.+)$/m)?.[1] || '').trim(),
  };
}

/**
 * Authelia storage self-heal — Authelia encrypts its SQLite storage
 * with AUTHELIA_STORAGE_ENCRYPTION_KEY. If the data dir survives a
 * reinstall but the new key doesn't match what encrypted that data,
 * Authelia crashes on startup ("encryption key does not appear to be
 * valid for this database") and loops indefinitely.
 *
 * We track a SHA-256 fingerprint of the encryption key in a sidecar
 * file (`.sb-key-fingerprint`) inside the data dir. On every install
 * where auth is being deployed:
 *   - If the fingerprint file matches the new key → keep the data.
 *   - If it exists and differs → wipe (real mismatch, Authelia would crash).
 *   - If it's missing → fall back to the legacy heuristic: wipe iff
 *     the data dir has content AND the key was freshly generated
 *     (not reused from savedSecrets). This covers pre-fingerprint
 *     upgrades.
 * After deciding, write the new fingerprint so the next install can
 * check it. LLDAP user accounts at the sibling `auth/lldap` host
 * path are preserved either way.
 */
async function healAutheliaStorage(
  jobId: string,
  input: JobInput,
  reusedSecretNames: Set<string>,
): Promise<void> {
  try {
    const { agentManager } = await import('@/lib/agent/manager');
    const { getConfig } = await import('@/lib/config');
    const cfg = await getConfig();
    const dataDir = cfg.templateSettings?.DATA_DIR || '/mnt/data/stacks';
    const autheliaDataPath = `${dataDir}/auth/authelia-data`;
    const fingerprintPath = `${autheliaDataPath}/.sb-key-fingerprint`;
    const newKey = input.variables.find(v => v.name === 'AUTHELIA_STORAGE_ENCRYPTION_KEY')?.value || '';
    const newFp = newKey
      ? crypto.createHash('sha256').update(newKey).digest('hex')
      : '';
    const node = input.node || 'Local';
    const agent = await agentManager.ensureAgent(node);
    const { recordedFp, hasContent } = await probeAutheliaDataDir(agent, autheliaDataPath, fingerprintPath);
    const { shouldWipe, reason } = decideAutheliaWipe({
      recordedFp,
      newFp,
      hasContent,
      keyWasReused: reusedSecretNames.has('AUTHELIA_STORAGE_ENCRYPTION_KEY'),
    });
    if (shouldWipe) {
      await log(jobId, `🔄 Wiping Authelia storage at ${autheliaDataPath} — ${reason} (LLDAP users at ${dataDir}/auth/lldap are kept).`);
      await agent.sendCommand('exec', { command: `rm -rf "${autheliaDataPath}"` });
      await log(jobId, `✅ Authelia storage cleared. Authelia will bootstrap fresh on first start.`);
    }
    // Always (re)create the dir and stamp the new fingerprint. Done
    // after a potential wipe so it lands in the recreated dir.
    if (newFp) {
      await agent.sendCommand('exec', {
        command:
          `mkdir -p "${autheliaDataPath}" && chown core:core "${autheliaDataPath}" && ` +
          `printf '%s\\n' "${newFp}" > "${fingerprintPath}"`,
      });
    }
  } catch (e) {
    // Best-effort: if probe/wipe fails the install will hit the
    // readiness-probe 5-min timeout. Surface the recovery one-liner
    // so the operator can unstick themselves manually.
    const dataDirFallback = (await getConfig()).templateSettings?.DATA_DIR || '/mnt/data/stacks';
    await log(jobId, `(note) couldn't auto-clear Authelia storage: ${e instanceof Error ? e.message : String(e)}. If readiness times out, SSH to the node and \`rm -rf ${dataDirFallback}/auth/authelia-data\` before retrying.`);
  }
}

/**
 * LLDAP admin-password self-heal (#666 / ARCH-15). LLDAP only seeds its
 * admin password from env on first DB init; on a reinstall over a
 * preserved users.db the DB keeps its old admin password while Authelia
 * binds with this install's LLDAP_ADMIN_PASSWORD → "Invalid Credentials"
 * crash loop. `authDynamicVars` forces LLDAP_FORCE_LDAP_USER_PASS_RESET=
 * always on every auth deploy to re-sync it (idempotent, non-destructive
 * — user accounts are preserved). This block just surfaces a log when an
 * existing DB is present so the operator sees why the bind gets re-keyed.
 * Note: deliberately NOT gated on `!reusedSecretNames.has(...)` — once a
 * saved secret and a preserved DB diverge, that heuristic misses the
 * mismatch and the bind fails forever.
 */
async function reportLldapDrift(jobId: string, input: JobInput): Promise<void> {
  try {
    const { agentManager } = await import('@/lib/agent/manager');
    const { getConfig } = await import('@/lib/config');
    const cfg = await getConfig();
    const dataDir = cfg.templateSettings?.DATA_DIR || '/mnt/data/stacks';
    const lldapDbPath = `${dataDir}/auth/lldap/users.db`;
    const node = input.node || 'Local';
    const agent = await agentManager.ensureAgent(node);
    const probe = await agent.sendCommand('exec', {
      command: `[ -s "${lldapDbPath}" ] && echo present || true`,
    });
    const dbPresent = (probe.stdout || '').trim() === 'present';
    if (dbPresent) {
      await log(jobId, `🔄 Existing LLDAP database found — re-syncing the admin bind to this install's password (LLDAP_FORCE_LDAP_USER_PASS_RESET=always) so a preserved users.db can't lock Authelia out. User accounts are preserved.`);
    }
  } catch (e) {
    await log(jobId, `(note) LLDAP drift probe failed: ${e instanceof Error ? e.message : String(e)} — continuing.`);
  }
}

/**
 * Point this run's NPM admin variables at the credentials the restored sqlite
 * DB actually holds. Returns true when something changed.
 *
 * Mutates `input.variables` in-place. The deploy loop reads through the same
 * reference, so the override propagates without persisting back to the job
 * state. `updateJob` deliberately disallows input updates to keep the
 * wizard's submitted intent immutable on disk — a server restart mid-install
 * transitions the job to `crashed` anyway, and the operator restarts from the
 * wizard with fresh state.
 */
function overrideNpmAdminVars(input: JobInput, savedEmail: string, savedPassword: string): boolean {
  let overrode = false;
  for (const v of input.variables) {
    if (v.name === 'NGINX_ADMIN_EMAIL' && v.value !== savedEmail) {
      v.value = savedEmail;
      overrode = true;
    }
    if (v.name === 'NGINX_ADMIN_PASSWORD' && v.value !== savedPassword) {
      v.value = savedPassword;
      overrode = true;
    }
  }
  return overrode;
}

/** The newest NPM cert archive worth restoring, or null.
 *
 *  Only restore onto a FRESH NPM dir — leaving existing cert state alone so a
 *  re-deploy that isn't preceded by a reset doesn't clobber whatever the
 *  operator did since the last archive. */
async function findRestorableCertArchive(
  agent: { sendCommand: (cmd: string, args: { command: string }) => Promise<{ stdout?: string }> },
  dataDir: string,
): Promise<string | null> {
  const probe = await agent.sendCommand('exec', {
    command: `[ -d "${dataDir}/nginx-proxy-manager" ] && find "${dataDir}/nginx-proxy-manager" -mindepth 1 -maxdepth 1 | head -1 || true`,
  });
  if ((probe.stdout || '').trim()) return null;

  const newest = await agent.sendCommand('exec', {
    command: `ls -1t /mnt/data/servicebay/cert-archive/npm-*.tar.gz 2>/dev/null | head -1 || true`,
  });
  return (newest.stdout || '').trim() || null;
}

/**
 * Cert archive restore — runs once before the deploy loop when nginx
 * is in the install set AND the volume on disk is empty (fresh
 * install). The reset endpoint snapshots NPM's data dir to
 * /mnt/data/servicebay/cert-archive/ before wiping; restoring the
 * most-recent snapshot here lets NPM come up with the previous
 * certificate + sqlite-DB state intact, so re-issuance is skipped
 * and we don't burn LE's 5-duplicate-certs-per-168h limit.
 */
async function restoreNpmCertArchive(jobId: string, input: JobInput): Promise<void> {
  try {
    const { agentManager } = await import('@/lib/agent/manager');
    const { getConfig } = await import('@/lib/config');
    const cfg = await getConfig();
    const dataDir = cfg.templateSettings?.DATA_DIR || '/mnt/data/stacks';
    const node = input.node || 'Local';
    const agent = await agentManager.ensureAgent(node);
    const archivePath = await findRestorableCertArchive(agent, dataDir);
    if (!archivePath) return;

    await log(jobId, `🔒 Restoring NPM cert archive from ${archivePath} — skipping re-issuance against Let's Encrypt.`);
    await agent.sendCommand('exec', {
      command: `mkdir -p "${dataDir}" && tar xzf "${archivePath}" -C "${dataDir}"`,
    });
    await log(jobId, `✅ Cert archive restored. NPM will pick up existing certs on first start.`);

    // The archive contains NPM's sqlite DB, which has the previous
    // admin credentials bcrypt-hashed inside. NPM ignores
    // INITIAL_ADMIN_* env vars when the user table is already
    // seeded, so the wizard's fresh random NGINX_ADMIN_PASSWORD
    // would never authenticate — bootstrap times out, all cert
    // requests cascade-fail with "defaults_rejected". Saved creds
    // from config.reverseProxy.npm survived the reset (it only
    // wipes service data, not config), so override the wizard's
    // generated values with them to match what's actually in the
    // restored DB.
    const savedEmail = cfg.reverseProxy?.npm?.email;
    const savedPassword = cfg.reverseProxy?.npm?.password;
    if (savedEmail && savedPassword) {
      if (overrideNpmAdminVars(input, savedEmail, savedPassword)) {
        await log(jobId, `🔑 Reusing NPM admin (${savedEmail}) from before the reset so the restored DB stays accessible.`);
      }
    } else {
      await log(jobId, `(note) cert archive restored, but no NPM admin password saved in config — bootstrap will likely prompt for the existing password.`);
    }
  } catch (e) {
    // Best-effort — a restore failure shouldn't block the install.
    // Operator can always click "Retry Let's Encrypt" in NPM later.
    await log(jobId, `(note) cert archive restore skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Run every on-disk state heal the selected set calls for. */
export async function runStateSelfHeal(
  jobId: string,
  input: JobInput,
  selected: ReadonlyArray<SelectedItem>,
  reusedSecretNames: Set<string>,
): Promise<void> {
  const authIncluded = selected.some(s => s.name === 'auth' && !s.alreadyInstalled);
  if (authIncluded) {
    await healAutheliaStorage(jobId, input, reusedSecretNames);
    await reportLldapDrift(jobId, input);
  }
  if (selected.some(s => s.name === 'nginx' && !s.alreadyInstalled)) {
    await restoreNpmCertArchive(jobId, input);
  }
}

/**
 * The on-disk state self-heals (#2742 cut of #666/#704/ARCH-15).
 *
 * All three exist for one shape of bug: a data dir survives a reinstall while
 * the credential that unlocks it does not. So the assertions here are about
 * the *decision* each heal makes — wipe vs keep, restore vs leave alone — and
 * about every failure path staying best-effort, because a probe that throws
 * must never block an install.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { JobInput } from '../jobStore';

const logMock = vi.fn<(jobId: string, line: string) => Promise<void>>();
vi.mock('./context', () => ({ log: (jobId: string, line: string) => logMock(jobId, line) }));

const getConfigMock = vi.fn();
vi.mock('@/lib/config', () => ({ getConfig: () => getConfigMock() }));

const sendCommandMock = vi.fn<(cmd: string, args: { command: string }) => Promise<{ stdout?: string }>>();
const ensureAgentMock = vi.fn();
vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: (node: string) => ensureAgentMock(node) },
}));

import { runStateSelfHeal } from './stateSelfHeal';

const KEY = 'authelia-storage-key';
const FP_OF_KEY = crypto.createHash('sha256').update(KEY).digest('hex');
const DATA_DIR = '/mnt/data/stacks';
const AUTHELIA_DIR = `${DATA_DIR}/auth/authelia-data`;

const input = (over: Partial<JobInput> = {}): JobInput => ({
  items: [],
  variables: [{ name: 'AUTHELIA_STORAGE_ENCRYPTION_KEY', value: KEY }],
  templateSource: 'Built-in',
  host: 'servicebay.local',
  ...over,
});

/** Route each probe the heals issue to a canned answer. */
const box = (opts: {
  fp?: string;
  autheliaContent?: string;
  lldapDb?: boolean;
  npmDirEntry?: string;
  certArchive?: string;
} = {}) => async (_cmd: string, args: { command: string }) => {
  const c = args.command;
  if (c.includes("printf 'FP=%s")) {
    return { stdout: `FP=${opts.fp ?? ''}\nCONTENT=${opts.autheliaContent ?? ''}\n` };
  }
  if (c.includes('users.db')) return { stdout: opts.lldapDb ? 'present\n' : '' };
  if (c.includes('nginx-proxy-manager" -mindepth')) return { stdout: opts.npmDirEntry ?? '' };
  if (c.includes('cert-archive')) return { stdout: opts.certArchive ?? '' };
  return { stdout: '' };
};

const commands = () => sendCommandMock.mock.calls.map(c => c[1].command);
const lines = () => logMock.mock.calls.map(c => c[1]);
const authSelected = [{ name: 'auth' }];
const nginxSelected = [{ name: 'nginx' }];

beforeEach(() => {
  logMock.mockReset().mockResolvedValue(undefined);
  getConfigMock.mockReset().mockResolvedValue({});
  sendCommandMock.mockReset().mockImplementation(box());
  ensureAgentMock.mockReset().mockResolvedValue({ sendCommand: sendCommandMock });
});

describe('runStateSelfHeal — which heals the selection calls for', () => {
  it('runs nothing when neither auth nor nginx is being deployed', async () => {
    await runStateSelfHeal('job1', input(), [{ name: 'immich' }], new Set());
    expect(ensureAgentMock).not.toHaveBeenCalled();
    expect(logMock).not.toHaveBeenCalled();
  });

  it('skips an already-installed auth/nginx — the heals are deploy-time only', async () => {
    await runStateSelfHeal(
      'job1',
      input(),
      [{ name: 'auth', alreadyInstalled: true }, { name: 'nginx', alreadyInstalled: true }],
      new Set(),
    );
    expect(ensureAgentMock).not.toHaveBeenCalled();
  });

  it('targets the install node', async () => {
    await runStateSelfHeal('job1', input({ node: 'box2' }), authSelected, new Set());
    expect(ensureAgentMock).toHaveBeenCalledWith('box2');
  });
});

describe('the Authelia storage heal', () => {
  it('keeps the data when the recorded fingerprint matches this install’s key', async () => {
    sendCommandMock.mockImplementation(box({ fp: FP_OF_KEY, autheliaContent: 'db.sqlite3' }));

    await runStateSelfHeal('job1', input(), authSelected, new Set());

    expect(commands().some(c => c.startsWith('rm -rf'))).toBe(false);
    // The fingerprint is (re-)stamped either way so the next install can check it.
    expect(commands().some(c => c.includes(`printf '%s\\n' "${FP_OF_KEY}"`))).toBe(true);
  });

  it('wipes when the recorded fingerprint proves the key changed', async () => {
    sendCommandMock.mockImplementation(box({ fp: 'a'.repeat(64), autheliaContent: 'db.sqlite3' }));

    await runStateSelfHeal('job1', input(), authSelected, new Set());

    expect(commands()).toContain(`rm -rf "${AUTHELIA_DIR}"`);
    expect(lines()[0]).toBe(
      `🔄 Wiping Authelia storage at ${AUTHELIA_DIR} — encryption-key fingerprint changed since the last successful deploy (LLDAP users at ${DATA_DIR}/auth/lldap are kept).`,
    );
    expect(lines()[1]).toContain('Authelia storage cleared');
  });

  it('falls back to the legacy heuristic when no fingerprint was ever recorded', async () => {
    // Data present + a freshly generated key ⇒ almost certainly the mismatch
    // that crash-loops Authelia forever.
    sendCommandMock.mockImplementation(box({ autheliaContent: 'db.sqlite3' }));

    await runStateSelfHeal('job1', input(), authSelected, new Set());

    expect(commands()).toContain(`rm -rf "${AUTHELIA_DIR}"`);
    expect(lines()[0]).toContain('data dir has content, encryption key was freshly generated');
  });

  it('keeps the data under the legacy heuristic when the key was reused from savedSecrets', async () => {
    sendCommandMock.mockImplementation(box({ autheliaContent: 'db.sqlite3' }));

    await runStateSelfHeal('job1', input(), authSelected, new Set(['AUTHELIA_STORAGE_ENCRYPTION_KEY']));

    expect(commands().some(c => c.startsWith('rm -rf'))).toBe(false);
  });

  it('keeps an empty data dir — there is nothing that could be mis-keyed', async () => {
    sendCommandMock.mockImplementation(box({}));
    await runStateSelfHeal('job1', input(), authSelected, new Set());
    expect(commands().some(c => c.startsWith('rm -rf'))).toBe(false);
  });

  it('stamps no fingerprint when this install carries no encryption key', async () => {
    await runStateSelfHeal('job1', input({ variables: [] }), authSelected, new Set());
    expect(commands().some(c => c.startsWith('mkdir -p'))).toBe(false);
  });

  it('hands the operator the manual recovery command when the probe fails', async () => {
    // Best-effort: the install continues and will hit the readiness timeout,
    // so the note has to say how to unstick it.
    sendCommandMock.mockRejectedValue(new Error('agent timeout'));

    await runStateSelfHeal('job1', input(), authSelected, new Set());

    expect(lines()[0]).toBe(
      `(note) couldn't auto-clear Authelia storage: agent timeout. If readiness times out, SSH to the node and \`rm -rf ${AUTHELIA_DIR}\` before retrying.`,
    );
  });
});

describe('the LLDAP drift report', () => {
  it('explains the re-key when a users.db survived the reinstall (#666)', async () => {
    sendCommandMock.mockImplementation(box({ lldapDb: true }));

    await runStateSelfHeal('job1', input(), authSelected, new Set());

    expect(lines().some(l => l.includes('Existing LLDAP database found') && l.includes('User accounts are preserved'))).toBe(true);
  });

  it('says nothing on a box with no LLDAP database yet', async () => {
    sendCommandMock.mockImplementation(box({ lldapDb: false }));
    await runStateSelfHeal('job1', input(), authSelected, new Set());
    expect(lines().some(l => l.includes('Existing LLDAP database found'))).toBe(false);
  });
});

describe('the NPM cert-archive restore', () => {
  const ARCHIVE = '/mnt/data/servicebay/cert-archive/npm-2026-01-01.tar.gz';

  it('restores the newest archive onto a fresh NPM dir and re-points the admin creds', async () => {
    // Restoring the sqlite DB brings back the OLD admin bcrypt, so the
    // wizard's fresh random password would never authenticate.
    getConfigMock.mockResolvedValue({ reverseProxy: { npm: { email: 'admin@box', password: 'from-before' } } });
    sendCommandMock.mockImplementation(box({ certArchive: ARCHIVE }));
    const jobInput = input({ variables: [
      { name: 'NGINX_ADMIN_EMAIL', value: 'generated@wizard' },
      { name: 'NGINX_ADMIN_PASSWORD', value: 'generated' },
    ] });

    await runStateSelfHeal('job1', jobInput, nginxSelected, new Set());

    expect(commands()).toContain(`mkdir -p "${DATA_DIR}" && tar xzf "${ARCHIVE}" -C "${DATA_DIR}"`);
    expect(lines()[0]).toBe(`🔒 Restoring NPM cert archive from ${ARCHIVE} — skipping re-issuance against Let's Encrypt.`);
    expect(lines().at(-1)).toContain('Reusing NPM admin (admin@box) from before the reset');
    // The deploy loop reads through the same variables reference.
    expect(jobInput.variables.map(v => v.value)).toEqual(['admin@box', 'from-before']);
  });

  it('leaves an existing NPM dir completely alone', async () => {
    sendCommandMock.mockImplementation(box({ npmDirEntry: `${DATA_DIR}/nginx-proxy-manager/data`, certArchive: ARCHIVE }));

    await runStateSelfHeal('job1', input(), nginxSelected, new Set());

    expect(commands().some(c => c.includes('tar xzf'))).toBe(false);
    expect(logMock).not.toHaveBeenCalled();
  });

  it('does nothing when there is no archive to restore', async () => {
    sendCommandMock.mockImplementation(box({ certArchive: '' }));
    await runStateSelfHeal('job1', input(), nginxSelected, new Set());
    expect(commands().some(c => c.includes('tar xzf'))).toBe(false);
    expect(logMock).not.toHaveBeenCalled();
  });

  it('warns that bootstrap will prompt when no NPM admin password was saved', async () => {
    getConfigMock.mockResolvedValue({ reverseProxy: { npm: { email: 'admin@box' } } });
    sendCommandMock.mockImplementation(box({ certArchive: ARCHIVE }));

    await runStateSelfHeal('job1', input(), nginxSelected, new Set());

    expect(lines().at(-1)).toContain('no NPM admin password saved in config');
  });

  it('stays quiet when the saved creds already match this run’s variables', async () => {
    getConfigMock.mockResolvedValue({ reverseProxy: { npm: { email: 'admin@box', password: 'same' } } });
    sendCommandMock.mockImplementation(box({ certArchive: ARCHIVE }));

    await runStateSelfHeal('job1', input({ variables: [
      { name: 'NGINX_ADMIN_EMAIL', value: 'admin@box' },
      { name: 'NGINX_ADMIN_PASSWORD', value: 'same' },
    ] }), nginxSelected, new Set());

    expect(lines().some(l => l.includes('Reusing NPM admin'))).toBe(false);
  });

  it('notes a restore failure instead of failing the install', async () => {
    sendCommandMock.mockRejectedValue(new Error('tar: no space left'));
    await runStateSelfHeal('job1', input(), nginxSelected, new Set());
    expect(lines()).toContain('(note) cert archive restore skipped: tar: no space left');
  });
});

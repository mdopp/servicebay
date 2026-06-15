/**
 * npmAdminCredStatus — the detection the install-runner self-heal gates
 * on (re-key only when NPM rejects/lacks the stored admin creds, never
 * when they work or NPM is unreachable). The rekey mechanic itself was
 * validated live + is covered through the diagnose action test.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  services: [] as any[],
  config: {} as any,
  fetchStatus: 200,
  fetchThrows: false,
  fetchBody: {} as any,
};

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: { listServices: vi.fn(async () => state.services) },
}));
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => state.config),
  updateConfig: vi.fn(async () => {}),
}));
const sendCommand = vi.fn();
vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: vi.fn(async () => ({ sendCommand })) },
}));

vi.stubGlobal('fetch', vi.fn(async () => {
  if (state.fetchThrows) throw new Error('refused');
  return { ok: state.fetchStatus < 400, status: state.fetchStatus, json: async () => state.fetchBody } as unknown as Response;
}));

import { npmAdminCredStatus, rekeyNpmAdmin } from './npmAdminRekey';

const ACTIVE_NGINX = [{ name: 'nginx-web', active: true, ports: [{ host: '81', container: '81' }] }];

beforeEach(() => {
  state.services = ACTIVE_NGINX;
  state.config = { reverseProxy: { npm: { email: 'a@b.c', password: 'pw' } } };
  state.fetchStatus = 200;
  state.fetchThrows = false;
  state.fetchBody = {};
  sendCommand.mockReset();
});

describe('npmAdminCredStatus', () => {
  it("returns 'unknown' when nginx isn't deployed/active (skip — can't tell)", async () => {
    state.services = [{ name: 'nginx-web', active: false }];
    expect(await npmAdminCredStatus('Local')).toBe('unknown');
  });

  it("returns 'no-creds' when NPM is up but no admin password is stored", async () => {
    state.config = { reverseProxy: { npm: { email: 'a@b.c', password: '' } } };
    expect(await npmAdminCredStatus('Local')).toBe('no-creds');
  });

  it("returns 'ok' when NPM accepts the stored creds", async () => {
    state.fetchStatus = 200;
    expect(await npmAdminCredStatus('Local')).toBe('ok');
  });

  it("returns 'rejected' when NPM 401s the stored creds (→ re-key)", async () => {
    state.fetchStatus = 401;
    expect(await npmAdminCredStatus('Local')).toBe('rejected');
  });

  it("returns 'rejected' on NPM's HTTP 400 'error.invalid-auth' (jc21 uses 400, not 401)", async () => {
    state.fetchStatus = 400;
    state.fetchBody = { error: { code: 400, message: 'Invalid email or password', message_i18n: 'error.invalid-auth' } };
    expect(await npmAdminCredStatus('Local')).toBe('rejected');
  });

  it("returns 'unknown' on a malformed-request 400 (not an auth rejection)", async () => {
    state.fetchStatus = 400;
    state.fetchBody = { error: { code: 400, message: 'secret must NOT have fewer than 1 characters' } };
    expect(await npmAdminCredStatus('Local')).toBe('unknown');
  });

  it("returns 'unknown' when NPM is unreachable (skip, don't re-key blindly)", async () => {
    state.fetchThrows = true;
    expect(await npmAdminCredStatus('Local')).toBe('unknown');
  });
});

describe('rekeyNpmAdmin — container-name injection guard', () => {
  it('rejects a metacharacter-laden container name instead of executing it', async () => {
    // First exec is the `podman ps` lookup; return a malicious name.
    sendCommand.mockResolvedValueOnce({ stdout: 'npm$(touch /pwn) jc21/proxy-manager', code: 0 });
    const res = await rekeyNpmAdmin('Local');
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not a valid podman name/i);
    // Only the lookup ran — the rewrite exec must never fire.
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('runs the rewrite with the container name and password shell-quoted for a normal name', async () => {
    sendCommand
      .mockResolvedValueOnce({ stdout: 'npm-app jc21/proxy-manager', code: 0 }) // lookup
      .mockResolvedValueOnce({ stdout: 'email=a@b.c;updated=1', code: 0 }); // rewrite
    state.fetchStatus = 200; // token check accepts the new password
    const res = await rekeyNpmAdmin('Local');
    expect(res.ok).toBe(true);
    const rewriteCmd = sendCommand.mock.calls[1][1].command as string;
    // Container name appears as a discrete, plainly-quoted token (safe chars
    // need no quotes via shellQuote) and the env value is present.
    expect(rewriteCmd).toContain('npm-app node -');
    expect(rewriteCmd).toContain('-e NEWPW=');
  });
});

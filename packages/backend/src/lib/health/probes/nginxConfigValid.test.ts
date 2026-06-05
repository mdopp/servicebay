import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Keep id→domain resolution inert by default; the parse/fail tests don't
// depend on it, and individual tests override the NPM API fetch as needed.
vi.mock('./npmAdmin', () => ({
  findNpmAdminUrl: vi.fn(async () => ({ kind: 'url', url: 'http://localhost:81' })),
  getNpmToken: vi.fn(async () => 'tok'),
}));

import { parseNginxTestOutput } from './nginxConfigValid';
import './nginxConfigValid';
import { getProbe } from './registry';
import type { CheckConfig } from '../types';

const EMERG =
  'nginx: [emerg] invalid port in upstream "127.0.0.1:/api/authz/auth-request" in /data/nginx/proxy_host/19.conf:60';

const OK_OUTPUT =
  'nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\n' +
  'nginx: configuration file /etc/nginx/nginx.conf test is successful';

const check = (): CheckConfig => ({
  id: 'nginx_config_valid',
  name: 'Nginx config validity',
  type: 'nginx_config_valid',
  target: 'Local',
  interval: 300,
  enabled: true,
  created_at: new Date().toISOString(),
  nodeName: 'Local',
});

describe('parseNginxTestOutput', () => {
  it('exit 0 → ok, no emerg, no host id', () => {
    expect(parseNginxTestOutput(OK_OUTPUT, 0)).toEqual({ ok: true });
  });

  it('exit != 0 with invalid-port emerg → not ok, surfaces emerg line + host id 19', () => {
    const r = parseNginxTestOutput(EMERG, 1);
    expect(r.ok).toBe(false);
    expect(r.emergLine).toBe(
      'nginx: [emerg] invalid port in upstream "127.0.0.1:/api/authz/auth-request" in /data/nginx/proxy_host/19.conf:60',
    );
    expect(r.hostId).toBe(19);
  });

  it('exit != 0 without a proxy_host file leaves hostId undefined', () => {
    const r = parseNginxTestOutput('nginx: [emerg] unexpected end of file', 2);
    expect(r.ok).toBe(false);
    expect(r.emergLine).toBe('nginx: [emerg] unexpected end of file');
    expect(r.hostId).toBeUndefined();
  });
});

describe('nginx_config_valid probe.run', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeCtx = (nginxResult: () => Promise<{ stdout: string; stderr: string }>) => ({
    executor: {
      // Container discovery uses exec (pipe/awk needs a shell).
      exec: vi.fn(async () => ({ stdout: 'nginx-nginx-proxy-manager docker.io/jc21/nginx-proxy-manager\n', stderr: '' })),
      // `nginx -t` runs via execArgv (no shell).
      execArgv: vi.fn(async () => nginxResult()),
    } as never,
  });

  it('green when nginx -t exits 0', async () => {
    const probe = getProbe('nginx_config_valid')!;
    const ctx = makeCtx(async () => ({ stdout: '', stderr: OK_OUTPUT }));
    const res = (await probe.run(check(), ctx)) as { status: string; payload: { status: string; detail: string } };
    expect(res.status).toBe('ok');
    expect(res.payload.status).toBe('ok');
  });

  it('red with the emerg line + host id surfaced when nginx -t exits != 0', async () => {
    // The executor throws a CommandError-shaped error carrying code + stderr.
    const probe = getProbe('nginx_config_valid')!;
    const ctx = makeCtx(async () => {
      throw Object.assign(new Error('Command failed'), { code: 1, stdout: '', stderr: EMERG });
    });
    // No real NPM behind the id→domain lookup → resolveHostDomain returns undefined.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false } as Response)));

    const res = (await probe.run(check(), ctx)) as { status: string; payload: { status: string; detail: string; hostId?: number } };
    expect(res.status).toBe('fail');
    expect(res.payload.status).toBe('fail');
    expect(res.payload.hostId).toBe(19);
    expect(res.payload.detail).toContain('proxy_host/19.conf');
    expect(res.payload.detail).toContain('[emerg] invalid port');
  });

  it('maps host id → domain when the NPM API resolves it', async () => {
    const probe = getProbe('nginx_config_valid')!;
    const ctx = makeCtx(async () => {
      throw Object.assign(new Error('Command failed'), { code: 1, stdout: '', stderr: EMERG });
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => [{ id: 19, domain_names: ['ollama.dopp.cloud'] }],
      } as unknown as Response)),
    );

    const res = (await probe.run(check(), ctx)) as { status: string; payload: { domain?: string; detail: string } };
    expect(res.payload.domain).toBe('ollama.dopp.cloud');
    expect(res.payload.detail).toContain('ollama.dopp.cloud');
  });

  it('info (not fail) when no NPM container is running', async () => {
    const probe = getProbe('nginx_config_valid')!;
    const ctx = {
      executor: {
        exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
      } as never,
    };
    const res = (await probe.run(check(), ctx)) as { status: string; payload: { status: string } };
    expect(res.status).toBe('ok');
    expect(res.payload.status).toBe('info');
  });
});

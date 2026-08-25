/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `GET /api/system/credentials` must not ship the secrets (#2605).
 *
 * The route used to return `config.installManifest` verbatim. Encryption at
 * rest is not a wire property — `getConfig()` decrypts — so every stored
 * password went to the browser on a route whose UI stopped rendering them in
 * #2560. Not shown is not the same as not sent.
 *
 * What these tests pin down:
 *
 *   1. no plaintext password reaches the response, on any key, at any depth,
 *   2. the entries still carry everything Settings renders,
 *   3. `secured` still separates "handed over" from "ServiceBay is the only
 *      copy" — drop that and the hand-over gate silently stops asking,
 *   4. the hand-over, the one path that *is* meant to hand out the plaintext,
 *      still does.
 *
 * Fixture passwords are obvious placeholders, never a real credential.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const state: { config: any } = { config: {} };

vi.mock('@/lib/config', async () => {
  const actual = await vi.importActual<any>('@/lib/config');
  return {
    ...actual,
    getConfig: vi.fn(async () => state.config),
    saveConfig: vi.fn(async (cfg: any) => { state.config = cfg; }),
  };
});

vi.mock('@/lib/api/requireSession', () => ({
  requireSession: vi.fn(async () => ({ user: 'test', expires: new Date(Date.now() + 60_000) })),
}));

import { GET } from '@/app/api/system/credentials/route';
import { POST as HANDOVER } from '@/app/api/system/credentials/handover/route';
import { summarizeCredentialSecurity } from '@/lib/stackInstall/credentialsManifest';
import { resetHandoverTickets } from '@/lib/stackInstall/credentialsHandover';

/** Obvious placeholders — a grep for either must only ever hit this file. */
const PENDING_SECRET = 'PLACEHOLDER-not-a-real-password';
const OTHER_SECRET = 'PLACEHOLDER-also-not-real';

const cred = (service: string, password: string) => ({
  service,
  url: `http://localhost:8080/${service}`,
  username: `${service}-admin`,
  password,
  importance: 'critical' as const,
  notes: 'first login',
  template: service,
});

const get = async () => {
  const res = await GET(new NextRequest('http://test/api/system/credentials'));
  return { status: res.status, text: await res.clone().text(), body: await res.json() };
};

beforeEach(() => {
  state.config = {
    installManifest: {
      savedAt: '2026-08-24T00:00:00.000Z',
      credentials: [
        cred('auth', PENDING_SECRET),
        cred('immich', OTHER_SECRET),
        // Already handed over: ServiceBay dropped its copy at hand-off.
        { ...cred('lldap', ''), notes: 'handed over earlier' },
      ],
    },
    reverseProxy: { publicDomain: 'example.test', hosts: [{ domain: 'auth.example.test', service: 'auth' }] },
  };
  resetHandoverTickets();
});

describe('GET /api/system/credentials — the secrets stay on the box', () => {
  it('serialises no stored password anywhere in the response', async () => {
    const { status, text } = await get();
    expect(status).toBe(200);
    expect(text).not.toContain(PENDING_SECRET);
    expect(text).not.toContain(OTHER_SECRET);
  });

  it('omits the password key entirely rather than masking it', async () => {
    const { body } = await get();
    for (const entry of body.manifest.credentials) {
      // A blanked-or-masked field is still a field: the UI could write the
      // mask back as the literal new password. Absent is the requirement.
      expect(Object.keys(entry)).not.toContain('password');
    }
  });

  it('keeps every field Settings renders', async () => {
    const { body } = await get();
    expect(body.manifest.savedAt).toBe('2026-08-24T00:00:00.000Z');
    expect(body.manifest.credentials[0]).toEqual({
      service: 'auth',
      url: 'http://localhost:8080/auth',
      username: 'auth-admin',
      importance: 'critical',
      notes: 'first login',
      template: 'auth',
      secured: false,
    });
    expect(body.proxyHosts).toEqual([{ domain: 'auth.example.test', service: 'auth' }]);
    expect(body.publicDomain).toBe('example.test');
  });

  it('still tells the hand-over gate which entries are pending', async () => {
    const { body } = await get();
    // The gate and the Settings badge both read this summary. Dropping the
    // password without carrying `secured` would report everything handed
    // over and the gate would stop asking.
    expect(summarizeCredentialSecurity(body.manifest.credentials))
      .toEqual({ total: 3, secured: 1, unsecured: 2 });
    expect(body.manifest.credentials.map((c: any) => c.secured)).toEqual([false, false, true]);
  });

  it('passes an empty manifest through unchanged', async () => {
    state.config = { installManifest: undefined };
    const { body } = await get();
    expect(body).toEqual({ manifest: null, proxyHosts: [], publicDomain: null });
  });

  it('does not mutate what the box stores', async () => {
    await get();
    expect(state.config.installManifest.credentials[0].password).toBe(PENDING_SECRET);
  });
});

describe('the hand-over is still the way passwords leave the box', () => {
  it('offers the plaintext of exactly the pending entries', async () => {
    const res = await HANDOVER(
      new NextRequest('http://test/api/system/credentials/handover', { method: 'POST' }),
    );
    const offer = await res.json();
    expect(offer.pending).toBe(2);
    expect(offer.csv).toContain(PENDING_SECRET);
    expect(offer.csv).toContain(OTHER_SECRET);
  });
});

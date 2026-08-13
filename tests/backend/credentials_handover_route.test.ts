/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `/api/system/credentials/handover` + `/confirm` (#2560).
 *
 * The route pair that ends ServiceBay's role as a second password manager:
 * it hands the list to the operator and deletes its own copy — but only
 * against evidence the file arrived. The invariants worth a test are
 * exactly the three the issue names:
 *
 *   1. a proven delivery drops the passwords,
 *   2. a failed / aborted / corrupted one drops **nothing**,
 *   3. what it drops is only what it actually delivered.
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

import { POST as ISSUE } from '@/app/api/system/credentials/handover/route';
import { POST as CONFIRM } from '@/app/api/system/credentials/handover/confirm/route';
import { credentialReceipt } from '@/lib/stackInstall/credentialsManifest';
import { resetHandoverTickets } from '@/lib/stackInstall/credentialsHandover';

const cred = (service: string, extra: Record<string, unknown> = {}) => ({
  service,
  url: `https://${service}.example`,
  username: 'admin',
  password: 'plaintext-secret',
  importance: 'critical',
  template: service,
  ...extra,
});

const manifestOf = (...creds: any[]) => ({ savedAt: '2026-08-13T00:00:00.000Z', credentials: creds });

const issue = async () => {
  const res = await ISSUE(new NextRequest('http://test/api/system/credentials/handover', { method: 'POST' }));
  return res.json();
};

const confirm = async (body: unknown) => {
  const res = await CONFIRM(new NextRequest('http://test/api/system/credentials/handover/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
};

/** What ServiceBay still holds, by service name. */
const stillHeld = () =>
  (state.config.installManifest?.credentials ?? [])
    .filter((c: any) => c.password)
    .map((c: any) => c.service);

beforeEach(() => {
  state.config = {};
  resetHandoverTickets();
});

describe('POST /api/system/credentials/handover — the offer', () => {
  it('says nothing is pending when ServiceBay holds no passwords', async () => {
    state.config = { installManifest: manifestOf(cred('auth', { password: '' })) };
    expect(await issue()).toEqual({ pending: 0 });
  });

  it('hands out the whole file plus a token', async () => {
    state.config = { installManifest: manifestOf(cred('auth'), cred('immich')) };
    const offer = await issue();
    expect(offer.pending).toBe(2);
    expect(offer.token).toMatch(/^[0-9a-f]{48}$/);
    expect(offer.csv).toContain('plaintext-secret');
    expect(offer.filename).toMatch(/^servicebay-credentials-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('offering deletes nothing on its own — the download has not happened yet', async () => {
    state.config = { installManifest: manifestOf(cred('auth')) };
    await issue();
    expect(stillHeld()).toEqual(['auth']);
  });
});

describe('POST /api/system/credentials/handover/confirm — proven delivery', () => {
  it('drops every delivered password when the receipt matches', async () => {
    state.config = { installManifest: manifestOf(cred('auth'), cred('immich')) };
    const offer = await issue();

    const { body } = await confirm({ token: offer.token, receipt: credentialReceipt(offer.csv) });
    expect(body).toEqual({ ok: true, dropped: 2 });
    expect(stillHeld()).toEqual([]);
    // The pointer survives — Settings still says *what* exists.
    const saved = state.config.installManifest.credentials;
    expect(saved.map((c: any) => c.service)).toEqual(['auth', 'immich']);
    expect(saved[0].username).toBe('admin');
  });

  it('is single-use — a replayed token proves nothing about a second file', async () => {
    state.config = { installManifest: manifestOf(cred('auth')) };
    const offer = await issue();
    await confirm({ token: offer.token, receipt: credentialReceipt(offer.csv) });

    const again = await confirm({ token: offer.token, receipt: credentialReceipt(offer.csv) });
    expect(again.body).toEqual({ ok: false, reason: 'unknown_token' });
  });
});

describe('POST /api/system/credentials/handover/confirm — a failed download deletes NOTHING', () => {
  it('keeps every password when the file came back truncated', async () => {
    state.config = { installManifest: manifestOf(cred('auth'), cred('immich')) };
    const offer = await issue();

    const { body } = await confirm({
      token: offer.token,
      receipt: credentialReceipt(offer.csv.slice(0, -25)),
    });
    expect(body).toEqual({ ok: false, reason: 'receipt_mismatch' });
    expect(stillHeld()).toEqual(['auth', 'immich']);
  });

  it('keeps every password when the token was never issued', async () => {
    state.config = { installManifest: manifestOf(cred('auth')) };
    const offer = await issue();

    const { body } = await confirm({ token: 'a'.repeat(48), receipt: credentialReceipt(offer.csv) });
    expect(body).toEqual({ ok: false, reason: 'unknown_token' });
    expect(stillHeld()).toEqual(['auth']);
  });

  it('keeps every password when the browser never confirmed at all', async () => {
    // The blocked-download case: the offer was made, the save failed, the
    // client returned without calling confirm. Nothing may change.
    state.config = { installManifest: manifestOf(cred('auth'), cred('immich')) };
    await issue();
    expect(stillHeld()).toEqual(['auth', 'immich']);
  });

  it('rejects a malformed receipt without touching anything', async () => {
    state.config = { installManifest: manifestOf(cred('auth')) };
    const offer = await issue();

    const { status } = await confirm({ token: offer.token, receipt: 'not-a-receipt' });
    expect(status).toBe(400);
    expect(stillHeld()).toEqual(['auth']);
  });
});

describe('a hand-over drops only what it delivered', () => {
  it('leaves an entry an install added after the file was built', async () => {
    state.config = { installManifest: manifestOf(cred('auth')) };
    const offer = await issue();
    // An install finishes while the operator is still saving the file.
    state.config = { installManifest: manifestOf(cred('auth'), cred('immich')) };

    const { body } = await confirm({ token: offer.token, receipt: credentialReceipt(offer.csv) });
    expect(body).toEqual({ ok: true, dropped: 1 });
    expect(stillHeld()).toEqual(['immich']);
  });
});

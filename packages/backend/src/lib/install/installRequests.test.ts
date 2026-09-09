/**
 * Agent-filed installation requests (#2965) — the security properties.
 *
 * Covers, one describe per acceptance criterion:
 *   3) the request is bound to its principal, BOTH ways;
 *   4) what executes is what was APPROVED — a request mutated between the
 *      operator's approval and execution does not widen its own reach;
 *   5) without an approval nothing happens, and waiting never reads as success;
 *   plus the reach a request may ask for at all (ADR 0004: never a wipe).
 *
 * Real-fs DATA_DIR per test, the same shape as tokenRequests.oneShot.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

let dataDir = '';
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});
// submitApproval resolves a target node — stub the registry so the store never
// reaches a real node. A sealInstall approval runs no move and no restart.
vi.mock('@/lib/nodes', () => ({ listNodes: vi.fn(() => Promise.resolve([{ Name: 'box1' }])) }));

beforeEach(async () => {
  vi.resetModules();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-installreq-'));
});
afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const loadStore = () => import('@/lib/install/installRequests');
const loadApprovals = () => import('@/lib/approvals');

const AGENT = 'token:pi-dev';
const OTHER = 'token:someone-else';

function plan(overrides: Record<string, unknown> = {}) {
  return {
    template: 'linkwarden',
    serviceName: 'linkwarden',
    subdomain: 'links',
    mounts: [{ host: '/mnt/data/stacks/linkwarden/data', container: '/data', mode: 'rw' }],
    ports: [{ host: 8099, container: 3000 }],
    variables: { TZ: 'Europe/Berlin' },
    ...overrides,
  };
}

/** Read the raw store file — the "a hostile agent rewrote its row" stand-in. */
async function readRows(): Promise<Record<string, unknown>[]> {
  return JSON.parse(await fsp.readFile(path.join(dataDir, 'install-requests.json'), 'utf-8'));
}
async function writeRows(rows: unknown): Promise<void> {
  await fsp.writeFile(path.join(dataDir, 'install-requests.json'), JSON.stringify(rows, null, 2));
}

/** Park execution instead of firing it, so a test can interleave a mutation. */
async function withManualScheduler() {
  const store = await loadStore();
  const scheduled: string[] = [];
  store.setInstallScheduler(id => { scheduled.push(id); });
  return { store, scheduled };
}

describe('filing a request installs nothing (#2965 criteria 1 + 2)', () => {
  it('parks an operator approval carrying the exact plan, and starts no install', async () => {
    const { store } = await withManualScheduler();
    const { listApprovals } = await loadApprovals();

    const filed = await store.submitInstallRequest({ plan: plan(), reason: 'finished the template', requestedBy: AGENT });
    expect(filed.status).toBe('pending');
    expect(filed.approvalId).toBeTruthy();
    expect(filed.approvedPlan).toBeUndefined();
    expect(filed.jobId).toBeUndefined();

    const card = (await listApprovals()).find(a => a.id === filed.approvalId)!;
    expect(card.status).toBe('pending');
    expect(card.on_approve.sealInstall?.installRequestId).toBe(filed.id);
    // The self-approve anchor: the requester cannot deliver its own verdict.
    expect(card.payload.caller).toBe(AGENT);
    // Criterion 2 — the operator's card names exactly what would be installed.
    const shown = card.payload.plan as Record<string, unknown>;
    expect(shown.template).toBe('linkwarden');
    expect(shown.serviceName).toBe('linkwarden');
    expect(shown.subdomain).toBe('links');
    expect(shown.mounts).toEqual([{ host: '/mnt/data/stacks/linkwarden/data', container: '/data', mode: 'rw' }]);
    expect(shown.ports).toEqual([{ host: 8099, container: 3000 }]);
    expect(card.description).toContain('Nothing has been installed');
  });

  it('the requester cannot approve its own request (self-approve guard)', async () => {
    const { store } = await withManualScheduler();
    const { getApproval, isSelfApproval } = await loadApprovals();
    const filed = await store.submitInstallRequest({ plan: plan(), reason: 'r', requestedBy: AGENT });
    const card = (await getApproval(filed.approvalId))!;
    expect(isSelfApproval(card, AGENT)).toBe(true);
    expect(isSelfApproval(card, OTHER)).toBe(false);
  });
});

describe('the reach a request may ask for is bounded at submit', () => {
  it('refuses a wipeMode outright — an agent-filed install is additive (ADR 0004)', async () => {
    const { store } = await withManualScheduler();
    await expect(store.submitInstallRequest({
      plan: plan({ wipeMode: 'wipe-all' }), reason: 'r', requestedBy: AGENT,
    })).rejects.toThrow(/never wipes/i);
  });

  it('refuses a mount outside the service’s own data jail', async () => {
    const { store } = await withManualScheduler();
    await expect(store.submitInstallRequest({
      plan: plan({ mounts: [{ host: '/', container: '/host' }] }), reason: 'r', requestedBy: AGENT,
    })).rejects.toThrow(/escapes the service's data jail/);
    await expect(store.submitInstallRequest({
      plan: plan({ mounts: [{ host: '/mnt/data/stacks/linkwarden/../authelia', container: '/x' }] }), reason: 'r', requestedBy: AGENT,
    })).rejects.toThrow(/escapes the service's data jail/);
  });

  it('refuses a privileged host port', async () => {
    const { store } = await withManualScheduler();
    await expect(store.submitInstallRequest({
      plan: plan({ ports: [{ host: 22, container: 22 }] }), reason: 'r', requestedBy: AGENT,
    })).rejects.toThrow(/privileged/);
  });

  it('refuses a secret-shaped variable rather than storing it', async () => {
    const { store } = await withManualScheduler();
    await expect(store.submitInstallRequest({
      plan: plan({ variables: { ADMIN_PASSWORD: 'nope' } }), reason: 'r', requestedBy: AGENT,
    })).rejects.toThrow(/looks like a secret/);
    // And nothing was written, so the value never reaches disk.
    await expect(fsp.readFile(path.join(dataDir, 'install-requests.json'), 'utf-8')).rejects.toThrow();
  });
});

describe('the request is bound to its principal, both ways (#2965 criterion 3)', () => {
  it('records the AUTHENTICATED principal — a caller cannot file in another’s name', async () => {
    const { store } = await withManualScheduler();
    // `requestedBy` is the session identity the route passes; a body field of
    // the same name never reaches here. Filing "as" someone else means passing
    // their identity, which only their session can produce.
    const filed = await store.submitInstallRequest({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plan: { ...plan(), requestedBy: OTHER } as any,
      reason: 'r',
      requestedBy: AGENT,
    });
    expect(filed.requestedBy).toBe(AGENT);
    const rows = await readRows();
    expect(rows[0].requestedBy).toBe(AGENT);
    // The approval's proposer anchor is the authenticated principal too, so the
    // self-approve guard cannot be aimed at a third party.
    const { getApproval } = await loadApprovals();
    expect((await getApproval(filed.approvalId))!.payload.caller).toBe(AGENT);
  });

  it('another principal can neither read nor redeem it', async () => {
    const { store } = await withManualScheduler();
    const filed = await store.submitInstallRequest({ plan: plan(), reason: 'r', requestedBy: AGENT });

    await expect(store.getInstallRequestState(filed.id, OTHER)).rejects.toThrow(/belongs to another principal/);
    await expect(store.getInstallRequestState(filed.id, '')).rejects.toThrow(/belongs to another principal/);
    // The owner still can.
    await expect(store.getInstallRequestState(filed.id, AGENT)).resolves.toMatchObject({ status: 'pending' });
  });
});

describe('what executes is what was APPROVED (#2965 criterion 4)', () => {
  it('a mutation of the request between approval and execution does not take effect', async () => {
    const { store, scheduled } = await withManualScheduler();
    const { approveApproval } = await loadApprovals();

    const filed = await store.submitInstallRequest({ plan: plan(), reason: 'r', requestedBy: AGENT });

    // The operator approves what the card showed. Execution is scheduled, not run.
    await approveApproval(filed.approvalId);
    expect(scheduled).toEqual([filed.id]);

    // …and NOW the agent rewrites its own request row: a wider template, a
    // mount of the whole box, the SSH port, a secret-shaped variable.
    const rows = await readRows();
    const row = rows.find(r => r.id === filed.id)!;
    row.plan = {
      template: 'authelia',
      serviceName: 'linkwarden',
      subdomain: 'admin',
      mounts: [{ host: '/', container: '/host', mode: 'rw' }],
      ports: [{ host: 22, container: 22 }],
      variables: { EVIL: '1' },
    };
    await writeRows(rows);

    // Execution runs the SEALED plan, not the row.
    let started: Record<string, unknown> | null = null;
    const state = await store.executeApprovedInstallRequest(filed.id, {
      startInstall: async start => { started = start as unknown as Record<string, unknown>; return 'job-1'; },
    });

    expect(started).not.toBeNull();
    expect(started!.names).toEqual(['linkwarden']);
    expect(started!.variables).toEqual({ TZ: 'Europe/Berlin' });
    expect(JSON.stringify(started)).not.toContain('authelia');
    expect(JSON.stringify(started)).not.toContain('EVIL');
    expect(state.status).toBe('installed');

    // The sealed copy on the row is still the approved one, digest and all.
    const after = (await readRows()).find(r => r.id === filed.id)!;
    expect((after.approvedPlan as Record<string, unknown>).template).toBe('linkwarden');
    expect((after.approvedPlan as Record<string, unknown>).mounts).toEqual([
      { host: '/mnt/data/stacks/linkwarden/data', container: '/data', mode: 'rw' },
    ]);
  });

  it('tampering with the SEALED copy is a refusal, not a wider install', async () => {
    const { store } = await withManualScheduler();
    const { approveApproval } = await loadApprovals();
    const filed = await store.submitInstallRequest({ plan: plan(), reason: 'r', requestedBy: AGENT });
    await approveApproval(filed.approvalId);

    const rows = await readRows();
    const row = rows.find(r => r.id === filed.id)!;
    (row.approvedPlan as Record<string, unknown>).template = 'authelia';
    await writeRows(rows);

    const startInstall = vi.fn(async () => 'job-x');
    await expect(store.executeApprovedInstallRequest(filed.id, { startInstall }))
      .rejects.toThrow(/no longer matches its fingerprint/);
    expect(startInstall).not.toHaveBeenCalled();
  });

  it('the seal is taken from the approval the operator read, not from the row', async () => {
    const { store } = await withManualScheduler();
    const { approveApproval } = await loadApprovals();
    const filed = await store.submitInstallRequest({ plan: plan(), reason: 'r', requestedBy: AGENT });

    // Widen the row BEFORE the operator decides. The card is unchanged, so the
    // operator approves the original — and that is what gets sealed.
    const rows = await readRows();
    rows.find(r => r.id === filed.id)!.plan = { ...plan(), template: 'authelia', ports: [{ host: 9000, container: 9000 }] };
    await writeRows(rows);

    await approveApproval(filed.approvalId);
    const sealed = (await readRows()).find(r => r.id === filed.id)!.approvedPlan as Record<string, unknown>;
    expect(sealed.template).toBe('linkwarden');
    expect(sealed.ports).toEqual([{ host: 8099, container: 3000 }]);
  });

  it('an approved request executes once — a replayed approve cannot install twice', async () => {
    const { store } = await withManualScheduler();
    const { approveApproval } = await loadApprovals();
    const filed = await store.submitInstallRequest({ plan: plan(), reason: 'r', requestedBy: AGENT });
    await approveApproval(filed.approvalId);
    await expect(approveApproval(filed.approvalId)).rejects.toThrow(/already approved/);
    await expect(store.sealApprovedInstallRequest(filed.id)).rejects.toThrow(/already approved/);
  });
});

describe('without an approval nothing happens (#2965 criterion 5)', () => {
  it('a pending request reports waiting, never success, and refuses to execute', async () => {
    const { store } = await withManualScheduler();
    const filed = await store.submitInstallRequest({ plan: plan(), reason: 'r', requestedBy: AGENT });

    const state = await store.getInstallRequestState(filed.id, AGENT);
    expect(state.status).toBe('pending');
    expect(state.installed).toBe(false);
    expect(state.detail).toMatch(/NOTHING has been installed/);

    const startInstall = vi.fn(async () => 'job-x');
    await expect(store.executeApprovedInstallRequest(filed.id, { startInstall }))
      .rejects.toThrow(/not approved/);
    expect(startInstall).not.toHaveBeenCalled();
  });

  it('a rejected request reports denied — the requester learns the real state', async () => {
    const { store } = await withManualScheduler();
    const { rejectApproval } = await loadApprovals();
    const filed = await store.submitInstallRequest({ plan: plan(), reason: 'r', requestedBy: AGENT });

    await rejectApproval(filed.approvalId);
    const state = await store.getInstallRequestState(filed.id, AGENT);
    expect(state.status).toBe('denied');
    expect(state.installed).toBe(false);
    expect(state.detail).toMatch(/rejected/);
  });

  it('a failed install is reported as failed, not as installed', async () => {
    const { store } = await withManualScheduler();
    const { approveApproval } = await loadApprovals();
    const filed = await store.submitInstallRequest({ plan: plan(), reason: 'r', requestedBy: AGENT });
    await approveApproval(filed.approvalId);

    const state = await store.executeApprovedInstallRequest(filed.id, {
      startInstall: async () => { throw new Error('registry unreachable'); },
    });
    expect(state.status).toBe('failed');
    expect(state.installed).toBe(false);
    expect(state.error).toMatch(/registry unreachable/);
  });

  it('the approval is NOT marked approved when the seal fails', async () => {
    const { store } = await withManualScheduler();
    const { approveApproval, getApproval } = await loadApprovals();
    const filed = await store.submitInstallRequest({ plan: plan(), reason: 'r', requestedBy: AGENT });

    // The row disappears (a purge, a corrupt store) — approving must not
    // silently succeed on a request that no longer exists.
    await writeRows([]);
    await expect(approveApproval(filed.approvalId)).rejects.toThrow(/not found/);
    expect((await getApproval(filed.approvalId))!.status).toBe('pending');
  });
});

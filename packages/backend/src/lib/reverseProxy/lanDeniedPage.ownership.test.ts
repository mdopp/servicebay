/**
 * #3044 — the explainer pages that took the reverse proxy down.
 *
 * On 2026-09-26, NPM would not start:
 *
 *     chown: changing ownership of
 *       '/data/nginx/servicebay/forward-auth-denied-pi.dopp.cloud.html':
 *       Operation not permitted
 *     s6-rc: warning: unable to start service prepare: command exited 1
 *
 * NPM chowns its whole data volume on startup. Six pages ServiceBay had
 * written there with `sudo tee` were owned by HOST ROOT — outside NPM's user
 * namespace, so its chown failed, `prepare` exited 1, and **24 of 24 domains
 * went unreachable**. The pages' content was perfectly correct.
 *
 * The repair already existed for the install transport (#1298/#2717) and lived
 * private to it, so the second sudo writer never got it. What is pinned here
 * is that this writer now performs it — and that a failure to realign does not
 * turn a written page into a reported failure, because the page IS written and
 * only a later restart trips over it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn(), listNodes: vi.fn(), getConfig: vi.fn() }));

vi.mock('@/lib/agent/manager', () => ({ agentManager: { getAgent: () => ({ sendCommand: mocks.sendCommand }) } }));
vi.mock('@/lib/nodes', () => ({ listNodes: mocks.listNodes }));
vi.mock('@/lib/config', () => ({ getConfig: mocks.getConfig }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { deployForwardAuthDeniedPage, deployLanDeniedPage } from './lanDeniedPage';

/** The agent, answering the probe with a non-root ancestor. */
function agentWith(opts: { ownerRef?: string; writeError?: string; chownCode?: number } = {}) {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  mocks.sendCommand.mockImplementation(async (action: string, params: Record<string, unknown> = {}) => {
    calls.push({ action, params });
    const cmd = String(params.command ?? '');
    if (action === 'exec' && cmd.includes('sb-owner-ref:')) {
      return { code: 0, stdout: `sb-owner-ref:${opts.ownerRef ?? '/mnt/data/stacks/nginx-proxy-manager/data'}\n`, stderr: '' };
    }
    if (action === 'exec' && cmd.startsWith('sudo chown')) {
      return { code: opts.chownCode ?? 0, stdout: '', stderr: opts.chownCode ? 'Operation not permitted' : '' };
    }
    if (action === 'write_file') return opts.writeError ? { error: opts.writeError } : 'ok';
    return { code: 0, stdout: '', stderr: '' };
  });
  return calls;
}

describe('the explainer pages leave their file owned by whoever must read it (#3044)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listNodes.mockResolvedValue([{ Name: 'Local' }]);
    mocks.getConfig.mockResolvedValue({ reverseProxy: { publicDomain: 'dopp.cloud' } });
  });

  it('realigns ownership after writing a forward-auth page', async () => {
    const calls = agentWith();
    await expect(deployForwardAuthDeniedPage('pi.dopp.cloud', 'dopp.cloud')).resolves.toBe(true);

    const chown = calls.find(c => String(c.params.command ?? '').startsWith('sudo chown'));
    expect(chown, 'a sudo write must be followed by an ownership realignment').toBeDefined();
    // Derived, never assumed: `core:core` would be wrong for a pod running as
    // some other mapped uid, and the reference is what knows which.
    expect(String(chown!.params.command)).toContain('--reference=');
    expect(String(chown!.params.command)).toContain('forward-auth-denied-pi.dopp.cloud.html');
    expect(String(chown!.params.command)).not.toContain('core:core');
  });

  it('probes for the owner BEFORE writing — the write itself can create a root-owned dir', async () => {
    const calls = agentWith();
    await deployForwardAuthDeniedPage('pi.dopp.cloud', 'dopp.cloud');
    const probeAt = calls.findIndex(c => String(c.params.command ?? '').includes('sb-owner-ref:'));
    const writeAt = calls.findIndex(c => c.action === 'write_file');
    expect(probeAt).toBeGreaterThanOrEqual(0);
    expect(probeAt).toBeLessThan(writeAt);
  });

  it('does the same for the LAN-only page', async () => {
    const calls = agentWith();
    await expect(deployLanDeniedPage()).resolves.toBe(true);
    expect(calls.some(c => String(c.params.command ?? '').startsWith('sudo chown'))).toBe(true);
  });

  it('a failed realignment does not turn a written page into a reported failure', async () => {
    // The page IS written and serves fine; only a later restart of the
    // consuming pod trips over the ownership. Reporting failure here would
    // fail an install over a page that exists.
    agentWith({ chownCode: 1 });
    await expect(deployForwardAuthDeniedPage('pi.dopp.cloud', 'dopp.cloud')).resolves.toBe(true);
  });

  it('a failed WRITE is still a failure, and is not followed by a chown', async () => {
    const calls = agentWith({ writeError: 'sudo write_file failed: read-only file system' });
    await expect(deployForwardAuthDeniedPage('pi.dopp.cloud', 'dopp.cloud')).resolves.toBe(false);
    expect(calls.some(c => String(c.params.command ?? '').startsWith('sudo chown'))).toBe(false);
  });

  it('a probe that answers nothing usable still writes, and still tries the file itself', async () => {
    // Pre-#2717 behaviour: no reference, so repair only the file. Declining to
    // write because we could not probe would be worse than the ownership bug.
    const calls = agentWith({ ownerRef: '/' });
    await expect(deployForwardAuthDeniedPage('pi.dopp.cloud', 'dopp.cloud')).resolves.toBe(true);
    expect(calls.some(c => c.action === 'write_file')).toBe(true);
  });
});

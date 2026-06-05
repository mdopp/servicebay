/**
 * #1724 — preserveAutheliaOidcClients: before the auth stack overwrites
 * Authelia's `configuration.yml`, merge any OIDC clients already on disk that
 * the fresh render doesn't own back into the file-to-be-written.
 *
 * This unit-tests the install-path wrapper (read existing config via the agent
 * → merge → mutate the extraFiles entry in place, fail-soft). The pure merge
 * itself is covered separately in autheliaClientMerge.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// log() → appendLog/emitJobLog: no-op stubs so the test doesn't touch the
// real job store or socket bridge.
vi.mock('@/lib/install/jobStore', () => ({
  appendLog: vi.fn().mockResolvedValue(undefined),
  updateJob: vi.fn().mockResolvedValue(null),
  getJob: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/install/socketBridge', () => ({
  emitJobLog: vi.fn(),
  emitJobUpdate: vi.fn(),
}));

const sendCommandMock = vi.fn();
const ensureAgentMock = vi.fn();
vi.mock('@/lib/agent/manager', () => ({
  agentManager: {
    ensureAgent: (node: string) => ensureAgentMock(node),
  },
}));

import { preserveAutheliaOidcClients } from './runner';

const RENDERED = [
  'identity_providers:',
  '  oidc:',
  '    clients:',
  '      - client_id: servicebay',
  '        client_secret: rendered-secret',
  '',
].join('\n');

const EXISTING_WITH_IMMICH = [
  'identity_providers:',
  '  oidc:',
  '    clients:',
  '      - client_id: servicebay',
  '        client_secret: old-secret',
  '      - client_id: immich',
  '        client_secret: immich-secret',
  '',
].join('\n');

beforeEach(() => {
  sendCommandMock.mockReset();
  ensureAgentMock.mockReset();
  ensureAgentMock.mockResolvedValue({ sendCommand: sendCommandMock });
});

describe('preserveAutheliaOidcClients (#1724)', () => {
  it('returns without touching the agent when there is no configuration.yml', async () => {
    const extraFiles = [{ path: '/mnt/data/stacks/auth/secrets.env', content: 'X=1' }];
    await preserveAutheliaOidcClients('job-1', 'Local', extraFiles);
    expect(ensureAgentMock).not.toHaveBeenCalled();
    expect(extraFiles[0].content).toBe('X=1');
  });

  it('leaves the fresh render untouched on a fresh install (no on-disk config)', async () => {
    sendCommandMock.mockResolvedValue({ content: '' });
    const extraFiles = [{ path: '/mnt/data/stacks/auth/configuration.yml', content: RENDERED }];
    await preserveAutheliaOidcClients('job-1', 'Local', extraFiles);
    expect(extraFiles[0].content).toBe(RENDERED);
  });

  it('merges back an existing OIDC client the fresh render does not own', async () => {
    sendCommandMock.mockResolvedValue({ content: EXISTING_WITH_IMMICH });
    const extraFiles = [{ path: '/mnt/data/stacks/auth/configuration.yml', content: RENDERED }];
    await preserveAutheliaOidcClients('job-1', 'Local', extraFiles);
    // immich (registered out-of-band) is preserved with its secret intact...
    expect(extraFiles[0].content).toContain('immich');
    expect(extraFiles[0].content).toContain('immich-secret');
    // ...while the rendered servicebay block (and its secret) still wins.
    expect(extraFiles[0].content).toContain('rendered-secret');
    expect(extraFiles[0].content).not.toContain('old-secret');
  });

  it('defaults the node to Local when none is provided', async () => {
    sendCommandMock.mockResolvedValue({ content: '' });
    const extraFiles = [{ path: '/mnt/data/stacks/auth/configuration.yml', content: RENDERED }];
    await preserveAutheliaOidcClients('job-1', undefined, extraFiles);
    expect(ensureAgentMock).toHaveBeenCalledWith('Local');
  });

  it('is fail-soft: an agent error leaves the fresh render unchanged (never throws)', async () => {
    ensureAgentMock.mockRejectedValue(new Error('agent offline'));
    const extraFiles = [{ path: '/mnt/data/stacks/auth/configuration.yml', content: RENDERED }];
    await expect(
      preserveAutheliaOidcClients('job-1', 'Local', extraFiles),
    ).resolves.toBeUndefined();
    expect(extraFiles[0].content).toBe(RENDERED);
  });

  it('tolerates a read_file rejection (uses empty existing, no merge)', async () => {
    sendCommandMock.mockRejectedValue(new Error('EACCES'));
    const extraFiles = [{ path: '/mnt/data/stacks/auth/configuration.yml', content: RENDERED }];
    await preserveAutheliaOidcClients('job-1', 'Local', extraFiles);
    expect(extraFiles[0].content).toBe(RENDERED);
  });
});

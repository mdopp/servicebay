/**
 * Hermes API-key reconcile (#1761) — adopt the running engine's
 * `API_SERVER_KEY` into `installedSecrets.HERMES_API_KEY` without
 * regenerating it. Tests the read-then-store contract, idempotency, the
 * not-found path, and that the key is never returned in the result.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: vi.fn() },
}));
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(),
}));
vi.mock('@/lib/install/savedSecrets', () => ({
  loadSavedSecrets: vi.fn(),
  persistSingleSecret: vi.fn(),
}));

import { reconcileHermesApiKey } from './reconcileHermesApiKey';
import { agentManager } from '@/lib/agent/manager';
import { getConfig } from '@/lib/config';
import { loadSavedSecrets, persistSingleSecret } from '@/lib/install/savedSecrets';

const ENGINE_KEY = 'engine-real-key-abc123';

/** Build an agent whose exec returns `stdout` for the first container that
 *  matches `respondFor` (default: the first container queried). */
function agentReturning(stdout: string): { sendCommand: ReturnType<typeof vi.fn> } {
  const sendCommand = vi.fn(async () => ({ code: 0, stdout }));
  return { sendCommand };
}

describe('reconcileHermesApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConfig).mockResolvedValue({} as never);
    vi.mocked(loadSavedSecrets).mockReturnValue({});
    vi.mocked(persistSingleSecret).mockResolvedValue(true);
  });

  it('reads the running engine key and persists it when stored value is missing', async () => {
    vi.mocked(agentManager.ensureAgent).mockResolvedValue(
      agentReturning(`${ENGINE_KEY}\n`) as never,
    );
    vi.mocked(loadSavedSecrets).mockReturnValue({}); // nothing stored yet

    const result = await reconcileHermesApiKey('Local');

    expect(result.outcome).toBe('changed');
    // Reads API_SERVER_KEY over the exec seam (loopback podman exec).
    const cmd = vi.mocked(agentManager.ensureAgent).mock.results[0].value as Promise<{
      sendCommand: ReturnType<typeof vi.fn>;
    }>;
    const agent = await cmd;
    expect(agent.sendCommand).toHaveBeenCalledWith(
      'exec',
      expect.objectContaining({ command: expect.stringContaining('printenv API_SERVER_KEY') }),
      expect.anything(),
    );
    // Stores the exact trimmed engine key under HERMES_API_KEY.
    expect(persistSingleSecret).toHaveBeenCalledWith('HERMES_API_KEY', ENGINE_KEY);
    // Result never carries the key value.
    expect(JSON.stringify(result)).not.toContain(ENGINE_KEY);
  });

  it('is a no-op (aligned) when the stored key already matches the engine', async () => {
    vi.mocked(agentManager.ensureAgent).mockResolvedValue(
      agentReturning(ENGINE_KEY) as never,
    );
    vi.mocked(loadSavedSecrets).mockReturnValue({ HERMES_API_KEY: ENGINE_KEY });

    const result = await reconcileHermesApiKey('Local');

    expect(result.outcome).toBe('aligned');
    expect(persistSingleSecret).not.toHaveBeenCalled();
  });

  it('reports not-found and does not write when no container yields a key', async () => {
    // printenv unset → `|| true` yields empty stdout for every candidate.
    vi.mocked(agentManager.ensureAgent).mockResolvedValue(agentReturning('') as never);

    const result = await reconcileHermesApiKey('Local');

    expect(result.outcome).toBe('not-found');
    expect(persistSingleSecret).not.toHaveBeenCalled();
  });

  it('never regenerates: it only stores the value read from the engine', async () => {
    const other = 'a-totally-different-engine-key-999';
    vi.mocked(agentManager.ensureAgent).mockResolvedValue(agentReturning(other) as never);
    vi.mocked(loadSavedSecrets).mockReturnValue({ HERMES_API_KEY: 'stale-servicebay-key' });

    await reconcileHermesApiKey('Local');

    // Adopts the engine's value verbatim — does NOT invent a new key.
    expect(persistSingleSecret).toHaveBeenCalledWith('HERMES_API_KEY', other);
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolServer } from './context';

/**
 * #2615 — `get_health_checks` used to return only the checks stored in
 * `checks.json`. The dashboard's `/api/health/checks` additionally folds in the
 * synthetic `diagnose:<probeId>` rows, so every diagnose-backed signal existed
 * on one surface and not the other. That is how "there is no backup check
 * anywhere on this box" read as true.
 */

const stored = vi.hoisted(() => ({ checks: [] as unknown[], diagnose: [] as unknown[] }));

vi.mock('@/lib/health/store', () => ({
  HealthStore: {
    getChecks: () => stored.checks,
    getLastResult: () => null,
    saveCheck: vi.fn(),
    deleteCheck: vi.fn(),
  },
}));
vi.mock('@/lib/diagnose/diagnoseChecks', () => ({
  getDiagnoseChecksEnriched: () => stored.diagnose,
}));
vi.mock('@/lib/health/runner', () => ({ CheckRunner: { runCheck: vi.fn() } }));

interface CapturedTool {
  description: string;
  handler: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }>;
}
const tools = new Map<string, CapturedTool>();
const stubServer: ToolServer = {
  tool(name: string, description: string, _schema: unknown, handler: CapturedTool['handler']) {
    tools.set(name, { description, handler });
    return undefined;
  },
};

beforeEach(async () => {
  tools.clear();
  stored.checks = [{ id: 'podman-socket', name: 'Podman Socket', type: 'service', target: 'podman.socket' }];
  stored.diagnose = [];
  const { registerHealthTools } = await import('./healthTools');
  registerHealthTools({ server: stubServer });
});

async function callGetHealthChecks(): Promise<Array<Record<string, unknown>>> {
  const tool = tools.get('get_health_checks');
  if (!tool) throw new Error('get_health_checks was not registered');
  const result = await tool.handler();
  return JSON.parse(result.content[0].text) as Array<Record<string, unknown>>;
}

describe('get_health_checks', () => {
  it('still returns the stored checks with their last result', async () => {
    const rows = await callGetHealthChecks();
    expect(rows.map(r => r.id)).toEqual(['podman-socket']);
    expect(rows[0]).toHaveProperty('lastResult', null);
  });

  it('folds in the self-diagnose rows, so the backup probes are visible over MCP', async () => {
    stored.diagnose = [
      { id: 'diagnose:content_backup', name: 'Self-diagnose: Content backup (Backup Sync)', type: 'diagnose', status: 'fail' },
      { id: 'diagnose:config_backup', name: 'Self-diagnose: Config backup (last nightly run)', type: 'diagnose', status: 'ok' },
    ];
    const rows = await callGetHealthChecks();
    expect(rows.map(r => r.id)).toEqual([
      'podman-socket',
      'diagnose:content_backup',
      'diagnose:config_backup',
    ]);
    // Two separate rows with two different verdicts — the whole point: a green
    // config backup must not be able to speak for the content backup.
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    expect(byId['diagnose:content_backup'].status).toBe('fail');
    expect(byId['diagnose:config_backup'].status).toBe('ok');
  });
});

/**
 * #2872 — `list_backups` returned only Backup Sync's own history, so on a box
 * whose Backup Sync was never really configured the tool's answer was "one
 * failed run in July 2026" for ever, while a healthy nightly config backup was
 * writing thirteen tarballs to the NAS every night. Accepting a service's
 * backup declaration (#2849) through MCP was therefore impossible. Both
 * mechanisms are now reported, side by side and never merged (ADR 0002).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolServer } from './context';

const state = vi.hoisted(() => ({
  history: [] as unknown[],
  config: {} as Record<string, unknown>,
  nasList: (async () => [] as unknown[]) as () => Promise<unknown[]>,
}));

vi.mock('@/lib/backup/service', () => ({
  getBackupHistory: async () => state.history,
  isBackupRunning: () => false,
}));
vi.mock('@/lib/backup/runNow', () => ({ runBackupNow: vi.fn() }));
vi.mock('@/lib/externalBackup/producer', () => ({ listServiceBackups: () => state.nasList() }));
vi.mock('@/lib/config', () => ({ getConfig: async () => state.config }));
vi.mock('@/lib/systemBackup', () => ({ restoreSystemBackup: vi.fn() }));

interface CapturedTool {
  handler: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }>;
}
const tools = new Map<string, CapturedTool>();
const stubServer: ToolServer = {
  tool(name: string, _description: string, _schema: unknown, handler: CapturedTool['handler']) {
    tools.set(name, { handler });
    return undefined;
  },
};

beforeEach(async () => {
  tools.clear();
  state.history = [];
  state.config = {};
  state.nasList = async () => [];
  const { registerBackupTools } = await import('./backupTools');
  registerBackupTools({ server: stubServer });
});

async function callListBackups(): Promise<Record<string, unknown>> {
  const tool = tools.get('list_backups');
  if (!tool) throw new Error('list_backups was not registered');
  return JSON.parse((await tool.handler()).content[0].text);
}

describe('list_backups', () => {
  it('reports the NAS config run — tally and tar names — alongside the content runs', async () => {
    state.history = [{ success: false, completedAt: '2026-07-19T17:57:36.030Z', message: 'boom' }];
    state.config = {
      externalBackup: {
        lastRun: '2026-09-08T15:24:57.697Z',
        lastStatus: 'success',
        lastMessage: '13/13 services backed up',
        servicesOk: 13,
        servicesTotal: 13,
        servicesIncomplete: [],
      },
    };
    state.nasList = async () => [
      { service: 'paperless', tarName: 'paperless-2026-09-08.tar', size: 4096 },
    ];

    const result = await callListBackups();

    expect(result.contentBackup).toEqual({ runs: state.history });
    expect(result.configBackup).toMatchObject({
      lastStatus: 'success',
      servicesOk: 13,
      servicesTotal: 13,
      backups: [{ service: 'paperless', tarName: 'paperless-2026-09-08.tar', size: 4096 }],
    });
  });

  it('still reports the recorded run when the NAS listing itself fails', async () => {
    state.config = { externalBackup: { lastStatus: 'success', servicesOk: 13, servicesTotal: 13 } };
    state.nasList = async () => { throw new Error('ECONNREFUSED 192.168.178.1:21'); };

    const result = await callListBackups();

    expect(result.configBackup).toMatchObject({ servicesOk: 13, backups: [], listError: expect.stringContaining('ECONNREFUSED') });
  });

  it('reports nulls, not an exception, on a box that has never run either mechanism', async () => {
    const result = await callListBackups();
    expect(result.contentBackup).toEqual({ runs: [] });
    expect(result.configBackup).toMatchObject({ lastRun: null, lastStatus: null, servicesOk: null, backups: [] });
  });
});

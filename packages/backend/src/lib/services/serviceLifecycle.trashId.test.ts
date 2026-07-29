/**
 * #2452 — `restoreTrashedService` interpolates `trashId` into `cat`/`mv`/`rm -rf`
 * command strings but, unlike its sibling `purgeTrash`, never validated it. A
 * `..`/`../..` id resolves outside the trash bucket, so the closing
 * `rm -rf '${trashRoot}/${trashId}'` would wipe the Quadlet directory itself.
 *
 * Both trash paths now share `assertTrashId` (lib/api/schemas.ts). These tests
 * assert the reject happens BEFORE the agent is ever contacted — nothing is
 * sent to exec.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSendCommand = vi.fn();
const ensureAgent = vi.fn(async () => ({ sendCommand: mockSendCommand }));
vi.mock('../agent/manager', () => ({ agentManager: { ensureAgent: (...a: unknown[]) => ensureAgent(...(a as [])) } }));

import { ServiceLifecycle } from './serviceLifecycle';

const HOSTILE_TRASH_IDS = [
  '..',
  '../..',
  '../../.config/containers/systemd',
  'a/b',
  "x'; rm -rf ~; '",
  'x$(id)',
  'x`id`',
  'x; rm -rf /',
  '.trash',
  '',
];

beforeEach(() => {
  mockSendCommand.mockReset();
  ensureAgent.mockClear();
});

describe('restoreTrashedService — trash id validation (#2452)', () => {
  for (const payload of HOSTILE_TRASH_IDS) {
    it(`refuses ${JSON.stringify(payload)} without touching the agent`, async () => {
      await expect(ServiceLifecycle.restoreTrashedService('local', payload)).rejects.toThrow(/Invalid trash id/);
      expect(ensureAgent).not.toHaveBeenCalled();
      expect(mockSendCommand).not.toHaveBeenCalled();
    });
  }
});

describe('purgeTrash — trash id validation (#2452, pre-existing check kept)', () => {
  for (const payload of HOSTILE_TRASH_IDS.filter(Boolean)) {
    it(`refuses ${JSON.stringify(payload)} without issuing rm -rf`, async () => {
      await expect(ServiceLifecycle.purgeTrash('local', { trashId: payload })).rejects.toThrow(/Invalid trash id/);
      expect(mockSendCommand).not.toHaveBeenCalled();
    });
  }

  it('still purges a legitimate generated trash id', async () => {
    mockSendCommand.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const trashId = '2026-07-29T12-34-56-789Z-media';
    const res = await ServiceLifecycle.purgeTrash('local', { trashId });
    expect(res.purged).toEqual([trashId]);
    const cmd = mockSendCommand.mock.calls.find(([action]) => action === 'exec')?.[1]?.command as string;
    expect(cmd).toContain(`.trash/${trashId}`);
    expect(cmd).not.toContain('..');
  });
});

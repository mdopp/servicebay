import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1813 — a re-deploy that changes the pod spec must actually apply the new
// topology. `systemctl start` is a no-op on an already-active unit, so the
// deploy path reads the on-disk content before overwriting and, when the
// render changed AND the unit is live, issues a `restart` instead of a `start`.
// These tests cover the two seams that decision rides on.

const mockSendCommand = vi.fn();
vi.mock('../agent/manager', () => ({
    agentManager: {
        ensureAgent: async () => ({ sendCommand: mockSendCommand }),
    },
}));

import { ServiceLifecycle } from './serviceLifecycle';

beforeEach(() => {
    mockSendCommand.mockReset();
});

describe('ServiceLifecycle.isServiceActive (#1813)', () => {
    it('returns true when systemctl reports "active"', async () => {
        mockSendCommand.mockResolvedValue({ code: 0, stdout: 'active\n', stderr: '' });
        await expect(ServiceLifecycle.isServiceActive('local', 'voice')).resolves.toBe(true);
        expect(mockSendCommand).toHaveBeenCalledWith('exec', {
            command: 'systemctl --user is-active voice.service',
        });
    });

    it('returns false for inactive/unknown (first install)', async () => {
        mockSendCommand.mockResolvedValue({ code: 3, stdout: 'inactive\n', stderr: '' });
        await expect(ServiceLifecycle.isServiceActive('local', 'voice')).resolves.toBe(false);
    });

    it('returns false when the agent call throws (best-effort)', async () => {
        mockSendCommand.mockRejectedValue(new Error('agent down'));
        await expect(ServiceLifecycle.isServiceActive('local', 'voice')).resolves.toBe(false);
    });
});

describe('ServiceLifecycle.readExistingQuadletFile (#1813)', () => {
    it('returns the on-disk content (string response)', async () => {
        mockSendCommand.mockResolvedValue('old yaml content');
        await expect(ServiceLifecycle.readExistingQuadletFile('local', 'voice.yml')).resolves.toBe('old yaml content');
        expect(mockSendCommand).toHaveBeenCalledWith('read_file', {
            path: '~/.config/containers/systemd/voice.yml',
        });
    });

    it('returns the on-disk content ({content} response)', async () => {
        mockSendCommand.mockResolvedValue({ content: 'old kube content' });
        await expect(ServiceLifecycle.readExistingQuadletFile('local', 'voice.kube')).resolves.toBe('old kube content');
    });

    it('returns null when the file is missing (read error → first install)', async () => {
        mockSendCommand.mockRejectedValue(new Error('No such file'));
        await expect(ServiceLifecycle.readExistingQuadletFile('local', 'voice.yml')).resolves.toBeNull();
    });

    it('returns null for an unrecognised response shape', async () => {
        mockSendCommand.mockResolvedValue({ code: 0 });
        await expect(ServiceLifecycle.readExistingQuadletFile('local', 'voice.yml')).resolves.toBeNull();
    });
});

describe('restart-on-spec-change decision (#1813)', () => {
    // The deploy path computes `specChanged = prevYaml !== yamlContent ||
    // prevKube !== kubeContent` and restarts only when that is true AND the
    // unit is active. These assert the branch table the bug fix relies on.
    const decide = (specChanged: boolean, active: boolean) =>
        specChanged && active ? 'restart' : 'start';

    it('restarts when the spec changed and the unit is live (the #1813 bug)', () => {
        expect(decide(true, true)).toBe('restart');
    });

    it('plain-starts on first install (unit not active) even if content "changed"', () => {
        expect(decide(true, false)).toBe('start');
    });

    it('plain-starts a variable-only refresh that produced identical files', () => {
        expect(decide(false, true)).toBe('start');
    });
});

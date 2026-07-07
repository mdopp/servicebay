import { describe, it, expect, vi, beforeEach } from 'vitest';

// #2174 — a post-deploy.py can swap a service to a `.container` GPU Quadlet
// (ollama CDI fixup, #1026), but deployKubeService always (re)writes
// `${name}.kube` + `${name}.yml`, and BOTH generate `${name}.service`. systemd
// may pick the `.kube` (kube-play, CPU, no CDI device) — silently dropping
// ollama to CPU. reconcileContainerQuadletShadow retires the shadowing units
// and force-recreates the container so it picks up the CDI device. These tests
// cover the guard + the full reconcile sequence.

const mockSendCommand = vi.fn();
vi.mock('../agent/manager', () => ({
    agentManager: {
        ensureAgent: async () => ({ sendCommand: mockSendCommand }),
    },
}));

import { ServiceLifecycle } from './serviceLifecycle';

const OLLAMA_YAML = `
apiVersion: v1
kind: Pod
metadata:
  name: ollama
spec:
  containers:
    - name: ollama
      image: docker.io/ollama/ollama:latest
`;

// Every `exec` reply is a {code,stdout,stderr}; write_file replies "ok".
function replyFor(action: string, params: unknown) {
    if (action === 'exec') {
        const cmd = (params as { command?: string })?.command ?? '';
        if (/\.container && echo present \|\| echo absent/.test(cmd)) {
            // default: `.container` is present (GPU mode)
            return { code: 0, stdout: 'present\n', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
    }
    return 'ok';
}

beforeEach(() => {
    mockSendCommand.mockReset();
    mockSendCommand.mockImplementation(async (action: string, params: unknown) => replyFor(action, params));
});

const execCommands = () =>
    mockSendCommand.mock.calls
        .filter(([action]) => action === 'exec')
        .map(([, params]) => (params as { command?: string })?.command ?? '');

describe('reconcileContainerQuadletShadow (#2174)', () => {
    it('is a no-op when no .container unit is on disk (ordinary kube deploy)', async () => {
        mockSendCommand.mockImplementation(async (action: string, params: unknown) => {
            if (action === 'exec') {
                const cmd = (params as { command?: string })?.command ?? '';
                if (/\.container && echo present/.test(cmd)) {
                    return { code: 0, stdout: 'absent\n', stderr: '' };
                }
            }
            return replyFor(action, params);
        });

        await ServiceLifecycle.reconcileContainerQuadletShadow('local', 'nginx', 'nginx.yml', '');

        const cmds = execCommands();
        // Only the guard probe ran — nothing was moved, removed, or restarted.
        expect(cmds).toHaveLength(1);
        expect(cmds[0]).toMatch(/nginx\.container && echo present/);
        expect(cmds.some(c => /podman rm -f/.test(c))).toBe(false);
        expect(cmds.some(c => /mv -f/.test(c))).toBe(false);
    });

    it('retires the shadowing .kube/.yml and force-recreates the container when .container is in use', async () => {
        await ServiceLifecycle.reconcileContainerQuadletShadow('local', 'ollama', 'ollama.yml', OLLAMA_YAML);

        const cmds = execCommands();

        // Shadowing units moved into the trash bucket (recoverable, not rm).
        expect(cmds.some(c => /mv -f ~\/\.config\/containers\/systemd\/ollama\.kube '.*\.trash\/.*-ollama-shadow\/'/.test(c))).toBe(true);
        expect(cmds.some(c => /mv -f ~\/\.config\/containers\/systemd\/ollama\.yml '.*\.trash\/.*-ollama-shadow\/'/.test(c))).toBe(true);

        // daemon reloaded so `.service` re-resolves to the `.container`.
        expect(cmds.some(c => /systemctl --user daemon-reload/.test(c))).toBe(true);

        // Force-recreate: stop, then rm -f every plausible container name
        // (a plain restart leaves the old CPU container by name).
        expect(cmds.some(c => /systemctl --user stop ollama\.service/.test(c))).toBe(true);
        expect(cmds.some(c => /podman rm -f ollama-ollama /.test(c))).toBe(true);
        expect(cmds.some(c => /podman rm -f systemd-ollama /.test(c))).toBe(true);

        // ...then start so the `.container` unit recreates it with the CDI device.
        expect(cmds.some(c => /systemctl --user --no-block start ollama\.service/.test(c))).toBe(true);
    });

    it('orders the force-recreate: stop → rm -f → start (rm before start)', async () => {
        await ServiceLifecycle.reconcileContainerQuadletShadow('local', 'ollama', 'ollama.yml', OLLAMA_YAML);
        const cmds = execCommands();

        const stopIdx = cmds.findIndex(c => /systemctl --user stop ollama\.service/.test(c));
        const rmIdx = cmds.findIndex(c => /podman rm -f ollama-ollama /.test(c));
        const startIdx = cmds.findIndex(c => /systemctl --user --no-block start ollama\.service/.test(c));

        expect(stopIdx).toBeGreaterThanOrEqual(0);
        expect(rmIdx).toBeGreaterThan(stopIdx);
        expect(startIdx).toBeGreaterThan(rmIdx);
    });

    it('never throws even if an agent command fails (deploy must not roll back)', async () => {
        mockSendCommand.mockImplementation(async (action: string, params: unknown) => {
            const cmd = (params as { command?: string })?.command ?? '';
            if (/\.container && echo present/.test(cmd)) return { code: 0, stdout: 'present\n', stderr: '' };
            throw new Error('agent down');
        });
        await expect(
            ServiceLifecycle.reconcileContainerQuadletShadow('local', 'ollama', 'ollama.yml', OLLAMA_YAML),
        ).resolves.toBeUndefined();
    });
});

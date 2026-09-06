import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #2861 — the seam, not the transform.
 *
 * `quadletAutoUpdate.test.ts` covers the policy itself. THIS file drives the
 * real `deployKubeService` and asserts what actually lands in
 * `~/.config/containers/systemd/<name>.kube`, because the bug was never in a
 * helper: the generated unit carried `AutoUpdate=registry` unconditionally,
 * and a `localhost/…` image then made the box-wide `podman auto-update` run
 * exit 125, stalling every other container's update check.
 *
 * It also pins the convergence property the hand-repaired box depends on:
 * this is the one choke point every kube-write path goes through, so a plain
 * reconfigure/upgrade re-renders the corrected unit with no manual step.
 */

const mockSendCommand = vi.fn();
vi.mock('../agent/manager', () => ({
    agentManager: {
        ensureAgent: async () => ({ sendCommand: mockSendCommand }),
    },
}));
vi.mock('../history', () => ({ saveSnapshot: vi.fn() }));

import { ServiceLifecycle } from './serviceLifecycle';

/** What every ServiceBay generator hands the deploy path today. */
const GENERATED_KUBE = '[Kube]\nYaml=spike.yml\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target';

function pod(containers: ReadonlyArray<{ name: string; image: string }>): string {
    return [
        'apiVersion: v1',
        'kind: Pod',
        'metadata:',
        '  name: spike',
        '  annotations:',
        '    servicebay.label: "Spike"',
        'spec:',
        '  containers:',
        ...containers.flatMap(c => [`  - name: ${c.name}`, `    image: ${c.image}`]),
        '',
    ].join('\n');
}

function stubAgent(): void {
    mockSendCommand.mockImplementation(async (action: string) => {
        if (action === 'write_file') return 'ok';
        if (action === 'read_file') return { content: '' };
        return { code: 0, stdout: '', stderr: '' };
    });
}

/** The content the deploy wrote to a given Quadlet filename. */
function written(filename: string): string | undefined {
    const call = mockSendCommand.mock.calls
        .filter(([action]) => action === 'write_file')
        .reverse()
        .find(([, params]) => params?.path === `~/.config/containers/systemd/${filename}`);
    return call?.[1]?.content;
}

async function deploy(podYaml: string): Promise<void> {
    await ServiceLifecycle.deployKubeService('Local', 'spike', GENERATED_KUBE, podYaml, 'spike.yml');
}

describe('deployKubeService derives AutoUpdate= from the pod images (#2861)', () => {
    beforeEach(() => {
        mockSendCommand.mockReset();
        stubAgent();
    });

    it('writes AutoUpdate=local for a pod built entirely from localhost/ images', async () => {
        await deploy(pod([
            { name: 'gemma', image: 'localhost/asteroids-gemma:1' },
            { name: 'qwen', image: 'localhost/asteroids-qwen:1' },
        ]));
        const kube = written('spike.kube');
        expect(kube).toContain('AutoUpdate=local');
        expect(kube).not.toContain('AutoUpdate=registry');
    });

    it('keeps AutoUpdate=registry for a pod whose images all come from a registry', async () => {
        await deploy(pod([
            { name: 'web', image: 'docker.io/library/nginx:1.25' },
            { name: 'api', image: 'ghcr.io/acme/api:2' },
        ]));
        expect(written('spike.kube')).toContain('AutoUpdate=registry');
    });

    it('drops the [Kube] line and annotates the pod per container when the images are mixed', async () => {
        await deploy(pod([
            { name: 'gemma', image: 'localhost/asteroids-gemma:1' },
            { name: 'proxy', image: 'docker.io/library/nginx:1.25' },
        ]));
        expect(written('spike.kube')).not.toMatch(/^\s*AutoUpdate=/m);
        const yml = written('spike.yml');
        expect(yml).toContain('io.containers.autoupdate/gemma: "local"');
        expect(yml).toContain('io.containers.autoupdate/proxy: "registry"');
    });

    it('leaves the pod manifest untouched when nothing needed correcting', async () => {
        const podYaml = pod([{ name: 'web', image: 'docker.io/library/nginx:1.25' }]);
        await deploy(podYaml);
        expect(written('spike.yml')).toBe(podYaml);
    });
});

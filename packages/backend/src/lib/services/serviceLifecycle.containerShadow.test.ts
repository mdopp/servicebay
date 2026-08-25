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

    it('names the retire step without claiming a recreate it has not decided on yet', async () => {
        const lines: string[] = [];
        await ServiceLifecycle.reconcileContainerQuadletShadow('local', 'ollama', 'ollama.yml', OLLAMA_YAML, m => lines.push(m));
        expect(lines[0]).toMatch(/retiring the shadowing \.kube\/\.yml\.$/);
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

// ---------------------------------------------------------------------------
// #2618 — the force-recreate above is also what evicts everything the container
// holds in memory. For ollama that is the VRAM-resident model set, so every
// install paid a cold reload (tens of seconds per model) for nothing when the
// unit had not actually changed. The recreate now runs only on evidence that
// the running container is NOT the one the `.container` unit describes.
// ---------------------------------------------------------------------------

const OLLAMA_CONTAINER_UNIT = `[Unit]
Description=Ollama (GPU passthrough #1026 fixup)

[Container]
Image=docker.io/ollama/ollama:latest
ContainerName=ollama
Environment=OLLAMA_HOST=127.0.0.1:11434
# Keep models resident between requests (#268).
Environment=OLLAMA_MAX_LOADED_MODELS=2
AddDevice=nvidia.com/gpu=all

[Install]
WantedBy=default.target
`;

/** Same unit after a re-render: comments moved, Environment lines reordered. */
const OLLAMA_CONTAINER_UNIT_CHURNED = `[Unit]

# Ollama, GPU passthrough (#1026)
Description=Ollama (GPU passthrough #1026 fixup)

[Container]
Environment=OLLAMA_MAX_LOADED_MODELS=2
Environment=OLLAMA_HOST=127.0.0.1:11434
ContainerName=ollama
AddDevice=nvidia.com/gpu=all
Image=docker.io/ollama/ollama:latest

[Install]
WantedBy=default.target
`;

const RUNNING_ARGV = [
    '/usr/bin/podman', 'run', '--name', 'ollama', '--replace', '--rm', '--cgroups=split',
    '--sdnotify=conmon', '-d', '--device', 'nvidia.com/gpu=all',
    '--env', 'OLLAMA_HOST=127.0.0.1:11434', '--env', 'OLLAMA_MAX_LOADED_MODELS=2',
    'docker.io/ollama/ollama:latest',
];

const IMAGE_ID = 'sha256:1111';

interface BoxState {
    unit?: string;
    /** argv the *generated* unit would exec (podman's quadlet output). */
    desiredArgv?: string[] | null;
    /** argv that actually created the running container. */
    createCommand?: string[] | null;
    running?: boolean;
    runningImageId?: string;
    localImageId?: string;
    active?: boolean;
}

/** Mock a box where a `.container` GPU Quadlet is deployed and running. */
function boxWith(state: BoxState = {}) {
    const s = {
        unit: OLLAMA_CONTAINER_UNIT,
        desiredArgv: RUNNING_ARGV as string[] | null,
        createCommand: RUNNING_ARGV as string[] | null,
        running: true,
        runningImageId: IMAGE_ID,
        localImageId: IMAGE_ID,
        active: true,
        ...state,
    };
    mockSendCommand.mockImplementation(async (action: string, params: unknown) => {
        if (action === 'read_file') {
            const p = (params as { path?: string })?.path ?? '';
            return p.endsWith('ollama.container') ? s.unit : '';
        }
        if (action !== 'exec') return 'ok';
        const cmd = (params as { command?: string })?.command ?? '';
        const out = (stdout: string) => ({ code: 0, stdout, stderr: '' });
        if (/\.container && echo present/.test(cmd)) return out('present\n');
        if (/systemctl --user show ollama\.service --property=ExecStart/.test(cmd)) {
            if (!s.desiredArgv) return out('ExecStart=\n');
            return out(`ExecStart={ path=/usr/bin/podman ; argv[]=${s.desiredArgv.join(' ')} ; ignore_errors=no ; start_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n`);
        }
        if (/^podman inspect --format/.test(cmd)) {
            return out(`${s.running}|${s.runningImageId}|${JSON.stringify(s.createCommand)}\n`);
        }
        if (/^podman image inspect --format/.test(cmd)) return out(`${s.localImageId}\n`);
        if (/systemctl --user is-active/.test(cmd)) return out(s.active ? 'active\n' : 'inactive\n');
        return out('');
    });
}

const reconcile = (lines?: string[]) =>
    ServiceLifecycle.reconcileContainerQuadletShadow(
        'local', 'ollama', 'ollama.yml', OLLAMA_YAML, lines ? (m: string) => lines.push(m) : undefined,
    );

const wasRecreated = () => {
    const cmds = execCommands();
    return cmds.some(c => /podman rm -f/.test(c)) || cmds.some(c => /systemctl --user stop ollama\.service/.test(c));
};

describe('reconcileContainerQuadletShadow — warm state survives an unchanged redeploy (#2618)', () => {
    it('leaves an already-matching GPU container running: no stop, no rm -f, no start', async () => {
        boxWith();
        const lines: string[] = [];
        await reconcile(lines);

        expect(wasRecreated()).toBe(false);
        expect(execCommands().some(c => /--no-block start ollama\.service/.test(c))).toBe(false);
        // The named outcome — not folded into a generic "done".
        expect(lines.some(l => /left running, NOT recreated/.test(l))).toBe(true);
        expect(lines.join('\n')).toMatch(/VRAM-resident models/);
    });

    it('still retires the shadowing .kube/.yml on the skip path', async () => {
        boxWith();
        await reconcile();
        const cmds = execCommands();
        expect(cmds.some(c => /mv -f ~\/\.config\/containers\/systemd\/ollama\.kube '.*\.trash\//.test(c))).toBe(true);
        expect(cmds.some(c => /mv -f ~\/\.config\/containers\/systemd\/ollama\.yml '.*\.trash\//.test(c))).toBe(true);
        expect(cmds.some(c => /systemctl --user daemon-reload/.test(c))).toBe(true);
    });

    it('is not fooled by a regenerated-but-equivalent unit file (comments moved, env reordered)', async () => {
        // Same deploy, unit file rewritten byte-differently. podman's generator
        // emits the same argv, so nothing restarts.
        boxWith({ unit: OLLAMA_CONTAINER_UNIT_CHURNED });
        await reconcile();
        expect(wasRecreated()).toBe(false);
    });

    it('DOES force-recreate when the GPU device was added to the unit', async () => {
        // Running container predates the CDI fixup — the #2174 case that must
        // never be skipped.
        boxWith({ createCommand: RUNNING_ARGV.filter(v => v !== '--device' && v !== 'nvidia.com/gpu=all') });
        const lines: string[] = [];
        await reconcile(lines);

        expect(execCommands().some(c => /podman rm -f ollama-ollama /.test(c))).toBe(true);
        expect(execCommands().some(c => /--no-block start ollama\.service/.test(c))).toBe(true);
        expect(lines.some(l => /force-recreating the container — the \.container Quadlet changed/.test(l))).toBe(true);
    });

    it('DOES force-recreate when an env value in the unit changed', async () => {
        boxWith({
            createCommand: RUNNING_ARGV.map(v => v === 'OLLAMA_MAX_LOADED_MODELS=2' ? 'OLLAMA_MAX_LOADED_MODELS=1' : v),
        });
        await reconcile();
        expect(wasRecreated()).toBe(true);
    });

    it('DOES force-recreate when the running container came from podman kube play', async () => {
        boxWith({ createCommand: ['/usr/bin/podman', 'kube', 'play', '--replace', 'ollama.yml'] });
        await reconcile();
        expect(wasRecreated()).toBe(true);
    });

    it('DOES force-recreate when a newer image landed for the same unit', async () => {
        boxWith({ localImageId: 'sha256:2222' });
        const lines: string[] = [];
        await reconcile(lines);
        expect(wasRecreated()).toBe(true);
        expect(lines.some(l => /newer image/.test(l))).toBe(true);
    });

    it.each([
        ['the container is stopped', { running: false }],
        ['the container is gone', { createCommand: null }],
        ['the unit is inactive', { active: false }],
        ['ExecStart is unreadable', { desiredArgv: null }],
        ['the image id cannot be resolved', { localImageId: '' }],
    ] as Array<[string, BoxState]>)('errs toward recreating when %s', async (_label, state) => {
        boxWith(state);
        await reconcile();
        expect(wasRecreated()).toBe(true);
    });
});

describe('deployKubeService — a .container service is not restarted by the shadow write (#2618)', () => {
    it('skips the #1813 pod-spec restart when a .container Quadlet owns the service', async () => {
        // The shadow `.kube`/`.yml` were trashed by the previous deploy, so
        // `specChanged` is structurally true here — before the fix that alone
        // restarted ollama on every install, evicting the warm cache before
        // post-deploy even ran.
        boxWith();
        await ServiceLifecycle.deployKubeService(
            'local', 'ollama', '[Kube]\nYaml=ollama.yml\n', OLLAMA_YAML, 'ollama.yml',
        );
        const cmds = execCommands();
        // Positive control: the deploy really did run through to the reconcile.
        expect(cmds.some(c => /mv -f ~\/\.config\/containers\/systemd\/ollama\.kube '.*\.trash\//.test(c))).toBe(true);
        expect(cmds.some(c => /--no-block restart ollama\.service/.test(c))).toBe(false);
        // …and the reconcile still ran and still decided not to recreate.
        expect(cmds.some(c => /podman rm -f/.test(c))).toBe(false);
    });
});

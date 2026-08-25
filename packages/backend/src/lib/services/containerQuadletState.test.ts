import { describe, it, expect } from 'vitest';

/**
 * #2618 — the load-bearing judgement behind skipping the #2174 force-recreate:
 * "is the running container still the one this `.container` unit describes?"
 *
 * These tests pin BOTH directions, because the two errors are not symmetric:
 * a needless recreate costs a warm VRAM cache (the reported bug), but a missed
 * recreate leaves a container running config nobody deployed while the install
 * reports success. So every "can't tell" must land on `recreate: true`.
 */

import {
    containerNameForQuadlet,
    decideContainerRecreate,
    isSafeShellName,
    parseExecStartArgv,
    parseInspectFacts,
    readUnitDirective,
    type RunningContainerState,
} from './containerQuadletState';

/** The real box's ollama unit (abridged, comments kept on purpose). */
const OLLAMA_UNIT = `[Unit]
Description=Ollama (Local LLM Server, GPU passthrough #1026 fixup)

[Container]
Image=docker.io/ollama/ollama:latest
ContainerName=ollama
Network=host
Environment=OLLAMA_HOST=127.0.0.1:11434
# Keep a model loaded after its last request (#268).
Environment=OLLAMA_KEEP_ALIVE=24h
Environment=OLLAMA_MAX_LOADED_MODELS=2
# CDI device — podman kube play silently drops this (#1026).
AddDevice=nvidia.com/gpu=all
Volume=/mnt/data/stacks/ollama:/root/.ollama:Z

[Install]
WantedBy=default.target
`;

/** The generated ExecStart for that unit — note the env flags come out sorted. */
const OLLAMA_ARGV = [
    '/usr/bin/podman', 'run', '--name', 'ollama', '--replace', '--rm', '--cgroups=split',
    '--network', 'host', '--sdnotify=conmon', '-d', '--device', 'nvidia.com/gpu=all',
    '-v', '/mnt/data/stacks/ollama:/root/.ollama:Z',
    '--env', 'OLLAMA_HOST=127.0.0.1:11434', '--env', 'OLLAMA_KEEP_ALIVE=24h',
    '--env', 'OLLAMA_MAX_LOADED_MODELS=2', 'docker.io/ollama/ollama:latest',
];

const showExecStart = (argv: string[]) =>
    `ExecStart={ path=/usr/bin/podman ; argv[]=${argv.join(' ')} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n`;

const RUNNING: RunningContainerState = {
    running: true,
    imageId: 'sha256:aaaa',
    createCommand: OLLAMA_ARGV,
};

const decide = (
    over: Partial<{ argv: string[] | null; imageId: string; running: RunningContainerState | null; unitActive: boolean }> = {},
) =>
    decideContainerRecreate({
        desired: {
            execStartArgv: over.argv === undefined ? OLLAMA_ARGV : over.argv,
            imageId: over.imageId ?? 'sha256:aaaa',
        },
        running: over.running === undefined ? RUNNING : over.running,
        unitActive: over.unitActive ?? true,
    });

describe('readUnitDirective / containerNameForQuadlet', () => {
    it('reads a directive past comments and blank lines', () => {
        expect(readUnitDirective(OLLAMA_UNIT, 'Image')).toBe('docker.io/ollama/ollama:latest');
        expect(readUnitDirective(OLLAMA_UNIT, 'AddDevice')).toBe('nvidia.com/gpu=all');
        expect(readUnitDirective(OLLAMA_UNIT, 'Nope')).toBeNull();
    });

    it('never reads a value out of a commented-out directive', () => {
        expect(readUnitDirective('[Container]\n# Image=ghcr.io/evil:latest\n', 'Image')).toBeNull();
    });

    it('falls back to quadlet\'s default container name when ContainerName= is absent', () => {
        expect(containerNameForQuadlet('ollama', OLLAMA_UNIT)).toBe('ollama');
        expect(containerNameForQuadlet('whisper', '[Container]\nImage=x\n')).toBe('systemd-whisper');
    });

    it('rejects names that must not be interpolated into a shell command', () => {
        expect(isSafeShellName('ollama')).toBe(true);
        expect(isSafeShellName('docker.io/ollama/ollama:latest')).toBe(true);
        expect(isSafeShellName('ollama; rm -rf /')).toBe(false);
        expect(isSafeShellName('$(id)')).toBe(false);
        expect(isSafeShellName('')).toBe(false);
        expect(isSafeShellName(null)).toBe(false);
    });
});

describe('parseExecStartArgv', () => {
    it('extracts the argv systemd would exec', () => {
        expect(parseExecStartArgv(showExecStart(OLLAMA_ARGV))).toEqual(OLLAMA_ARGV);
    });

    it('returns null (⇒ recreate) for anything it cannot read unambiguously', () => {
        expect(parseExecStartArgv('')).toBeNull();
        expect(parseExecStartArgv('ExecStart=\n')).toBeNull();
        expect(parseExecStartArgv('ExecStartPre={ path=/bin/true ; argv[]=/bin/true ; ignore_errors=no }\n')).toBeNull();
        // Two ExecStart lines: which one creates the container is a guess.
        expect(parseExecStartArgv(showExecStart(OLLAMA_ARGV) + showExecStart(['/usr/bin/podman', 'run', 'x']))).toBeNull();
        // Quoted args cannot be re-tokenised from systemd's flat rendering.
        expect(parseExecStartArgv(showExecStart(['/usr/bin/podman', 'run', '--env', '"A=b c"']))).toBeNull();
    });
});

describe('parseInspectFacts', () => {
    it('parses the running|imageId|createCommand probe', () => {
        expect(parseInspectFacts(`true|sha256:aaaa|${JSON.stringify(OLLAMA_ARGV)}\n`)).toEqual({
            running: true, imageId: 'sha256:aaaa', createCommand: OLLAMA_ARGV,
        });
    });

    it('reports a stopped container rather than pretending it is absent', () => {
        expect(parseInspectFacts('false|sha256:aaaa|[]')).toMatchObject({ running: false });
    });

    it('returns null when the container is absent or podman answered unexpectedly', () => {
        expect(parseInspectFacts('')).toBeNull();
        expect(parseInspectFacts('Error: no such container\n')).toBeNull();
    });

    it('leaves createCommand null when podman did not record one', () => {
        expect(parseInspectFacts('true|sha256:aaaa|null')).toMatchObject({ createCommand: null });
    });
});

describe('decideContainerRecreate — the unchanged direction (the #2618 fix)', () => {
    it('does NOT recreate when the running container came from exactly this unit and image', () => {
        expect(decide()).toMatchObject({ recreate: false });
    });

    it('reads identical inputs out of a re-rendered unit whose comments and ordering churned', () => {
        // The generator, not this code, normalises: comments and blank lines
        // never reach the argv and env flags come out sorted. What this module
        // itself reads from the file — the container name and the image ref —
        // must be equally churn-insensitive, or a rewritten-but-equivalent unit
        // would inspect the wrong container and recreate needlessly. (The
        // end-to-end proof that such a rewrite causes no restart is in
        // serviceLifecycle.containerShadow.test.ts.)
        const churned = `[Container]\n\n# a comment that moved\nContainerName=ollama\n`
            + `Environment=OLLAMA_MAX_LOADED_MODELS=2\n`
            + `   Environment=OLLAMA_HOST=127.0.0.1:11434\n`
            + `# CDI\nAddDevice=nvidia.com/gpu=all\nImage=docker.io/ollama/ollama:latest\n`;
        expect(readUnitDirective(churned, 'Image')).toBe(readUnitDirective(OLLAMA_UNIT, 'Image'));
        expect(containerNameForQuadlet('ollama', churned)).toBe(containerNameForQuadlet('ollama', OLLAMA_UNIT));
    });
});

describe('decideContainerRecreate — the changed direction (must still bite)', () => {
    it('recreates when the unit gained a directive (GPU device added)', () => {
        const withoutGpu = OLLAMA_ARGV.filter((v, i) =>
            !(v === '--device' || OLLAMA_ARGV[i - 1] === '--device'));
        expect(decide({ running: { ...RUNNING, createCommand: withoutGpu } })).toMatchObject({ recreate: true });
        expect(decide({ running: { ...RUNNING, createCommand: withoutGpu } }).reason).toMatch(/different podman run command/);
    });

    it('recreates when an env value changed', () => {
        const older = OLLAMA_ARGV.map(v => v === 'OLLAMA_MAX_LOADED_MODELS=2' ? 'OLLAMA_MAX_LOADED_MODELS=1' : v);
        expect(decide({ running: { ...RUNNING, createCommand: older } })).toMatchObject({ recreate: true });
    });

    it('recreates when the container came from `podman kube play` (the #2174 case)', () => {
        const kubePlay = ['/usr/bin/podman', 'kube', 'play', '--replace', '/home/core/.config/containers/systemd/ollama.yml'];
        expect(decide({ running: { ...RUNNING, createCommand: kubePlay } })).toMatchObject({ recreate: true });
    });

    it('recreates when :latest moved — same argv, different image id', () => {
        expect(decide({ imageId: 'sha256:bbbb' })).toMatchObject({ recreate: true });
        expect(decide({ imageId: 'sha256:bbbb' }).reason).toMatch(/newer image/);
    });
});

describe('decideContainerRecreate — every "can\'t tell" recreates', () => {
    const cases: Array<[string, ReturnType<typeof decide>]> = [
        ['the unit is inactive', decide({ unitActive: false })],
        ['the container is absent', decide({ running: null })],
        ['the container is stopped', decide({ running: { ...RUNNING, running: false } })],
        ['ExecStart is unreadable', decide({ argv: null })],
        ['ExecStart is empty', decide({ argv: [] })],
        ['podman recorded no CreateCommand', decide({ running: { ...RUNNING, createCommand: null } })],
        ['CreateCommand is empty', decide({ running: { ...RUNNING, createCommand: [] } })],
        ['the desired image id is unresolved', decide({ imageId: '' })],
        ['the running image id is unknown', decide({ running: { ...RUNNING, imageId: '' } })],
    ];
    for (const [label, verdict] of cases) {
        it(`recreates when ${label}`, () => {
            expect(verdict.recreate).toBe(true);
            expect(verdict.reason).not.toBe('');
        });
    }
});

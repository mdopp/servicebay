/**
 * The parallel image pre-pull phase (#2742 cut of #805/#1170).
 *
 * `collectImagesToPull` has its own unit test; this covers the phase around
 * it — that pulls fan out in parallel, that the coalesced progress line is
 * throttled rather than emitted per layer, and above all that NOTHING here
 * can fail an install: a dead agent or a failed pull must degrade to a note
 * and let the deploy step pull sequentially.
 *
 * The job log is exercised through the real `./context`, with only the
 * jobStore/socket edges stubbed, so the lines asserted here are the lines an
 * operator sees.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JobInput } from '../jobStore';

const appendLogMock = vi.fn<(id: string, line: string) => Promise<void>>();
vi.mock('../jobStore', () => ({
  appendLog: (id: string, line: string) => appendLogMock(id, line),
  updateJob: vi.fn(),
  getJob: vi.fn(),
}));
vi.mock('../socketBridge', () => ({ emitJobLog: vi.fn(), emitJobUpdate: vi.fn() }));
vi.mock('@/lib/auth/internalToken', () => ({ getInternalApiToken: () => 'tok' }));

type ProgressFn = (ev: { id?: string; status?: string; current?: number; total?: number }) => void;
const pullImageMock = vi.fn<(image: string, onProgress: ProgressFn) => Promise<{ success: boolean }>>();
const ensureAgentMock = vi.fn();
vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: (node: string) => ensureAgentMock(node) },
}));

import { runPrePullPhase } from './prePull';

const lines = () => appendLogMock.mock.calls.map(c => c[1]);

const input = (over: Partial<JobInput> = {}): JobInput => ({
  items: [],
  variables: [],
  templateSource: 'Built-in',
  host: 'servicebay.local',
  ...over,
});

const podYaml = (...images: string[]) =>
  ['spec:', '  containers:', ...images.map(i => `    - image: ${i}`)].join('\n');

beforeEach(() => {
  appendLogMock.mockReset().mockResolvedValue(undefined);
  pullImageMock.mockReset().mockResolvedValue({ success: true });
  ensureAgentMock.mockReset().mockResolvedValue({ pullImage: pullImageMock });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runPrePullPhase', () => {
  it('does nothing at all when the selection references no images', async () => {
    await runPrePullPhase('job1', input(), [{ name: 'media', alreadyInstalled: true, yaml: podYaml('lscr.io/jellyfin') }]);
    expect(ensureAgentMock).not.toHaveBeenCalled();
    expect(appendLogMock).not.toHaveBeenCalled();
  });

  it('warms every unique image in one parallel fan-out and reports the tally', async () => {
    await runPrePullPhase('job1', input({ node: 'box2' }), [
      { name: 'media', yaml: podYaml('docker.io/jellyfin:10', 'docker.io/abs:2') },
      { name: 'auth', yaml: podYaml('docker.io/jellyfin:10', 'docker.io/authelia:4') },
    ]);

    expect(ensureAgentMock).toHaveBeenCalledWith('box2');
    expect(pullImageMock.mock.calls.map(c => c[0])).toEqual([
      'docker.io/jellyfin:10',
      'docker.io/abs:2',
      'docker.io/authelia:4',
    ]);
    expect(lines()[0]).toBe('📦 Pre-pulling 3 container images in parallel...');
    expect(lines()).toContain('✅ Pulled 3/3 images.');
  });

  it('defaults to the Local node and gets the singular wording right', async () => {
    await runPrePullPhase('job1', input(), [{ name: 'media', yaml: podYaml('docker.io/jellyfin:10') }]);
    expect(ensureAgentMock).toHaveBeenCalledWith('Local');
    expect(lines()[0]).toBe('📦 Pre-pulling 1 container image in parallel...');
    expect(lines()).toContain('✅ Pulled 1/1 image.');
  });

  it('renders a Mustache-tagged image ref against the wizard variables (#1170)', async () => {
    // Pre-#1170 the literal `{{GATEKEEPER_IMAGE}}` reached podman and came
    // back as "invalid reference format" in the install log.
    await runPrePullPhase(
      'job1',
      input({ variables: [{ name: 'GATEKEEPER_IMAGE', value: 'ghcr.io/mdopp/solaris-gatekeeper:1.4' }] }),
      [{ name: 'solaris', yaml: podYaml('{{GATEKEEPER_IMAGE}}', '{{UNSET_IMAGE}}') }],
    );
    // The unresolved one is skipped — the deploy step pulls it with the
    // proper render context rather than failing here.
    expect(pullImageMock.mock.calls.map(c => c[0])).toEqual(['ghcr.io/mdopp/solaris-gatekeeper:1.4']);
  });

  it('reports a failed pull as a note with how far it got, and never throws', async () => {
    pullImageMock.mockImplementation(async (image, onProgress) => {
      if (image === 'docker.io/big:1') {
        onProgress({ id: 'l1', status: 'Downloading', current: 512 * 1024, total: 1024 * 1024 });
        onProgress({ id: 'l2', status: 'Already exists' });
        throw new Error('connection reset');
      }
      return { success: true };
    });

    await expect(runPrePullPhase('job1', input(), [
      { name: 'a', yaml: podYaml('docker.io/big:1') },
      { name: 'b', yaml: podYaml('docker.io/small:1') },
    ])).resolves.toBeUndefined();

    expect(lines()).toContain('✅ Pulled 1/2 images.');
    expect(lines()).toContain(
      '(note) pre-pull failed for docker.io/big:1: connection reset (reached 512 KB/1 MB, 1 cached) — will be retried during deploy.',
    );
  });

  it('treats an agent that reports success:false as a failure, with no byte detail', async () => {
    pullImageMock.mockResolvedValue({ success: false });
    await runPrePullPhase('job1', input(), [{ name: 'a', yaml: podYaml('docker.io/x:1') }]);
    expect(lines()).toContain('✅ Pulled 0/1 image.');
    expect(lines()).toContain('(note) pre-pull failed for docker.io/x:1: agent reported failure — will be retried during deploy.');
  });

  it('skips the whole phase with one note when the agent is unreachable', async () => {
    ensureAgentMock.mockRejectedValue(new Error('agent offline'));
    await expect(runPrePullPhase('job1', input(), [{ name: 'a', yaml: podYaml('docker.io/x:1') }])).resolves.toBeUndefined();
    expect(lines()).toContain('(note) parallel pre-pull skipped: agent offline — deploy will pull sequentially as usual.');
  });
});

describe('the coalesced progress line (#805)', () => {
  it('emits at most one line per image per ~2s, not one per layer event', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    pullImageMock.mockImplementation(async (_image, onProgress) => {
      onProgress({ id: 'l1', status: 'Downloading', current: 1024, total: 4096 });
      onProgress({ id: 'l2', status: 'Downloading', current: 1024, total: 4096 }); // same 2s window
      now += 2_500;
      onProgress({ id: 'l2', status: 'Download complete' });
      return { success: true };
    });

    await runPrePullPhase('job1', input(), [{ name: 'a', yaml: podYaml('docker.io/x:1') }]);

    const progress = lines().filter(l => l.trim().startsWith('Pulling '));
    expect(progress).toHaveLength(2);
    expect(progress[0]).toBe('  Pulling docker.io/x:1: 25% (1 KB / 4 KB)');
    // Second line reflects the completed layer, credited its full size.
    expect(progress[1]).toBe('  Pulling docker.io/x:1: 63% (5 KB / 8 KB)');
  });
});

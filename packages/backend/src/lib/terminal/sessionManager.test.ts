/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  nodes: [] as any[],
};

vi.mock('../nodes', () => ({
  listNodes: vi.fn(() => Promise.resolve(state.nodes)),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// node-pty pulls in a native binary at import time. The functions under test
// don't spawn anything (they just compute the spec), so stub the module out.
vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

import { resolvePtySpec } from './sessionManager';

beforeEach(() => {
  state.nodes = [];
});

describe('resolvePtySpec — container terminals', () => {
  it('routes container:local:* through SSH when the Local node has an ssh:// URI (container-mode install)', async () => {
    state.nodes = [{
      Name: 'Local',
      URI: 'ssh://core@127.0.0.1',
      Identity: '/app/data/ssh/id_rsa',
    }];

    const spec = await resolvePtySpec('container:local:abc123');

    expect(spec.shell).toBe('ssh');
    expect(spec.args).toContain('-i');
    expect(spec.args).toContain('/app/data/ssh/id_rsa');
    expect(spec.args).toContain('core@127.0.0.1');
    // The trailing arg is the remote command — must invoke podman exec
    // against the container id, with the bash-or-sh fallback dance.
    const remoteCmd = spec.args[spec.args.length - 1];
    expect(remoteCmd).toContain('podman exec -it');
    expect(remoteCmd).toContain('abc123');
    expect(remoteCmd).toContain('if [ -x /bin/bash ]');
  });

  it('routes container:<remote>:* through SSH for a remote ssh:// node (existing behaviour preserved)', async () => {
    state.nodes = [{
      Name: 'edge',
      URI: 'ssh://core@10.0.0.5:2222',
      Identity: '/keys/edge',
    }];

    const spec = await resolvePtySpec('container:edge:xyz789');

    expect(spec.shell).toBe('ssh');
    expect(spec.args).toContain('-p');
    expect(spec.args).toContain('2222');
    expect(spec.args).toContain('core@10.0.0.5');
    expect(spec.args[spec.args.length - 1]).toContain('xyz789');
  });

  it('falls back to direct podman when no matching node is registered (bare-metal install)', async () => {
    state.nodes = []; // no Local node — bare-metal/dev mode

    const spec = await resolvePtySpec('container:local:abc123');

    expect(spec.shell).toBe('podman');
    expect(spec.args[0]).toBe('exec');
    expect(spec.args).toContain('abc123');
  });

  it('falls back to direct podman when the matched node has a non-ssh URI', async () => {
    state.nodes = [{
      Name: 'Local',
      URI: 'unix:///run/podman/podman.sock',
      Identity: '',
    }];

    const spec = await resolvePtySpec('container:local:abc123');

    expect(spec.shell).toBe('podman');
  });

  it('throws when the container id is empty', async () => {
    await expect(resolvePtySpec('container:local:')).rejects.toThrow(/Invalid container ID/);
  });
});

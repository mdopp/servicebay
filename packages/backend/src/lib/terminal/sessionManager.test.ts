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

import { resolvePtySpec, buildContainerInnerCmd, buildContainerExecCmd, TERMINAL_RUN_PRESETS } from './sessionManager';

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

  it('falls back to direct podman (via sh -c, existence-guarded) when no matching node is registered (bare-metal install)', async () => {
    state.nodes = []; // no Local node — bare-metal/dev mode

    const spec = await resolvePtySpec('container:local:abc123');

    expect(spec.shell).toBe('sh');
    expect(spec.args[0]).toBe('-c');
    const cmd = spec.args[1];
    expect(cmd).toContain('podman container exists abc123');
    expect(cmd).toContain('podman exec -it');
    expect(cmd).toContain('abc123');
  });

  it('falls back to direct podman when the matched node has a non-ssh URI', async () => {
    state.nodes = [{
      Name: 'Local',
      URI: 'unix:///run/podman/podman.sock',
      Identity: '',
    }];

    const spec = await resolvePtySpec('container:local:abc123');

    expect(spec.shell).toBe('sh');
    expect(spec.args[1]).toContain('podman exec -it');
  });

  it('throws when the container id is empty', async () => {
    await expect(resolvePtySpec('container:local:')).rejects.toThrow(/Invalid container ID/);
  });

  it('attaches to a named tmux session when an attach= segment is present (SSH path)', async () => {
    state.nodes = [{ Name: 'Local', URI: 'ssh://core@127.0.0.1', Identity: '/k' }];

    const spec = await resolvePtySpec('container:Local:claude-dev:attach=claude');

    expect(spec.shell).toBe('ssh');
    const remoteCmd = spec.args[spec.args.length - 1];
    expect(remoteCmd).toContain('podman exec -it');
    expect(remoteCmd).toContain('claude-dev');
    expect(remoteCmd).toContain('tmux new -A -s claude');
    expect(remoteCmd).toContain('command -v tmux');
  });

  it('attaches to a named session on the direct-podman (bare-metal) path too', async () => {
    state.nodes = []; // bare-metal

    const spec = await resolvePtySpec('container:Local:dev:attach=claude');

    expect(spec.shell).toBe('sh');
    const inner = spec.args[spec.args.length - 1];
    expect(inner).toContain('tmux new -A -s claude');
  });

  it('parses the container id correctly even with a trailing attach= segment', async () => {
    state.nodes = [];

    const spec = await resolvePtySpec('container:Local:my-ctr:attach=sess');

    // The attach segment must NOT be mistaken for the container id.
    const cmd = spec.args[spec.args.length - 1];
    expect(cmd).toContain('my-ctr');
    expect(cmd).not.toContain('attach=sess');
  });

  it('rejects an attach session name with shell metacharacters', async () => {
    await expect(resolvePtySpec("container:Local:dev:attach=foo;rm -rf /"))
      .rejects.toThrow(/Invalid attach session name/);
  });
});

describe('container existence guard (#1681)', () => {
  it('guards the SSH-path exec with `podman container exists` and surfaces an error on a miss (no host fallback)', async () => {
    state.nodes = [{ Name: 'Local', URI: 'ssh://core@127.0.0.1', Identity: '/k' }];

    // The claude-dev card's real container is `claude-dev-claude-dev`
    // (pod + container), not `claude-dev`.
    const spec = await resolvePtySpec('container:Local:claude-dev-claude-dev:attach=claude');
    const remoteCmd = spec.args[spec.args.length - 1];

    expect(remoteCmd).toContain('podman container exists claude-dev-claude-dev');
    expect(remoteCmd).toContain('podman exec -it');
    expect(remoteCmd).toContain('tmux new -A -s claude');
    // On a miss it errors explicitly and exits — it must NOT drop to a host shell.
    expect(remoteCmd).toContain('no such container');
    expect(remoteCmd).toContain('not falling back to the host shell');
    expect(remoteCmd).toContain('exit 1');
  });

  it('guards the direct-podman (bare-metal) path with the same existence check', async () => {
    state.nodes = [];

    const spec = await resolvePtySpec('container:Local:claude-dev-claude-dev:attach=claude');
    const cmd = spec.args[spec.args.length - 1];

    expect(cmd).toContain('podman container exists claude-dev-claude-dev');
    expect(cmd).toContain('no such container');
    expect(cmd).toContain('exit 1');
  });
});

describe('buildContainerExecCmd', () => {
  it('fronts the exec with an existence check and errors (not host-shell) on a miss', () => {
    const inner = buildContainerInnerCmd('claude');
    const cmd = buildContainerExecCmd('claude-dev-claude-dev', inner);

    expect(cmd).toContain('podman container exists claude-dev-claude-dev');
    expect(cmd).toContain('podman exec -it -e TERM=xterm-256color claude-dev-claude-dev');
    expect(cmd).toContain('tmux new -A -s claude');
    expect(cmd).toMatch(/no such container.*not falling back to the host shell/);
    expect(cmd).toContain('exit 1');
  });
});

describe('buildContainerInnerCmd', () => {
  it('returns a bare bash-or-sh shell when no session is requested', () => {
    const cmd = buildContainerInnerCmd();
    expect(cmd).toContain('/bin/bash');
    expect(cmd).not.toContain('tmux');
  });

  it('attaches to the named session, falling back to a shell when tmux is absent', () => {
    const cmd = buildContainerInnerCmd('claude');
    expect(cmd).toContain('command -v tmux');
    expect(cmd).toContain('exec tmux new -A -s claude');
    expect(cmd).toContain('/bin/bash'); // fallback branch
  });
});

/**
 * `run=<preset>` deep-links (one-tap repairs).
 *
 * A diagnostic can hand the operator a link that opens a terminal in the
 * container with the fix already running — the operator is usually holding a
 * phone when they find out something broke, and SSH plus a typed command is not
 * something you do from there.
 *
 * The security property is the whole design: the URL carries a preset KEY, and
 * only text from `TERMINAL_RUN_PRESETS` ever reaches a shell. A free-form
 * `?cmd=` would be remote code execution by link — anyone who could put a URL
 * in front of an operator would run whatever they liked as the container's
 * root. These tests pin that shut.
 */
describe('sessionManager — run= presets', () => {
  it('runs the whitelisted command and leaves a shell open afterwards', () => {
    const cmd = buildContainerInnerCmd(undefined, 'claude-login');
    expect(cmd).toContain(TERMINAL_RUN_PRESETS['claude-login']);
    // Without the trailing shell the PTY closes the moment the command
    // returns, taking the auth URL it just printed with it.
    expect(cmd).toContain('/bin/bash');
  });

  it('signs in as dev with the workspace HOME, not as the container root', () => {
    // `podman exec` enters as root; a login performed there writes to
    // /root/.claude, where nothing looks for it, and the repair would appear to
    // succeed while fixing nothing.
    const cmd = TERMINAL_RUN_PRESETS['claude-login'];
    expect(cmd).toContain('runuser -u dev');
    expect(cmd).toContain('HOME=/workspace');
  });

  it('rejects a preset that is not on the whitelist', () => {
    expect(() => buildContainerInnerCmd(undefined, 'nope')).toThrow(/Unknown terminal run preset/);
  });

  it('refuses an injected command instead of running it', () => {
    for (const attempt of ['; rm -rf /', 'claude-login; id', '$(id)', '`id`', '../../bin/sh']) {
      expect(() => buildContainerInnerCmd(undefined, attempt)).toThrow(/Unknown terminal run preset/);
    }
  });

  it('never interpolates the caller-supplied key into the command', () => {
    // Even the rejected path must not build a string containing the attempt.
    let built: string | undefined;
    try {
      built = buildContainerInnerCmd(undefined, 'claude-login; id');
    } catch {
      built = undefined;
    }
    expect(built).toBeUndefined();
  });

  it('carries no single quote, which would break out of `sh -c \'…\'`', () => {
    for (const cmd of Object.values(TERMINAL_RUN_PRESETS)) {
      expect(cmd).not.toContain("'");
    }
  });

  it('takes precedence over attach, so a repair lands on a clean prompt', () => {
    const cmd = buildContainerInnerCmd('claude', 'claude-login');
    expect(cmd).toContain(TERMINAL_RUN_PRESETS['claude-login']);
    expect(cmd).not.toContain('tmux new -A -s claude');
  });
});

describe('sessionManager — run= in the session-target grammar', () => {
  beforeEach(() => {
    state.nodes = [{ name: 'Local', uri: '' }];
  });

  it('parses container:<node>:<id>:run=<preset>', async () => {
    const spec = await resolvePtySpec('container:Local:claude-dev-claude-dev:run=claude-login');
    expect(JSON.stringify(spec)).toContain('runuser -u dev');
  });

  it('rejects an unknown preset from the target string', async () => {
    await expect(
      resolvePtySpec('container:Local:claude-dev-claude-dev:run=evil'),
    ).rejects.toThrow(/Unknown terminal run preset/);
  });
});

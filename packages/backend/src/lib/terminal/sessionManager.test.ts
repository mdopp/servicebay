/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  nodes: [] as any[],
  spawned: [] as any[],
};

vi.mock('../nodes', () => ({
  listNodes: vi.fn(() => Promise.resolve(state.nodes)),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// node-pty pulls in a native binary at import time. Most functions under test
// don't spawn anything (they just compute the spec), so stub the module out —
// but the scope-gate tests below need to observe whether a PTY was spawned, so
// the stub hands back a minimal fake process instead of `undefined`.
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const proc = {
      pid: 4242,
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    state.spawned.push(proc);
    return proc;
  }),
}));

import * as pty from 'node-pty';
import {
  resolvePtySpec,
  buildContainerInnerCmd,
  buildContainerExecCmd,
  TERMINAL_RUN_PRESETS,
  TerminalSessionManager,
  TERMINAL_SCOPE,
  terminalScopeRefusal,
} from './sessionManager';

beforeEach(() => {
  state.nodes = [];
  state.spawned = [];
  vi.mocked(pty.spawn).mockClear();
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

/**
 * Scope gate on the Socket.IO terminal surface (#2769).
 *
 * `io.use` in `server.ts` admits any socket whose cookie decodes to *a* valid
 * session — it has to, because the same socket carries logs, install progress
 * and resource broadcasts. That makes the terminal handlers the place the
 * shell-grade scope is checked: without it, a cookie bridged from a `read`-only
 * token (`POST /api/auth/session-from-token`) could `join('host')` and get a
 * live PTY on the box, laundering away the `exec` gate every MCP tool enforces.
 *
 * `exec` is never implied by another scope (#2623), so the check is a literal
 * one — mirroring `cookieScopeRefusal` in `lib/api/requireSession.ts` (#2768),
 * including its back-compat rule that a scope-less cookie (password login)
 * means all scopes.
 */
describe('terminalScopeRefusal — the scope rule (#2769)', () => {
  it('requires exec, the scope no other scope implies (#2623)', () => {
    expect(TERMINAL_SCOPE).toBe('exec');
  });

  it('admits a scope-less cookie session (password login == all scopes, back-compat)', () => {
    expect(terminalScopeRefusal({ user: 'admin', expires: new Date() })).toBeNull();
  });

  it('admits a scoped session that literally carries exec', () => {
    expect(terminalScopeRefusal({ user: 'token:dev', expires: new Date(), scopes: ['read', 'exec'] })).toBeNull();
  });

  it('refuses a read-only bridged session', () => {
    expect(terminalScopeRefusal({ user: 'token:ro', expires: new Date(), scopes: ['read'] })).toMatch(/exec/);
  });

  it('refuses a destroy session — destroy must not launder into shell (#2623)', () => {
    expect(
      terminalScopeRefusal({ user: 'token:ops', expires: new Date(), scopes: ['read', 'lifecycle', 'mutate', 'destroy', 'propose'] }),
    ).toMatch(/exec/);
  });

  it('refuses a socket with no session at all', () => {
    expect(terminalScopeRefusal(undefined)).toBeTruthy();
  });
});

describe('TerminalSessionManager — join/input/resize are scope-gated (#2769)', () => {
  function harness() {
    const handlers = new Map<string, (payload: any) => unknown>();
    const emitted: Array<{ event: string; payload: any }> = [];
    const rooms: string[] = [];
    const socket: any = {
      data: {} as { user?: any },
      on: (event: string, fn: (payload: any) => unknown) => { handlers.set(event, fn); },
      emit: (event: string, payload: any) => { emitted.push({ event, payload }); },
      join: (room: string) => { rooms.push(room); },
    };
    let connect: ((s: any) => void) | undefined;
    const io: any = {
      on: (event: string, fn: (s: any) => void) => { if (event === 'connection') connect = fn; },
      to: () => ({ emit: () => {} }),
    };
    const manager = new TerminalSessionManager({ io });
    return { manager, socket, handlers, emitted, rooms, bind: () => connect!(socket) };
  }

  it('refuses join for a read-only bridged session: no PTY, no room, an explicit error', async () => {
    const h = harness();
    h.manager.start();
    // The host pre-spawn in start() is server-side warm-up, not a user action.
    const preSpawns = vi.mocked(pty.spawn).mock.calls.length;
    h.bind();
    h.socket.data.user = { user: 'token:ro', expires: new Date(), scopes: ['read'] };

    await h.handlers.get('join')!({ id: 'host', cols: 80, rows: 30 });

    expect(vi.mocked(pty.spawn).mock.calls.length).toBe(preSpawns);
    expect(h.rooms).toEqual([]);            // must not be joined — the room streams PTY output
    expect(h.emitted.some(e => e.event === 'history')).toBe(false);
    const denial = h.emitted.find(e => e.event === 'output');
    expect(denial).toBeDefined();
    expect(String(denial!.payload)).toMatch(/denied/i);
    expect(String(denial!.payload)).toMatch(/exec/);
    h.manager.stop();
  });

  it('refuses a container join for a destroy-scoped session (root exec into any container)', async () => {
    const h = harness();
    h.manager.start();
    const preSpawns = vi.mocked(pty.spawn).mock.calls.length;
    h.bind();
    h.socket.data.user = { user: 'token:ops', expires: new Date(), scopes: ['destroy'] };

    await h.handlers.get('join')!({ id: 'container:local:anything' });

    expect(vi.mocked(pty.spawn).mock.calls.length).toBe(preSpawns);
    expect(h.rooms).toEqual([]);
    h.manager.stop();
  });

  it('refuses input from an under-scoped socket, so it cannot drive an existing PTY', async () => {
    const h = harness();
    h.manager.start();
    h.bind();
    // An exec-scoped socket opens the session first…
    h.socket.data.user = { user: 'admin', expires: new Date(), scopes: ['exec'] };
    await h.handlers.get('join')!({ id: 'host' });
    const proc = state.spawned[state.spawned.length - 1];
    proc.write.mockClear();

    // …then the same socket is downgraded to a read-only bridged session.
    h.socket.data.user = { user: 'token:ro', expires: new Date(), scopes: ['read'] };
    h.handlers.get('input')!({ id: 'host', data: 'rm -rf /\n' });
    h.handlers.get('resize')!({ id: 'host', cols: 10, rows: 10 });

    expect(proc.write).not.toHaveBeenCalled();
    expect(proc.resize).not.toHaveBeenCalled();
    h.manager.stop();
  });

  it('still works for a session that carries exec — join spawns, input writes', async () => {
    const h = harness();
    h.manager.start();
    h.bind();
    h.socket.data.user = { user: 'token:shell', expires: new Date(), scopes: ['read', 'exec'] };

    await h.handlers.get('join')!({ id: 'host', cols: 100, rows: 40 });

    expect(h.rooms).toEqual(['host']);
    expect(h.emitted.some(e => e.event === 'history')).toBe(true);
    const proc = state.spawned[state.spawned.length - 1];
    h.handlers.get('input')!({ id: 'host', data: 'id\n' });
    expect(proc.write).toHaveBeenCalledWith('id\n');
    h.manager.stop();
  });

  it('still works for a scope-less password-login cookie (back-compat)', async () => {
    const h = harness();
    h.manager.start();
    h.bind();
    h.socket.data.user = { user: 'admin', expires: new Date() };

    await h.handlers.get('join')!({ id: 'host' });

    expect(h.rooms).toEqual(['host']);
    expect(h.emitted.some(e => e.event === 'history')).toBe(true);
    h.manager.stop();
  });
});

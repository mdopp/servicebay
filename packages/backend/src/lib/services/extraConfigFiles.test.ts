import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeExtraConfigFiles } from './extraConfigFiles';

vi.mock('../logger', () => ({
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

type CmdParams = { path?: string; content?: string; sudo?: boolean; command?: string } | undefined;
type Cmd = { action: string; params: CmdParams };

/**
 * Fake agent that records every sendCommand and replies via `responder`.
 *
 * #1258 — the real `AgentHandler.sendCommand` *rejects* (throws) when the
 * agent process replies with an `error` field; it does not resolve to an
 * `{ error }` object. So the responder signals a command failure by
 * THROWING, mirroring production. The earlier mock returned the error as a
 * value, which hid the dead-retry bug.
 */
function makeAgent(responder: (action: string, params: CmdParams) => unknown) {
    const calls: Cmd[] = [];
    const agent = {
        calls,
        sendCommand: vi.fn(async (action: string, params?: unknown) => {
            const p = params as CmdParams;
            calls.push({ action, params: p });
            return responder(action, p);
        }),
    };
    return agent;
}

const file = { path: '/mnt/data/stacks/oscar-household/skills/README.md', content: '# skills' };

describe('writeExtraConfigFiles', () => {
    beforeEach(() => vi.clearAllMocks());

    it('writes without sudo when the plain write_file succeeds', async () => {
        const agent = makeAgent((action) => (action === 'exec' ? { code: 0 } : 'ok'));
        await writeExtraConfigFiles(agent, 'oscar-household', [file]);

        const writes = agent.calls.filter(c => c.action === 'write_file');
        expect(writes).toHaveLength(1);
        expect(writes[0].params?.sudo).toBeUndefined();
    });

    it('does NOT chown when the plain (core-owned) write succeeds', async () => {
        // #1298 — a core-owned dir needs no realignment; the only exec is the
        // mkdir, never a chown.
        const agent = makeAgent((action) => (action === 'exec' ? { code: 0 } : 'ok'));
        await writeExtraConfigFiles(agent, 'oscar-household', [file]);

        const chowns = agent.calls.filter(c => c.action === 'exec' && /chown/.test(c.params?.command ?? ''));
        expect(chowns).toHaveLength(0);
    });

    it('realigns ownership to the parent dir after a sudo write (#1298)', async () => {
        // A sudo write lands the file root-owned inside a subuid-owned asset
        // dir, which breaks the next rootless `kube play --replace` relabel.
        // After the sudo write we `chown --reference=<dir>` so the new file
        // matches its siblings' (subuid) ownership.
        const agent = makeAgent((action, params) => {
            if (action === 'exec') return { code: 0 };
            if (params?.sudo) return 'ok';
            throw new Error("[Errno 13] Permission denied: '" + file.path + "'");
        });

        await writeExtraConfigFiles(agent, 'oscar-household', [file]);

        const dir = file.path.substring(0, file.path.lastIndexOf('/'));
        const chowns = agent.calls.filter(c => c.action === 'exec' && /chown/.test(c.params?.command ?? ''));
        expect(chowns).toHaveLength(1);
        expect(chowns[0].params?.command).toBe(`sudo chown --reference=${dir} ${file.path}`);
    });

    it('does not fail the deploy when the post-sudo chown fails (#1298)', async () => {
        // The file is already written; an ownership mismatch only bites a later
        // relabel, so a chown rejection must be swallowed (logged), not fatal.
        const agent = makeAgent((action, params) => {
            if (action === 'exec' && /chown/.test(params?.command ?? '')) {
                throw new Error('chown: invalid user');
            }
            if (action === 'exec') return { code: 0 };
            if (params?.sudo) return 'ok';
            throw new Error('[Errno 13] Permission denied');
        });

        await expect(writeExtraConfigFiles(agent, 'oscar-household', [file])).resolves.toBeUndefined();
    });

    it('retries with sudo when the plain write_file rejects (EACCES on container-owned dir)', async () => {
        // #1171/#1258 — first (unprivileged) write rejects because the
        // hostPath is owned by a consumer container's uid; the agent throws
        // the raw `[Errno 13]`, and the sudo retry then succeeds. The throw
        // (not a returned value) is the production contract — see makeAgent.
        const agent = makeAgent((action, params) => {
            if (action === 'exec') return { code: 0 };
            if (params?.sudo) return 'ok';
            throw new Error("[Errno 13] Permission denied: '" + file.path + "'");
        });

        await expect(writeExtraConfigFiles(agent, 'oscar-household', [file])).resolves.toBeUndefined();

        const writes = agent.calls.filter(c => c.action === 'write_file');
        expect(writes).toHaveLength(2);
        expect(writes[0].params?.sudo).toBeUndefined();
        expect(writes[1].params?.sudo).toBe(true);
    });

    it('throws (deploy fails) when both the plain and sudo writes reject', async () => {
        const agent = makeAgent((action) => {
            if (action === 'exec') return { code: 0 };
            throw new Error('disk full');
        });

        await expect(writeExtraConfigFiles(agent, 'oscar-household', [file]))
            .rejects.toThrow(/Failed to write 1 required config file/);

        const writes = agent.calls.filter(c => c.action === 'write_file');
        expect(writes).toHaveLength(2);
        expect(writes[1].params?.sudo).toBe(true);
    });

    // ── #2590: seed-only companion files ────────────────────────────────
    //
    // The incident: a routine convergence pass re-rendered Home Assistant's
    // `automations.yaml` seed over 6729 B of the operator's real automations,
    // unconditionally and silently. A file the template declares seed-only is
    // written ONLY when the node says it is absent.
    describe('seed-only config files (#2590)', () => {
        const HA_DIR = '/mnt/data/stacks/home-assistant/homeassistant';
        const automations = { path: `${HA_DIR}/automations.yaml`, content: '# seed\n[]\n' };
        const authelia = { path: `${HA_DIR}/configuration.yml`, content: 'rendered: true\n' };
        const seedOnly = new Set(['automations.yaml']);

        /** Agent whose `test -e` probe answers with `present`/`absent`. */
        function makeProbeAgent(exists: boolean) {
            return makeAgent((action, params) => {
                if (action === 'exec' && /test -e/.test(params?.command ?? '')) {
                    return { code: 0, stdout: exists ? 'sb-present\n' : 'sb-absent\n' };
                }
                if (action === 'exec') return { code: 0 };
                return 'ok';
            });
        }

        it('does not write a declared file that already exists on the node', async () => {
            const agent = makeProbeAgent(true);
            await writeExtraConfigFiles(agent, 'home-assistant', [automations], seedOnly);

            expect(agent.calls.filter(c => c.action === 'write_file')).toHaveLength(0);
            // Nothing about the deploy touches the target — not even the mkdir.
            expect(agent.calls.filter(c => /mkdir/.test(c.params?.command ?? ''))).toHaveLength(0);
        });

        it('seeds a declared file when it is absent (first install unchanged)', async () => {
            const agent = makeProbeAgent(false);
            await writeExtraConfigFiles(agent, 'home-assistant', [automations], seedOnly);

            const writes = agent.calls.filter(c => c.action === 'write_file');
            expect(writes).toHaveLength(1);
            expect(writes[0].params?.path).toBe(automations.path);
            expect(writes[0].params?.content).toBe(automations.content);
        });

        it('leaves undeclared files on the unconditional-write path', async () => {
            // The default must not change for every other config file: an
            // Authelia `configuration.yml` MUST be re-rendered every deploy.
            const agent = makeProbeAgent(true);
            await writeExtraConfigFiles(agent, 'home-assistant', [automations, authelia], seedOnly);

            const writes = agent.calls.filter(c => c.action === 'write_file');
            expect(writes).toHaveLength(1);
            expect(writes[0].params?.path).toBe(authelia.path);
            // And no existence probe was run for it.
            const probes = agent.calls.filter(c => /test -e/.test(c.params?.command ?? ''));
            expect(probes).toHaveLength(1);
            expect(probes[0].params?.command).toContain(automations.path);
        });

        it('matches on the file name, not on a path substring', async () => {
            // A same-named file under a different service must still resolve
            // by basename; a differently-named neighbour must not be caught.
            const other = { path: `${HA_DIR}/scenes.yaml`, content: '[]\n' };
            const agent = makeProbeAgent(true);
            await writeExtraConfigFiles(agent, 'home-assistant', [other], seedOnly);

            expect(agent.calls.filter(c => c.action === 'write_file')).toHaveLength(1);
        });

        it('does NOT write when the existence probe throws (fail closed)', async () => {
            // An unreachable/erroring probe must never be read as "absent" —
            // that is exactly the write that destroyed the automations.
            const agent = makeAgent((action, params) => {
                if (action === 'exec' && /test -e/.test(params?.command ?? '')) {
                    throw new Error('agent transport closed');
                }
                if (action === 'exec') return { code: 0 };
                return 'ok';
            });
            await expect(writeExtraConfigFiles(agent, 'home-assistant', [automations], seedOnly))
                .resolves.toBeUndefined();

            expect(agent.calls.filter(c => c.action === 'write_file')).toHaveLength(0);
        });

        it('does NOT write when the existence probe answers with something unexpected', async () => {
            const agent = makeAgent((action, params) => {
                if (action === 'exec' && /test -e/.test(params?.command ?? '')) {
                    return { code: 0, stdout: 'bash: test: command not found' };
                }
                if (action === 'exec') return { code: 0 };
                return 'ok';
            });
            await writeExtraConfigFiles(agent, 'home-assistant', [automations], seedOnly);

            expect(agent.calls.filter(c => c.action === 'write_file')).toHaveLength(0);
        });

        it('probes nothing at all when the template declares no seed-only files', async () => {
            const agent = makeProbeAgent(true);
            await writeExtraConfigFiles(agent, 'home-assistant', [automations]);

            expect(agent.calls.filter(c => /test -e/.test(c.params?.command ?? ''))).toHaveLength(0);
            expect(agent.calls.filter(c => c.action === 'write_file')).toHaveLength(1);
        });
    });

    it('still retries with sudo on a defensive non-ok return value (no throw)', async () => {
        // Belt-and-braces: if a future agent variant returns an error object
        // instead of rejecting, the sudo retry must still fire.
        const agent = makeAgent((action, params) => {
            if (action === 'exec') return { code: 0 };
            return params?.sudo ? 'ok' : { error: 'EACCES' };
        });

        await expect(writeExtraConfigFiles(agent, 'oscar-household', [file])).resolves.toBeUndefined();

        const writes = agent.calls.filter(c => c.action === 'write_file');
        expect(writes).toHaveLength(2);
        expect(writes[1].params?.sudo).toBe(true);
    });
});

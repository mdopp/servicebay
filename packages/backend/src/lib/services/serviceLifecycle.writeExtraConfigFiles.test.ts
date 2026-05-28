import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeExtraConfigFiles } from './serviceLifecycle';

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

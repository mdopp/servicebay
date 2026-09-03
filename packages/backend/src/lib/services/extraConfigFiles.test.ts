import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import path from 'path';
import { promises as fsp } from 'fs';
import {
    writeExtraConfigFiles,
    isPrunableDeliveryPath,
    selectStaleDeliveries,
    parseOwnerReference,
    ownershipRepairTargets,
} from './extraConfigFiles';

vi.mock('../logger', () => ({
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// #2703 — the delivered-files manifest lives under ServiceBay's own DATA_DIR.
// Point it at a scratch dir so each test starts with no record at all.
const { TEST_DATA_DIR } = vi.hoisted(() => ({
    // `vi.hoisted` runs before the imports, so no `path`/`os` here.
    TEST_DATA_DIR: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/sb-delivered-files-${process.pid}-${Date.now()}`,
}));
vi.mock('../dirs', () => ({
    DATA_DIR: TEST_DATA_DIR,
    HOST_DATA_DIR: TEST_DATA_DIR,
    SSH_DIR: path.join(TEST_DATA_DIR, 'ssh'),
    SERVICEBAY_BACKUP_DIR: path.join(TEST_DATA_DIR, 'backups'),
    getLocalSystemdDir: () => path.join(TEST_DATA_DIR, 'systemd'),
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

/**
 * Agent that forces the sudo write path and answers the #2717 ownership
 * probe with `ownerRef` — the nearest ancestor of the target dir that exists
 * and is NOT root-owned, which is what the probe reports from the box.
 *
 * `plainWriteFails` lists the paths whose unprivileged write rejects (the
 * EACCES a container-owned asset dir produces); everything else writes
 * plainly.
 */
function makeSudoWriteAgent(ownerRef: string, plainWriteFails: string[]) {
    return makeAgent((action, params) => {
        if (action === 'exec' && /sb-owner-ref/.test(params?.command ?? '')) {
            return { code: 0, stdout: `sb-owner-ref:${ownerRef}\n` };
        }
        if (action === 'exec') return { code: 0 };
        if (params?.sudo) return 'ok';
        if (plainWriteFails.includes(params?.path ?? '')) {
            throw new Error(`[Errno 13] Permission denied: '${params?.path}'`);
        }
        return 'ok';
    });
}

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
        // The dir itself already exists and is properly owned, so it IS the
        // ownership reference and only the file needs realigning.
        const dir = file.path.substring(0, file.path.lastIndexOf('/'));
        const agent = makeSudoWriteAgent(dir, [file.path]);

        await writeExtraConfigFiles(agent, 'oscar-household', [file]);

        const chowns = agent.calls.filter(c => c.action === 'exec' && /chown/.test(c.params?.command ?? ''));
        expect(chowns).toHaveLength(1);
        expect(chowns[0].params?.command).toBe(`sudo chown --reference='${dir}' -- '${file.path}'`);
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

    // ── #2717: the recurrence — the root-owned DIRECTORY ────────────────
    //
    // #1298's repair chowned the file `--reference=<its parent dir>`. When a
    // template adds a NEW skill directory, the agent's sudo `write_file`
    // creates that directory with `sudo mkdir -p` first, so the parent dir is
    // root-owned too and the reference resolves to root:root — a no-op chown.
    // Podman then failed to relabel the DIRECTORY, not the file:
    //   lsetxattr(...) .../skills/household/task-tool: operation not permitted
    describe('root-owned directory chain after a sudo write (#2717)', () => {
        const ASSETS = '/mnt/data/stacks/oscar-household/skills';
        const skill = { path: `${ASSETS}/task-tool/SKILL.md`, content: '# task tool' };

        const chownsOf = (agent: ReturnType<typeof makeAgent>) =>
            agent.calls.filter(c => c.action === 'exec' && /chown/.test(c.params?.command ?? ''));

        it('realigns the newly created directory, not only the file', async () => {
            const agent = makeSudoWriteAgent(ASSETS, [skill.path]);

            await writeExtraConfigFiles(agent, 'oscar-household', [skill]);

            const chowns = chownsOf(agent);
            expect(chowns).toHaveLength(1);
            expect(chowns[0].params?.command).toBe(
                `sudo chown --reference='${ASSETS}' -- '${ASSETS}/task-tool' '${skill.path}'`,
            );
        });

        it('never takes the root-owned parent dir as the ownership reference', async () => {
            // This is the exact regression: `--reference=<the new dir>` is
            // root:root, so the chown "succeeds" and changes nothing.
            const agent = makeSudoWriteAgent(ASSETS, [skill.path]);

            await writeExtraConfigFiles(agent, 'oscar-household', [skill]);

            const command = chownsOf(agent)[0].params?.command ?? '';
            expect(command).not.toContain(`--reference='${ASSETS}/task-tool'`);
            expect(command).toContain(`--reference='${ASSETS}'`);
        });

        it('heals a whole chain left root-owned by an earlier deploy', async () => {
            // The probe walks past every root-owned ancestor, so a directory
            // an older ServiceBay created as root is repaired on the next
            // deploy instead of being adopted as the reference.
            const nested = { path: `${ASSETS}/household/task-tool/SKILL.md`, content: '# task tool' };
            const agent = makeSudoWriteAgent(ASSETS, [nested.path]);

            await writeExtraConfigFiles(agent, 'oscar-household', [nested]);

            expect(chownsOf(agent)[0].params?.command).toBe(
                `sudo chown --reference='${ASSETS}' -- ` +
                `'${ASSETS}/household' '${ASSETS}/household/task-tool' '${nested.path}'`,
            );
        });

        it('probes the owner before creating the dir, in the mkdir round trip', async () => {
            // Probing after the mkdir would read back the root-owned dir the
            // sudo write is about to create — and it must not cost an extra
            // round trip per file either.
            const agent = makeSudoWriteAgent(ASSETS, [skill.path]);

            await writeExtraConfigFiles(agent, 'oscar-household', [skill]);

            const mkdirs = agent.calls.filter(c => c.action === 'exec' && /mkdir -p/.test(c.params?.command ?? ''));
            expect(mkdirs).toHaveLength(1);
            const command = mkdirs[0].params?.command ?? '';
            expect(command).toContain('sb-owner-ref');
            expect(command.indexOf('sb-owner-ref')).toBeLessThan(command.indexOf('mkdir -p'));
        });

        it('falls back to the file-only repair when the probe answers nothing usable', async () => {
            // No reference means no owner to adopt — repair what #1298 already
            // repaired rather than guessing, and never fail the deploy.
            const agent = makeAgent((action, params) => {
                if (action === 'exec') return { code: 0 };
                if (params?.sudo) return 'ok';
                throw new Error('[Errno 13] Permission denied');
            });

            await expect(writeExtraConfigFiles(agent, 'oscar-household', [skill])).resolves.toBeUndefined();

            expect(chownsOf(agent)[0].params?.command).toBe(
                `sudo chown --reference='${ASSETS}/task-tool' -- '${skill.path}'`,
            );
        });

        it('does not chown anything when the plain write succeeds', async () => {
            const agent = makeSudoWriteAgent(ASSETS, []);
            await writeExtraConfigFiles(agent, 'oscar-household', [skill]);
            expect(chownsOf(agent)).toHaveLength(0);
        });

        describe('parseOwnerReference', () => {
            it('reads the reference the probe printed', () => {
                expect(parseOwnerReference(`sb-owner-ref:${ASSETS}\n`, `${ASSETS}/task-tool`)).toBe(ASSETS);
            });

            it('declines a reference that is not an ancestor of the target dir', () => {
                expect(parseOwnerReference('sb-owner-ref:/mnt/data/stacks/other\n', `${ASSETS}/task-tool`)).toBeNull();
            });

            it('declines a reference too shallow to be inside a service tree', () => {
                // Walking up to /mnt or / means the repair left the service's
                // own tree — chowning a shared parent is not this fix's job.
                expect(parseOwnerReference('sb-owner-ref:/mnt\n', `${ASSETS}/task-tool`)).toBeNull();
                expect(parseOwnerReference('sb-owner-ref:/\n', `${ASSETS}/task-tool`)).toBeNull();
            });

            it('declines a missing, empty or garbled answer', () => {
                expect(parseOwnerReference(null, ASSETS)).toBeNull();
                expect(parseOwnerReference('', ASSETS)).toBeNull();
                expect(parseOwnerReference('stat: cannot stat\n', ASSETS)).toBeNull();
                expect(parseOwnerReference('sb-owner-ref:not/absolute\n', ASSETS)).toBeNull();
            });
        });

        describe('ownershipRepairTargets', () => {
            it('lists each created dir shallowest-first, then the file', () => {
                expect(ownershipRepairTargets(ASSETS, `${ASSETS}/a/b`, `${ASSETS}/a/b/f.md`))
                    .toEqual([`${ASSETS}/a`, `${ASSETS}/a/b`, `${ASSETS}/a/b/f.md`]);
            });

            it('repairs only the file when the dir already is the reference', () => {
                expect(ownershipRepairTargets(ASSETS, ASSETS, `${ASSETS}/f.md`)).toEqual([`${ASSETS}/f.md`]);
            });

            it('ignores a trailing slash on either path', () => {
                expect(ownershipRepairTargets(`${ASSETS}/`, `${ASSETS}/a/`, `${ASSETS}/a/f.md`))
                    .toEqual([`${ASSETS}/a`, `${ASSETS}/a/f.md`]);
            });

            it('repairs only the file when the reference is not an ancestor', () => {
                expect(ownershipRepairTargets('/mnt/data/stacks/other', `${ASSETS}/a`, `${ASSETS}/a/f.md`))
                    .toEqual([`${ASSETS}/a/f.md`]);
            });
        });
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

// ── #2703: deleting what a template stopped shipping ────────────────────
//
// The incident: two skills were retired in a template's source tree because
// they told the model to confirm a write it could not perform. They stayed
// on the box, kept declaring `/audit` and `/debug`, and went on lying —
// measured as two directories at mtime 2026-06-15 beside siblings the SAME
// deploy had rewritten at 2026-08-31. A template could not retract its own
// malfunction.
//
// The binding constraint on the fix: runtime-created files (a resident's
// notes, `solaris.db`, `.paperless-token`) live in those same directories.
// A pass that removes one of them is a FAILURE even if it removed every
// stale template file correctly. So the delete authority is a manifest of
// what this mechanism itself delivered — never a directory listing, and
// never an exclusion list that is incomplete again with every new runtime
// file.
describe('delivered-files manifest and prune pass (#2703)', () => {
    const STACK = '/mnt/data/stacks/solaris';
    const SKILLS = `${STACK}/skills/household`;

    const statusSkill = { path: `${SKILLS}/status/SKILL.md`, content: '# status\n' };
    const auditQuery = { path: `${SKILLS}/audit-query/SKILL.md`, content: '# audit\n' };
    const debugSet = { path: `${SKILLS}/debug-set/SKILL.md`, content: '# debug\n' };

    /** Real user data sitting in the very same directories. */
    const RUNTIME_FILES = [
        `${STACK}/solaris.db`,
        `${STACK}/.paperless-token`,
        `${SKILLS}/notes/anna.md`,
    ];

    /**
     * Agent whose box holds `onDisk` — delivered files AND the runtime
     * files beside them. Any directory listing an implementation might try
     * (`find`, `ls`) is answered truthfully, so a naive "delete everything
     * on disk that is not in the current source" implementation gets the
     * rope it needs and this suite goes red on it.
     */
    function makeBoxAgent(onDisk: string[], opts: { rmExit?: number } = {}) {
        return makeAgent((action, params) => {
            if (action === 'exec') {
                const cmd = params?.command ?? '';
                if (/^\s*(sudo\s+)?(find|ls)\b/.test(cmd)) {
                    return { code: 0, stdout: `${onDisk.join('\n')}\n` };
                }
                if (/\brm\b/.test(cmd)) return { code: opts.rmExit ?? 0 };
                return { code: 0 };
            }
            return 'ok';
        });
    }

    const complete = { nodeName: 'Local', completeDelivery: true };
    const rmCommands = (agent: { calls: Cmd[] }) =>
        agent.calls.filter(c => c.action === 'exec' && /\brm\b/.test(c.params?.command ?? ''))
            .map(c => c.params?.command ?? '');

    beforeEach(async () => {
        await fsp.rm(path.join(TEST_DATA_DIR, 'delivered-files'), { recursive: true, force: true });
    });
    afterAll(async () => {
        await fsp.rm(TEST_DATA_DIR, { recursive: true, force: true });
    });

    /** Deploy N — the full skill pack, recorded as delivered. */
    async function deployN(onDisk = [statusSkill.path, auditQuery.path, debugSet.path, ...RUNTIME_FILES]) {
        const agent = makeBoxAgent(onDisk);
        await writeExtraConfigFiles(agent, 'solaris', [statusSkill, auditQuery, debugSet], new Set(), complete);
        return agent;
    }

    it('deletes a file removed from the source tree between deploy N and N+1', async () => {
        await deployN();

        // `audit-query` and `debug-set` are gone from the template's tree.
        const agent = makeBoxAgent([statusSkill.path, auditQuery.path, debugSet.path, ...RUNTIME_FILES]);
        await writeExtraConfigFiles(agent, 'solaris', [statusSkill], new Set(), complete);

        const rms = rmCommands(agent);
        expect(rms.some(c => c.includes(auditQuery.path))).toBe(true);
        expect(rms.some(c => c.includes(debugSet.path))).toBe(true);
        expect(rms.some(c => c.includes(statusSkill.path))).toBe(false);
    });

    it('NEVER deletes a file that was never recorded as delivered, even though it is also absent from the source', async () => {
        // THE red-first case. `solaris.db`, `.paperless-token` and a
        // resident's note are on the box, in the delivered files' own
        // directories, and in no template source tree. A mirroring sync
        // eats all three; the manifest cannot even see them.
        await deployN();

        const agent = makeBoxAgent([statusSkill.path, auditQuery.path, debugSet.path, ...RUNTIME_FILES]);
        await writeExtraConfigFiles(agent, 'solaris', [statusSkill], new Set(), complete);

        const rms = rmCommands(agent);
        for (const runtimeFile of RUNTIME_FILES) {
            expect(rms.some(c => c.includes(runtimeFile))).toBe(false);
        }
        // And the reason it cannot see them: the pass never asks the box
        // what is in the directory. The manifest is the whole authority.
        const listings = agent.calls.filter(c =>
            c.action === 'exec' && /^\s*(sudo\s+)?(find|ls)\b/.test(c.params?.command ?? ''));
        expect(listings).toHaveLength(0);
    });

    it('deletes the stale tracked file and leaves the untracked runtime file beside it, in the same pass', async () => {
        // Mixed directory: `skills/household/` holds a retired skill AND a
        // resident's note. One pass, two different answers.
        await deployN();

        const agent = makeBoxAgent([statusSkill.path, auditQuery.path, debugSet.path, ...RUNTIME_FILES]);
        await writeExtraConfigFiles(agent, 'solaris', [statusSkill, debugSet], new Set(), complete);

        const rms = rmCommands(agent);
        expect(rms).toHaveLength(1);
        expect(rms[0]).toContain(auditQuery.path);
        expect(rms[0]).not.toContain(`${SKILLS}/notes/anna.md`);
    });

    it('deletes per path — never a directory-wide rm -rf or a --delete sync', async () => {
        await deployN();

        const agent = makeBoxAgent([statusSkill.path, auditQuery.path, debugSet.path, ...RUNTIME_FILES]);
        await writeExtraConfigFiles(agent, 'solaris', [statusSkill], new Set(), complete);

        const rms = rmCommands(agent);
        expect(rms).toHaveLength(2);
        for (const cmd of rms) {
            expect(cmd).toMatch(/^rm -f -- '\/mnt\/data\/stacks\/solaris\/skills\/household\/[^']+'$/);
        }
        const everyExec = agent.calls.filter(c => c.action === 'exec').map(c => c.params?.command ?? '');
        // Flags as whole words: `--reference=` (the #2717 ownership repair)
        // contains the letters of `-r` without being a recursive flag.
        expect(everyExec.some(c => /(^|\s)(-r|-R|--recursive|--delete)(\s|$)|rsync/.test(c))).toBe(false);
        // Above all: no command names a bare directory as its target.
        expect(everyExec.some(c => /\brm\b[^|]*(skills|household)'?\s*$/.test(c) && !c.includes('SKILL.md'))).toBe(false);
    });

    it('deletes nothing on the first deploy after this ships — no manifest means no delete authority', async () => {
        // An existing install has files on disk that no manifest records.
        // Reading that as "everything not in the source was delivered" is
        // `--delete` wearing a different hat; it would take `solaris.db`.
        // The bootstrap deploy therefore only records.
        const agent = makeBoxAgent([statusSkill.path, auditQuery.path, debugSet.path, ...RUNTIME_FILES]);
        await writeExtraConfigFiles(agent, 'solaris', [statusSkill], new Set(), complete);

        expect(rmCommands(agent)).toHaveLength(0);

        // From here on it converges: the next deploy can prune what THIS
        // one recorded.
        const next = makeBoxAgent([statusSkill.path, ...RUNTIME_FILES]);
        await writeExtraConfigFiles(next, 'solaris', [], new Set(), complete);
        // (nothing to delete — an empty delivery is refused, see below)
        expect(rmCommands(next)).toHaveLength(0);
    });

    it('refuses to empty a non-empty manifest on a delivery that carries no files at all', async () => {
        // Template resolution degrades to `[]` on error, so "delivers
        // nothing" is far more often a failed registry read than a real
        // removal of everything.
        await deployN();

        const agent = makeBoxAgent([statusSkill.path, auditQuery.path, debugSet.path, ...RUNTIME_FILES]);
        await writeExtraConfigFiles(agent, 'solaris', [], new Set(), complete);

        expect(rmCommands(agent)).toHaveLength(0);

        // …and the record is kept, so a later real deploy still prunes.
        const later = makeBoxAgent([statusSkill.path, auditQuery.path, debugSet.path, ...RUNTIME_FILES]);
        await writeExtraConfigFiles(later, 'solaris', [statusSkill, debugSet], new Set(), complete);
        expect(rmCommands(later).some(c => c.includes(auditQuery.path))).toBe(true);
    });

    it('never records a seed-only file, so dropping its declaration cannot delete the operator content', async () => {
        // #2590's files belong to the application/operator from first
        // install onward. They are delivered by this transport but are not
        // ITS content, so they never enter the manifest.
        const HA = '/mnt/data/stacks/home-assistant/homeassistant';
        const automations = { path: `${HA}/automations.yaml`, content: '# seed\n[]\n' };
        const configuration = { path: `${HA}/configuration.yml`, content: 'rendered: true\n' };
        const seedOnly = new Set(['automations.yaml']);

        const first = makeAgent((action, params) => {
            if (action === 'exec' && /test -e/.test(params?.command ?? '')) return { code: 0, stdout: 'sb-absent\n' };
            if (action === 'exec') return { code: 0 };
            return 'ok';
        });
        await writeExtraConfigFiles(first, 'home-assistant', [automations, configuration], seedOnly,
            { nodeName: 'Local', completeDelivery: true });

        // The template stops declaring automations.yaml entirely.
        const second = makeBoxAgent([automations.path, configuration.path]);
        await writeExtraConfigFiles(second, 'home-assistant', [configuration], new Set(),
            { nodeName: 'Local', completeDelivery: true });

        expect(rmCommands(second).some(c => c.includes(automations.path))).toBe(false);
    });

    it('prunes nothing for a caller that did not claim a complete delivery', async () => {
        // `update_service_yaml` passes no files; a hand-rolled
        // `deploy_service` may pass one config file for a template that
        // also ships a skills tree. Reading either as "everything that
        // still exists" would delete the rest.
        await deployN();

        const agent = makeBoxAgent([statusSkill.path, auditQuery.path, debugSet.path, ...RUNTIME_FILES]);
        await writeExtraConfigFiles(agent, 'solaris', [statusSkill]);

        expect(rmCommands(agent)).toHaveLength(0);
    });

    it('keeps a path it could not delete in the manifest and retries it next deploy', async () => {
        await deployN();

        const failing = makeBoxAgent([statusSkill.path, auditQuery.path, debugSet.path], { rmExit: 1 });
        await writeExtraConfigFiles(failing, 'solaris', [statusSkill, debugSet], new Set(), complete);
        // plain rm, then the sudo retry (#1171 asset dirs owned by a subuid)
        expect(rmCommands(failing)).toEqual([
            `rm -f -- '${auditQuery.path}'`,
            `sudo rm -f -- '${auditQuery.path}'`,
        ]);

        const retry = makeBoxAgent([statusSkill.path, auditQuery.path, debugSet.path]);
        await writeExtraConfigFiles(retry, 'solaris', [statusSkill, debugSet], new Set(), complete);
        expect(rmCommands(retry).some(c => c.includes(auditQuery.path))).toBe(true);
    });

    it('does not record anything when a write failed — a partial delivery is not a complete one', async () => {
        await deployN();

        const failWrites = makeAgent((action, params) => {
            if (action === 'exec') return { code: 0 };
            if (params?.path === statusSkill.path) throw new Error('EACCES');
            return 'ok';
        });
        await expect(
            writeExtraConfigFiles(failWrites, 'solaris', [statusSkill], new Set(), complete),
        ).rejects.toThrow(/Failed to write/);
        expect(rmCommands(failWrites)).toHaveLength(0);

        // The earlier record survived untouched, so the next good deploy
        // still knows what was delivered.
        const good = makeBoxAgent([statusSkill.path, auditQuery.path, debugSet.path]);
        await writeExtraConfigFiles(good, 'solaris', [statusSkill, debugSet], new Set(), complete);
        expect(rmCommands(good)).toEqual([`rm -f -- '${auditQuery.path}'`]);
    });

    describe('the delete-target rule', () => {
        it('accepts only absolute, metacharacter-free paths at least three segments deep', () => {
            expect(isPrunableDeliveryPath(`${SKILLS}/audit-query/SKILL.md`)).toBe(true);
            expect(isPrunableDeliveryPath('/etc/passwd')).toBe(false);       // too shallow
            expect(isPrunableDeliveryPath('skills/x/SKILL.md')).toBe(false); // relative
            expect(isPrunableDeliveryPath('/a/b/../../etc/shadow')).toBe(false);
            expect(isPrunableDeliveryPath('/a/b/c; rm -rf /')).toBe(false);
            expect(isPrunableDeliveryPath('/a/b/$(whoami)')).toBe(false);
            expect(isPrunableDeliveryPath(42)).toBe(false);
        });

        it('makes a path absent from the prior manifest structurally undeletable', () => {
            const prior = [`${SKILLS}/audit-query/SKILL.md`];
            const { deletable } = selectStaleDeliveries(prior, new Set<string>());
            expect(deletable).toEqual(prior);
            // Every runtime file: never recorded, therefore never a candidate.
            for (const runtimeFile of RUNTIME_FILES) {
                expect(selectStaleDeliveries([], new Set()).deletable).not.toContain(runtimeFile);
            }
        });

        it('reports rather than deletes a recorded path that is not a valid target', () => {
            const { deletable, refused } = selectStaleDeliveries(['/etc/passwd'], new Set<string>());
            expect(deletable).toEqual([]);
            expect(refused).toEqual(['/etc/passwd']);
        });
    });
});

/**
 * The class-level gate for #2920 + #2921.
 *
 * Both bugs were the same house failure form — a success line emitted for work
 * that was never measured to have happened ("Erfolg gemeldet, nichts getan").
 * The two point fixes are pinned by their own tests next to the code they fix.
 * THIS file gates the *class*, in the two restore regions where a false success
 * is worst (the operator believes the snapshot is spent):
 *
 *   - `systemBackup.ts` → `restoreSystemBackupSelection`'s service-config loop
 *   - `externalBackup/restore.ts` → `wipeServiceForReinstall`'s wipe branches
 *
 * It works on two axes, because neither alone catches the class:
 *
 *  1. **Behavioural** (`describe('behaviour: …')`): every success/count emission
 *     is cross-checked against ground truth measured off a real temp
 *     filesystem, over a MATRIX of inputs — not a single happy case. The
 *     invariant asserted is `success reported ⟺ effect observed on disk`, and
 *     `count reported === paths actually gone`. A branch that reports without
 *     doing fails here as soon as the matrix reaches it.
 *
 *  2. **Structural** (`describe('inventory: …')`): the success emissions in
 *     those two regions are ENUMERATED out of the source and checked against a
 *     registry that names, for each one, the measurement it must be derived
 *     from. A NEW emission added later is not in the registry → the test fails
 *     and the author has to name the check that gates it (which the test then
 *     requires to exist, ahead of the emission). This is what makes the gate
 *     survive a branch the behavioural matrix does not happen to reach.
 *
 * What axis 2 does NOT prove: that the named guard *dominates* the emission in
 * the control-flow graph — it is a textual ordering check, not an AST/CFG
 * analysis. Axis 1 is what proves the gating for the branches it reaches. The
 * pair is deliberate; neither is presented as the other.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Executor } from './executor';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const { mockCfg, mockGetExecutor, mockLogger, mockNas } = vi.hoisted(() => ({
    mockCfg: { getConfig: vi.fn(), updateConfig: vi.fn(async () => ({})), saveConfig: vi.fn() },
    mockGetExecutor: vi.fn(),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockNas: { nasUpload: vi.fn(), nasDownload: vi.fn(), nasList: vi.fn(), nasRemove: vi.fn() },
}));
vi.mock('./config', () => mockCfg);
vi.mock('./logger', () => ({ logger: mockLogger }));
vi.mock('./executor', async importOriginal => ({
    ...(await importOriginal<typeof import('./executor')>()),
    getExecutor: (...a: unknown[]) => mockGetExecutor(...a),
}));
vi.mock('./externalBackup/nasClient', () => ({
    ...mockNas,
    withNasSession: vi.fn(),
    isConnectionLevelError: () => false,
}));

import { restoreSystemBackupSelection } from './systemBackup';
import { wipeServiceForReinstall } from './externalBackup/restore';

const SERVICE = 'home-assistant';
/** The manifest's `dataSubdir` — the restore target is DATA_DIR + this. */
const HA_SUBDIR = path.join('home-assistant', 'homeassistant');

let tmpRoot: string;

beforeEach(async () => {
    vi.clearAllMocks();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-claims-'));
    mockCfg.getConfig.mockResolvedValue({ templateSettings: { DATA_DIR: tmpRoot }, installedTemplates: {} });
});
afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Axis 1a — the System-Snapshot service-config restore loop
// ---------------------------------------------------------------------------

/**
 * A host executor backed by a real temp dir, so `mkdir`/`tar` actually move
 * bytes and "did the restore land?" is a filesystem question, not a mock
 * assertion. It REFUSES a non-absolute extraction target — the #2920 bug was
 * precisely that `tar -C home-assistant` succeeded against the agent's own cwd,
 * so a relative dest reaching the agent at all is a failure of this suite.
 */
function fakeHostExecutor(): Executor {
    const files = new Map<string, string>();
    const assertAbsolute = (target: string) => {
        if (!path.isAbsolute(target)) {
            throw new Error(`agent received a NON-ABSOLUTE path "${target}" — this is the #2920 bug`);
        }
    };
    const exec: Partial<Executor> = {
        writeFile: vi.fn(async (p: string, content: string) => { files.set(p, content); }),
        exec: vi.fn(async (command: string) => {
            const parts = command.split(' ');
            const b64Path = parts[parts.length - 2];
            const outPath = parts[parts.length - 1];
            await fs.writeFile(outPath, Buffer.from(files.get(b64Path) ?? '', 'base64'));
            return { stdout: '', stderr: '' };
        }),
        execSafe: vi.fn(async (argv: string[]) => {
            const [cmd, ...rest] = argv;
            if (cmd === 'mktemp') {
                return { stdout: path.join(tmpRoot, `mktemp-${Math.random().toString(36).slice(2)}`) + '\n', stderr: '', code: 0 };
            }
            if (cmd === 'mkdir') {
                assertAbsolute(rest[rest.length - 1]);
                await fs.mkdir(rest[rest.length - 1], { recursive: true });
                return { stdout: '', stderr: '', code: 0 };
            }
            if (cmd === 'tar') {
                const dest = argv[argv.indexOf('-C') + 1];
                assertAbsolute(dest);
                await execFileAsync('tar', ['-xf', argv[argv.indexOf('-xf') + 1], '-C', dest, '--no-same-owner']);
                return { stdout: '', stderr: '', code: 0 };
            }
            if (cmd === 'readlink') {
                const target = rest[rest.length - 1];
                return { stdout: (await fs.realpath(target).catch(() => target)) + '\n', stderr: '', code: 0 };
            }
            if (cmd === 'find') return { stdout: '', stderr: '', code: 0 };
            if (cmd === 'rm') {
                for (const a of rest) if (a.startsWith('/')) await fs.rm(a, { recursive: true, force: true }).catch(() => {});
                return { stdout: '', stderr: '', code: 0 };
            }
            return { stdout: '', stderr: '', code: 0 };
        }),
    };
    return exec as Executor;
}

/** Build a system-snapshot archive carrying one service-config tree + metadata. */
async function buildSnapshot(sourcePath: string): Promise<string> {
    const stage = await fs.mkdtemp(path.join(tmpRoot, 'snap-'));
    const svcDir = path.join(stage, 'service-config', SERVICE);
    await fs.mkdir(svcDir, { recursive: true });
    await fs.writeFile(path.join(svcDir, 'configuration.yaml'), 'default_config:');
    await fs.writeFile(
        path.join(stage, 'metadata.json'),
        JSON.stringify({
            version: 3, createdAt: '', nodes: [], configFiles: [],
            serviceData: [{ label: SERVICE, service: SERVICE, sourcePath, nodeName: 'Local' }],
        }),
    );
    const archive = path.join(tmpRoot, `snapshot-${Math.random().toString(36).slice(2)}.tar.gz`);
    await execFileAsync('tar', ['-czf', archive, '-C', stage, '.']);
    return archive;
}

/** Did the loop claim a restore? (the operator-visible success line) */
const claimedRestore = () =>
    mockLogger.info.mock.calls.some(([, msg]) => typeof msg === 'string' && msg.startsWith('Restored '));

describe('behaviour: the service-config restore loop never claims a restore it did not make (#2920)', () => {
    /**
     * The matrix. `dataDirIsAbsolute: false` models the only way the re-resolve
     * fallback can still hand back a non-absolute dir — a relative DATA_DIR —
     * which is what drives the refusal branch end to end.
     */
    const CASES = [
        { name: 'an absolute recorded sourcePath', recorded: (abs: string) => abs, dataDirIsAbsolute: true, expectRestore: true },
        { name: 'the bare service name (the shipped #2920 value)', recorded: () => SERVICE, dataDirIsAbsolute: true, expectRestore: true },
        { name: 'a relative nested sourcePath', recorded: () => 'stacks/home-assistant', dataDirIsAbsolute: true, expectRestore: true },
        { name: 'an empty sourcePath', recorded: () => '', dataDirIsAbsolute: true, expectRestore: true },
        { name: 'a bare name that cannot be re-resolved to an absolute dir', recorded: () => SERVICE, dataDirIsAbsolute: false, expectRestore: false },
        { name: 'an empty sourcePath that cannot be re-resolved to an absolute dir', recorded: () => '', dataDirIsAbsolute: false, expectRestore: false },
    ];

    for (const c of CASES) {
        it(`${c.expectRestore ? 'restores and reports' : 'refuses and stays silent'} — ${c.name}`, async () => {
            const dataDir = c.dataDirIsAbsolute ? tmpRoot : path.join('relative-stacks', path.basename(tmpRoot));
            mockCfg.getConfig.mockResolvedValue({ templateSettings: { DATA_DIR: dataDir }, installedTemplates: {} });
            mockGetExecutor.mockReturnValue(fakeHostExecutor());
            const archive = await buildSnapshot(c.recorded(path.join(tmpRoot, HA_SUBDIR)));

            const run = restoreSystemBackupSelection(archive, { config: {}, nodeFiles: [], serviceData: [SERVICE] });
            if (c.expectRestore) await run; else await expect(run).rejects.toThrow(/NOT restored/);

            // Ground truth: did the config actually land in the service's dir?
            const landed = await fs
                .readFile(path.join(tmpRoot, HA_SUBDIR, 'configuration.yaml'), 'utf8')
                .then(() => true, () => false);

            // THE class invariant: the success line and the observed effect agree.
            expect(claimedRestore()).toBe(landed);
            expect(landed).toBe(c.expectRestore);

            if (!c.expectRestore) {
                // A refusal is loud, and nothing was written anywhere relative.
                expect(mockLogger.error.mock.calls.some(([, m]) => /refusing to extract/.test(String(m)))).toBe(true);
                await expect(fs.access(path.join(process.cwd(), 'relative-stacks'))).rejects.toThrow();
            }
        });
    }
});

// ---------------------------------------------------------------------------
// Axis 1b — the wipe branch
// ---------------------------------------------------------------------------

describe('behaviour: wipe-config reports the paths it removed, measured off disk (#2921)', () => {
    /** Seed a data dir and return the set of relative file paths written. */
    async function seed(dir: string, files: string[]): Promise<string[]> {
        for (const rel of files) {
            await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
            await fs.writeFile(path.join(dir, rel), 'x');
        }
        return files;
    }
    async function listFiles(dir: string, base = dir): Promise<string[]> {
        const out: string[] = [];
        for (const ent of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) out.push(...(await listFiles(full, base)));
            else out.push(path.relative(base, full));
        }
        return out.sort();
    }

    /**
     * A matrix of on-disk states, from "nothing the manifest names exists" to
     * "every class of include exists". For EVERY one the reported count must
     * equal the number of paths that actually disappeared — the property the
     * old `removed += 1` per iteration could not hold.
     */
    const STATES: Array<{ name: string; files: string[] }> = [
        { name: 'an empty data dir', files: [] },
        { name: 'only DATA on disk', files: ['home-assistant_v2.db'] },
        { name: 'one plain include', files: ['configuration.yaml', 'home-assistant_v2.db'] },
        { name: 'only glob-matched leaves', files: ['.storage/lovelace.overview', '.storage/hacs.repositories'] },
        {
            name: 'plain + glob + non-matching neighbours',
            files: [
                'configuration.yaml', 'automations.yaml',
                '.storage/core.entity_registry', '.storage/lovelace.overview', '.storage/lovelace.energy',
                '.storage/hacs.repositories', '.storage/core.restore_state', '.storage/auth',
                'home-assistant_v2.db',
            ],
        },
    ];

    for (const state of STATES) {
        it(`reported count === measured removals — ${state.name}`, async () => {
            const dataDir = path.join(tmpRoot, HA_SUBDIR);
            await fs.mkdir(dataDir, { recursive: true });
            await seed(dataDir, state.files);
            const before = await listFiles(dataDir);

            const logs: string[] = [];
            await wipeServiceForReinstall(SERVICE, { wipeMode: 'wipe-config', node: 'Local', local: true }, async l => { logs.push(l); });
            const after = await listFiles(dataDir);

            const line = logs.find(l => l.includes('wipe-config')) ?? '';
            const reported = Number(/cleared (\d+) config path\(s\)/.exec(line)?.[1] ?? NaN);
            const removed = before.filter(f => !after.includes(f));

            // Every seeded file here is a leaf, so "paths removed" == "files gone".
            expect(reported).toBe(removed.length);
            // A count of zero is never dressed up as a success: the entries that
            // matched nothing are named, always.
            if (reported === 0) expect(line).toMatch(/pattern\(s\) matched nothing/);
        });
    }

    it('wipe-all only claims the dir is cleared when it observably is', async () => {
        const dataDir = path.join(tmpRoot, HA_SUBDIR);
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(path.join(dataDir, 'configuration.yaml'), 'cfg');
        const logs: string[] = [];
        await wipeServiceForReinstall(SERVICE, { wipeMode: 'wipe-all', node: 'Local', local: true }, async l => { logs.push(l); });
        const gone = await fs.access(dataDir).then(() => false, () => true);
        expect(logs.some(l => l.includes('wipe-all —'))).toBe(gone);
    });
});

// ---------------------------------------------------------------------------
// Axis 2 — the emission inventory
// ---------------------------------------------------------------------------

/** Slice a top-level function body out of a source file, `}` at column 0 ends it. */
function regionOf(source: string, signature: string): string {
    const start = source.indexOf(signature);
    if (start < 0) throw new Error(`region "${signature}" not found — the inventory is stale`);
    // `}` at column 0, either mid-file or as the last byte (no trailing newline).
    const close = /\n\}(?=\n|$)/g;
    close.lastIndex = start;
    const m = close.exec(source);
    if (!m) throw new Error(`region "${signature}" has no closing brace at column 0`);
    return source.slice(start, m.index);
}

/** Words that make a log line read as "the work happened". Deliberately broad:
 *  the point is to catch a NEW claim, not only today's wording. It does not
 *  match the `(note) … skipped / did NOT clear …` lines, which claim nothing. */
const SUCCESS_VOCAB = /\b(restored|cleared|captured|wiped|purged|removed|succeeded|complete|completed|done)\b/i;
/** `(note)` is this subsystem's established prefix for "here is what did NOT
 *  happen" — a line that opens with it is a non-claim by construction. */
const NON_CLAIM = /`\(note\) /;
/** Every `logger.info(...)` / `await log(...)` success CLAIM in a region. */
function emissionsIn(region: string): Array<{ text: string; index: number }> {
    const out: Array<{ text: string; index: number }> = [];
    const re = /(?:logger\.info|await log)\(([\s\S]{0,600}?)\);/g;
    for (let m = re.exec(region); m; m = re.exec(region)) {
        if (NON_CLAIM.test(m[1])) continue;
        if (SUCCESS_VOCAB.test(m[1])) out.push({ text: m[1], index: m.index });
    }
    return out;
}

/**
 * The registry. One entry per success/count emission in the two restore
 * regions. `derivedFrom` names the MEASUREMENT the claim rests on — an
 * existence/removal check or a validated absolute target — and the test
 * requires each to appear in the region ahead of the emission.
 *
 * Adding a branch that logs success without registering it here fails the
 * "no unregistered emission" assertion below. That is the point of the file.
 */
const REGISTRY: Array<{
    id: string;
    file: 'systemBackup.ts' | 'externalBackup/restore.ts';
    signature: string;
    emission: RegExp;
    /** Measurements that must live in the emission's OWN region, ahead of it. */
    derivedFrom: RegExp[];
    /** …or in a helper the region demonstrably calls before emitting. */
    via?: { signature: string; call: RegExp; checks: RegExp[] };
}> = [
    {
        id: 'restore-loop: "Restored <x> to <node>:<path>"',
        file: 'systemBackup.ts',
        signature: 'export async function restoreSystemBackupSelection(',
        emission: /Restored \$\{fileDesc\} to \$\{targetNodeName\}:\$\{targetPath\}/,
        derivedFrom: [
            // The target is validated absolute, and a failure to validate it
            // leaves the loop instead of falling through to the log line.
            /if \(!targetPath \|\| !path\.isAbsolute\(targetPath\)\)/,
            /refused\.push\(detail\)/,
            /continue;/,
            // The extraction itself is the effect being claimed; it throws on
            // failure rather than returning a status the log ignores.
            /await extractServiceConfigToNode\(/,
        ],
    },
    {
        id: 'wipe-all: "cleared the service data dir"',
        file: 'externalBackup/restore.ts',
        signature: 'export async function wipeServiceForReinstall(',
        emission: /wipe-all — cleared the service data dir/,
        derivedFrom: [/if \(!\(await backend\.isFreshDir\(dataDir\)\)\)/],
    },
    {
        id: 'wipe-config: "cleared N config path(s)"',
        file: 'externalBackup/restore.ts',
        signature: 'export async function wipeServiceForReinstall(',
        emission: /wipe-config — cleared \$\{removed\} config path\(s\)/,
        derivedFrom: [],
        via: {
            signature: 'async function clearManifestConfigPaths(',
            call: /await clearManifestConfigPaths\(backend, dataDir, manifest\.include\)/,
            checks: [
                // Expanded through the SAME expander the backup walk uses …
                /await resolveIncludeGlob\(backend, dataDir, include\)/,
                // … existed before …
                /if \(!\(await backend\.exists\(abs\)\)\) continue;/,
                // … and is gone after. Only then is it counted.
                /if \(await backend\.exists\(abs\)\) continue;/,
                /removed \+= 1;/,
            ],
        },
    },
];

describe('inventory: every success claim in the restore paths is registered against a measurement', () => {
    const SOURCES = new Map<string, string>();
    beforeEach(async () => {
        for (const rel of ['systemBackup.ts', 'externalBackup/restore.ts']) {
            if (!SOURCES.has(rel)) SOURCES.set(rel, await fs.readFile(path.join(HERE, rel), 'utf8'));
        }
    });

    it('finds no success emission that is not in the registry', () => {
        const regions = new Map<string, string>();
        for (const entry of REGISTRY) {
            regions.set(entry.signature, regionOf(SOURCES.get(entry.file)!, entry.signature));
            // A measurement helper must not quietly become a second claim site.
            if (entry.via) regions.set(entry.via.signature, regionOf(SOURCES.get(entry.file)!, entry.via.signature));
        }
        const unregistered: string[] = [];
        for (const [signature, region] of regions) {
            for (const emission of emissionsIn(region)) {
                const known = REGISTRY.some(e => e.signature === signature && e.emission.test(emission.text));
                if (!known) unregistered.push(`${signature} → ${emission.text.trim().slice(0, 120)}`);
            }
        }
        expect(
            unregistered,
            'A success/count line was added to a restore path without registering the measurement it is ' +
            'derived from. Add it to REGISTRY in restoreSuccessClaims.test.ts, naming the existence / ' +
            'removal / absolute-target check that gates it — or stop claiming success there.',
        ).toEqual([]);
    });

    it('every registered emission is present, and its measurement precedes it', () => {
        for (const entry of REGISTRY) {
            const region = regionOf(SOURCES.get(entry.file)!, entry.signature);
            const found = emissionsIn(region).find(e => entry.emission.test(e.text));
            expect(found, `${entry.id}: emission no longer found — the registry is stale`).toBeTruthy();
            for (const guard of entry.derivedFrom) {
                const at = region.search(guard);
                expect(at, `${entry.id}: measurement ${guard} is missing from the region`).toBeGreaterThanOrEqual(0);
                expect(at, `${entry.id}: measurement ${guard} does not precede the success line`)
                    .toBeLessThan(found!.index);
            }
            if (entry.via) {
                // The claim rests on a helper: the region must CALL it before
                // emitting, and the helper must carry the measurements.
                const callAt = region.search(entry.via.call);
                expect(callAt, `${entry.id}: the region never calls ${entry.via.signature}`).toBeGreaterThanOrEqual(0);
                expect(callAt, `${entry.id}: the measurement call does not precede the success line`)
                    .toBeLessThan(found!.index);
                const helper = regionOf(SOURCES.get(entry.file)!, entry.via.signature);
                for (const check of entry.via.checks) {
                    expect(helper, `${entry.id}: ${entry.via.signature} is missing ${check}`).toMatch(check);
                }
            }
        }
    });

    it('registers at least one emission per guarded region (the regions are still the right ones)', () => {
        const signatures = new Set(REGISTRY.map(e => e.signature));
        expect(signatures.size).toBe(2);
        // …and no entry may claim success with NO measurement at all.
        for (const e of REGISTRY) expect(e.derivedFrom.length + (e.via?.checks.length ?? 0)).toBeGreaterThan(0);
        for (const sig of signatures) expect(REGISTRY.some(e => e.signature === sig)).toBe(true);
    });
});

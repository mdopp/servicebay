/**
 * The trash bucket's *location* and *quoting* (#2859, #2862, #2863).
 *
 * Three defects met in one delete and are pinned here together:
 *
 *  - #2859 — the trash path was single-quoted with a literal `~`, so the shell
 *    made a directory called `~` under the agent's cwd. Every soft-delete since
 *    was unrecoverable. → no emitted command may carry a quoted tilde.
 *  - #2862 — putting the trash where the path *said* lands it inside the Quadlet
 *    scan directory, which the generator reads recursively: deleted services come
 *    back as units wired to `default.target`. A filesystem-only assertion cannot
 *    see this (the file WAS moved correctly), so {@link FakeBox} models the
 *    generator — `systemctl --user list-units` is derived from a recursive scan
 *    of `containers/systemd/`, and the control test below proves that model has
 *    teeth. The real check runs on the box (`list_system_services`) at verify.
 *  - #2863 — the `installedTemplates` record must travel with the files.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HOME = '/var/home/core';
const CWD = '/agent-cwd';
const SCAN = `${HOME}/.config/containers/systemd`;
const TRASH = `${HOME}/.config/containers/systemd-trash`;
const LEGACY_IN_SCAN = `${SCAN}/.trash`;
const LEGACY_TILDE = `${CWD}/~/.config/containers/systemd/.trash`;

// ── a very small box: a file tree, a `sh`-ish command handler, and the
//    Quadlet generator's recursive view of the scan directory ──────────────
class FakeBox {
    files = new Map<string, string>();
    dirs = new Set<string>([HOME, SCAN, CWD]);
    commands: string[] = [];

    mkdir(p: string) {
        const parts = p.split('/').filter(Boolean);
        for (let i = 1; i <= parts.length; i++) this.dirs.add('/' + parts.slice(0, i).join('/'));
    }
    write(p: string, content: string) {
        this.mkdir(p.split('/').slice(0, -1).join('/'));
        this.files.set(p, content);
    }
    exists(p: string) { return this.files.has(p) || this.dirs.has(p); }
    children(p: string): string[] {
        const out = new Set<string>();
        for (const path of [...this.files.keys(), ...this.dirs]) {
            if (!path.startsWith(`${p}/`)) continue;
            out.add(path.slice(p.length + 1).split('/')[0]);
        }
        return [...out].sort();
    }
    move(src: string, dstRaw: string) {
        const dst = dstRaw.endsWith('/') ? dstRaw + src.split('/').pop() : dstRaw;
        if (this.files.has(src)) {
            this.write(dst, this.files.get(src)!);
            this.files.delete(src);
            return true;
        }
        if (this.dirs.has(src)) {
            for (const [p, c] of [...this.files]) {
                if (p === src || p.startsWith(`${src}/`)) {
                    this.write(dst + p.slice(src.length), c);
                    this.files.delete(p);
                }
            }
            for (const d of [...this.dirs]) if (d === src || d.startsWith(`${src}/`)) this.dirs.delete(d);
            this.mkdir(dst);
            return true;
        }
        return false;
    }
    remove(p: string) {
        for (const f of [...this.files.keys()]) if (f === p || f.startsWith(`${p}/`)) this.files.delete(f);
        for (const d of [...this.dirs]) if (d === p || d.startsWith(`${p}/`)) this.dirs.delete(d);
    }

    /** The Quadlet generator: a RECURSIVE scan of `containers/systemd/`. This is
     *  the whole of #2862 — a `.kube` parked in a subdirectory still generates a
     *  unit. */
    listUnits(): string[] {
        const units = new Set<string>();
        for (const p of this.files.keys()) {
            if (!p.startsWith(`${SCAN}/`)) continue;
            const base = p.split('/').pop()!;
            if (base.endsWith('.kube') || base.endsWith('.container')) {
                units.add(`${base.replace(/\.(kube|container)$/, '')}.service`);
            }
        }
        return [...units].sort();
    }

    private resolve(arg: string): string {
        const bare = arg.replace(/^"|"$/g, '');
        const expanded = bare.replace('$HOME', HOME);
        return expanded.startsWith('/') ? expanded : `${CWD}/${expanded.replace(/^\.\//, '')}`;
    }

    exec(command: string): { code: number; stdout: string; stderr: string } {
        this.commands.push(command);
        const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

        // The legacy-trash sweep, emulated by its contract (the script's real
        // shell semantics are box-verify's job).
        if (command.includes('SERVICEBAY_TRASH_MIGRATED')) {
            let moved = 0;
            for (const src of [LEGACY_IN_SCAN, LEGACY_TILDE]) {
                if (!this.dirs.has(src)) continue;
                for (const entry of this.children(src)) {
                    let target = `${TRASH}/${entry}`;
                    if (this.exists(target)) target += '-dup1';
                    this.move(`${src}/${entry}`, target);
                    moved++;
                }
                this.dirs.delete(src);
            }
            this.mkdir(TRASH);
            return ok(`SERVICEBAY_TRASH_MIGRATED=${moved}\n`);
        }

        const printf = /^printf '%s' (.+) > ("[^"]+")$/.exec(command.trim());
        if (printf) {
            this.write(this.resolve(printf[2]), JSON.parse(printf[1]));
            return ok();
        }

        const args = (command.match(/"[^"]*"/g) ?? []).map(a => this.resolve(a));
        if (/^mkdir -p /.test(command)) { this.mkdir(args[0]); return ok(); }
        if (/^mv -f /.test(command)) {
            // `resolve` keeps a trailing slash, which `move` reads as "into
            // this directory" — the same thing `mv` does.
            this.move(args[0], args[1]);
            return ok();
        }
        if (/^rm -rf /.test(command)) { this.remove(args[0]); return ok(); }
        if (/^cat /.test(command)) {
            const content = this.files.get(args[0]);
            return content === undefined ? { code: 1, stdout: '', stderr: 'no such file' } : ok(content);
        }
        if (/^ls -1 /.test(command)) {
            if (!this.dirs.has(args[0])) return { code: 1, stdout: '', stderr: 'no such directory' };
            return ok(this.children(args[0]).join('\n') + '\n');
        }
        if (/systemctl --user list-units/.test(command)) return ok(this.listUnits().join('\n') + '\n');
        return ok();
    }
}

let box: FakeBox;
let config: { installedTemplates?: Record<string, { schemaVersion: number; installedAt: string }> };

const sendCommand = vi.fn(async (action: string, params: unknown) => {
    if (action !== 'exec') return 'ok';
    return box.exec((params as { command?: string })?.command ?? '');
});
vi.mock('../../agent/manager', () => ({
    agentManager: { ensureAgent: async () => ({ sendCommand: (...a: unknown[]) => sendCommand(...(a as [string, unknown])) }) },
}));
vi.mock('../../config', () => ({
    getConfig: async () => structuredClone(config),
    saveConfig: async (c: typeof config) => { config = structuredClone(c); },
}));
vi.mock('../../registry', () => ({ getTemplateVariables: async () => null }));
vi.mock('../../health/store', () => ({ HealthStore: { deleteServiceCheck: () => 0 } }));
vi.mock('../../capabilities/serviceLifecycleEvents', () => ({
    reconstructTemplateVariables: async () => [],
    emitFeatureUninstalling: async () => [],
    emitFeatureUninstalled: async () => [],
    emitFeatureRestored: async () => [],
    recordCapabilityOutcome: async () => undefined,
}));
vi.mock('./units', async importOriginal => ({
    ...(await importOriginal<typeof import('./units')>()),
    reloadDaemon: async () => undefined,
    startAndWaitForActive: async () => ({ state: 'active' as const }),
}));
vi.mock('../serviceListing', async importOriginal => {
    const actual = await importOriginal<typeof import('../serviceListing')>();
    class Stub extends actual.ServiceListing {
        static override getServiceFiles = async (_node: string, name: string) => ({
            kubeContent: '', yamlContent: '', yamlPath: `.config/containers/systemd/${name}.yml`,
            serviceContent: '', kubePath: `.config/containers/systemd/${name}.kube`,
            servicePath: '', quadletKind: 'kube' as const,
        });
    }
    return { ...actual, ServiceListing: Stub };
});

const { deleteService, restoreTrashedService, purgeTrash } = await import('./trash');
const { ServiceListing } = await import('../serviceListing');
const { resetTrashMigrationMemo, buildTrashMigrationCommand, shellPath } = await import('./trashPaths');

const record = () => ({ schemaVersion: 3, installedAt: '2026-01-01T00:00:00Z' });

/** A box with `media` installed: unit, pod spec, a `.container` sibling and an
 *  installedTemplates record. */
function installMedia() {
    box.write(`${SCAN}/media.kube`, '[Kube]\nYaml=media.yml\n');
    box.write(`${SCAN}/media.yml`, 'apiVersion: v1\n');
    box.write(`${SCAN}/media.container`, '[Container]\n');
    config.installedTemplates = { media: record(), immich: record() };
}

beforeEach(() => {
    box = new FakeBox();
    config = {};
    sendCommand.mockClear();
    resetTrashMigrationMemo();
});

describe('trash paths never carry a quoted tilde (#2859)', () => {
    it('emits no command with a quoted `~` across delete → list → restore → purge', async () => {
        installMedia();
        await deleteService('Local', 'media');
        const [entry] = await ServiceListing.listTrashedServices('Local');
        await restoreTrashedService('Local', entry.id);
        await deleteService('Local', 'media');
        const [again] = await ServiceListing.listTrashedServices('Local');
        await purgeTrash('Local', { trashId: again.id });

        const offenders = box.commands.filter(c => /'~/.test(c) || /"~\//.test(c));
        expect(offenders).toEqual([]);
        // …and the paths that DO reach the shell expand $HOME instead.
        expect(box.commands.some(c => c.includes('"$HOME/.config/containers/systemd-trash/'))).toBe(true);
    });

    it('creates and fills the trash root outside the Quadlet scan directory', async () => {
        installMedia();
        await deleteService('Local', 'media');

        // Everything the delete creates or moves into (the one-time sweep of
        // the legacy locations aside) targets the sibling root.
        const writes = box.commands.filter(
            c => !c.includes('SERVICEBAY_TRASH_MIGRATED') && /^(mkdir -p|mv -f|printf)/.test(c),
        );
        expect(writes.length).toBeGreaterThan(0);
        expect(writes.some(c => /containers\/systemd\/\.trash/.test(c))).toBe(false);
        expect(writes.some(c => c.includes('"$HOME/.config/containers/systemd-trash/'))).toBe(true);
    });
});

describe('after a soft-delete the generator no longer knows the unit (#2862)', () => {
    it('drops the unit from `systemctl --user list-units`', async () => {
        installMedia();
        expect(box.listUnits()).toContain('media.service');

        await deleteService('Local', 'media');

        expect(box.exec('systemctl --user list-units')).toMatchObject({ code: 0 });
        expect(box.listUnits()).not.toContain('media.service');
        // The files are not gone — they are recoverable in the sibling root.
        expect(box.exists(TRASH)).toBe(true);
        expect([...box.files.keys()].some(p => p.startsWith(`${TRASH}/`) && p.endsWith('media.kube'))).toBe(true);
    });

    it('control: trash INSIDE the scan path would resurrect the unit (the #2862 defect)', () => {
        box.write(`${LEGACY_IN_SCAN}/2026-09-06T07-04-05-312Z-media/media.kube`, '[Kube]\n');
        expect(box.listUnits()).toContain('media.service');
    });

    it('takes the .container and .yml siblings with it, not only the .kube', async () => {
        installMedia();
        await deleteService('Local', 'media');
        expect(box.exists(`${SCAN}/media.kube`)).toBe(false);
        expect(box.exists(`${SCAN}/media.container`)).toBe(false);
        expect(box.exists(`${SCAN}/media.yml`)).toBe(false);
        expect(box.listUnits()).toEqual([]);
    });
});

describe('list → restore round-trip carries the installedTemplates record (#2863)', () => {
    it('drops the record on delete, lists the entry, and puts everything back on restore', async () => {
        installMedia();
        await deleteService('Local', 'media');

        expect(config.installedTemplates).toEqual({ immich: record() });

        const entries = await ServiceListing.listTrashedServices('Local');
        expect(entries).toHaveLength(1);
        expect(entries[0].service).toBe('media');
        expect(entries[0].path).toMatch(/^~\/\.config\/containers\/systemd-trash\//);

        const res = await restoreTrashedService('Local', entries[0].id);
        expect(res.service).toBe('media');
        expect(config.installedTemplates).toEqual({ immich: record(), media: record() });
        expect(box.exists(`${SCAN}/media.kube`)).toBe(true);
        expect(box.exists(`${SCAN}/media.container`)).toBe(true);
        expect(box.exists(`${SCAN}/media.yml`)).toBe(true);
        expect(box.listUnits()).toContain('media.service');
        expect(await ServiceListing.listTrashedServices('Local')).toEqual([]);
    });

    it('leaves installedTemplates alone for a service that never had a record', async () => {
        box.write(`${SCAN}/scratch.kube`, '[Kube]\n');
        config.installedTemplates = { immich: record() };
        await deleteService('Local', 'scratch');
        expect(config.installedTemplates).toEqual({ immich: record() });
    });
});

describe('legacy trash migration is one-time and idempotent (#2859/#2862)', () => {
    it('moves entries out of BOTH wrong places and leaves the scan path clean', async () => {
        box.write(`${LEGACY_IN_SCAN}/2026-09-06T07-04-05-312Z-old/old.kube`, '[Kube]\n');
        box.write(`${LEGACY_IN_SCAN}/2026-09-06T07-04-05-312Z-old/.manifest.json`, JSON.stringify({ service: 'old', deletedAt: '2026-09-06T07:04:05Z' }));
        box.write(`${LEGACY_TILDE}/2026-09-05T10-00-00-000Z-ollama/ollama.kube`, '[Kube]\n');
        expect(box.listUnits()).toContain('old.service');

        const entries = await ServiceListing.listTrashedServices('Local');

        expect(entries.map(e => e.service).sort()).toEqual(['old', 'ollama']);
        expect(box.listUnits()).toEqual([]);
        expect(box.exists(LEGACY_IN_SCAN)).toBe(false);
        expect(box.exists(LEGACY_TILDE)).toBe(false);
    });

    it('re-running it moves nothing and changes no entry', async () => {
        box.write(`${LEGACY_IN_SCAN}/2026-09-06T07-04-05-312Z-old/old.kube`, '[Kube]\n');
        const first = await ServiceListing.listTrashedServices('Local');

        resetTrashMigrationMemo();
        const second = await ServiceListing.listTrashedServices('Local');

        expect(second).toEqual(first);
        const sweeps = box.commands.filter(c => c.includes('SERVICEBAY_TRASH_MIGRATED'));
        expect(sweeps).toHaveLength(2);
        expect(box.children(TRASH)).toEqual(['2026-09-06T07-04-05-312Z-old']);
    });

    it('runs the sweep once per node per process', async () => {
        await ServiceListing.listTrashedServices('Local');
        await ServiceListing.listTrashedServices('Local');
        expect(box.commands.filter(c => c.includes('SERVICEBAY_TRASH_MIGRATED'))).toHaveLength(1);
    });
});

describe('shellPath / the sweep script (#2859)', () => {
    it('anchors a relative path at $HOME inside double quotes, never a tilde', () => {
        expect(shellPath('.config/containers/systemd-trash')).toBe('"$HOME/.config/containers/systemd-trash"');
        expect(shellPath('/mnt/data/x.yml')).toBe('"/mnt/data/x.yml"');
        // A legacy `~/…` value read back out of an old manifest is normalised
        // rather than passed through.
        expect(shellPath('~/.config/containers/systemd/media.kube')).toBe('"$HOME/.config/containers/systemd/media.kube"');
    });

    it('sweeps both legacy locations into the sibling root and carries no quoted tilde', () => {
        const cmd = buildTrashMigrationCommand();
        expect(cmd).toContain('"$HOME/.config/containers/systemd/.trash"');
        expect(cmd).toContain('"./~/.config/containers/systemd/.trash"');
        expect(cmd).toContain('dest="$HOME/.config/containers/systemd-trash"');
        expect(/'~/.test(cmd)).toBe(false);
    });
});

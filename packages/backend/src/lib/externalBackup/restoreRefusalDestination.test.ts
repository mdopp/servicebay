/**
 * CLASS GATE (#2935) — a restore must never destroy a directory the CALLER
 * already owned.
 *
 * The bug this locks down: the extract-or-refuse path judged the WHOLE
 * destination (the live service data dir) after extraction, so one pre-existing
 * symlink — a link into a container-internal path, dangling on the host by
 * construction — was read as an escaping archive and the path answered with
 * `rm -rf <the live data dir>`. Tier-B data is not on the NAS by design
 * (ADR 0002), so that loss is unrecoverable.
 *
 * This file is deliberately driven from an ENUMERATION of the call sites, not
 * from a hand-written list of cases: `discoverCallSites()` reads the backend lib
 * tree and finds every place that hands a destination to `safeTarExtract` or
 * `extractServiceConfigToNode`. A caller added later shows up in that scan and
 * fails the coverage test until it is mapped to a harness — so the class stays
 * covered without anyone remembering to extend a list.
 *
 * Each site is then asserted on the property itself, in both directions:
 *   - a REFUSED archive leaves the destination byte-for-byte intact, and
 *   - what the destination ALREADY held is never judged: a pre-existing
 *     (dangling) symlink cannot trigger the refusal at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { readFileSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Executor } from '../interfaces';

const execFileAsync = promisify(execFile);

const { mockNas, mockCfg, mockNpmCredStatus, mockRekeyNpm, mockGetExecutor } = vi.hoisted(() => ({
  mockNas: { nasUpload: vi.fn(), nasDownload: vi.fn(), nasList: vi.fn() },
  mockCfg: { getConfig: vi.fn(), saveConfig: vi.fn(), updateConfig: vi.fn(async () => ({})) },
  mockNpmCredStatus: vi.fn(),
  mockRekeyNpm: vi.fn(),
  mockGetExecutor: vi.fn(),
}));
vi.mock('./nasClient', () => mockNas);
vi.mock('../config', () => mockCfg);
vi.mock('../reverseProxy/npmAdminRekey', () => ({
  npmAdminCredStatus: (...a: unknown[]) => mockNpmCredStatus(...a),
  rekeyNpmAdmin: (...a: unknown[]) => mockRekeyNpm(...a),
}));
vi.mock('../executor', () => ({ getExecutor: (...a: unknown[]) => mockGetExecutor(...a) }));

import { restoreServiceBackup, autoRestoreServiceOnReinstall } from './restore';
import { safeTarExtract, extractServiceConfigToNode } from '../systemBackup';
import { NAS_BACKUP_DIR } from './producer';

// ---------------------------------------------------------------------------
// 1. The enumeration: every call site that hands a destination to one of the
//    two extract-or-refuse primitives.
// ---------------------------------------------------------------------------

const LIB_ROOT = path.resolve(__dirname, '..');
const PRIMITIVES = ['safeTarExtract', 'extractServiceConfigToNode'] as const;
const NOT_A_SYMBOL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'try', 'do', 'else', 'new', 'typeof']);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

/**
 * Site id = `<file>:<enclosing symbol>→<primitive>` — stable across line moves,
 * unique per (function, primitive) pair.
 */
function discoverCallSites(): string[] {
  const sites = new Set<string>();
  for (const file of listSourceFiles(LIB_ROOT)) {
    const rel = path.relative(LIB_ROOT, file).split(path.sep).join('/');
    let top = '<module>';
    let member = '';
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const topMatch =
        line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/) ??
        line.match(/^(?:export\s+)?const\s+(\w+)\s*[:=]/);
      if (topMatch) { top = topMatch[1]; member = ''; }
      const memberMatch = line.match(/^\s{2,}(?:async\s+)?(\w+)\s*\([^()]*\)\s*(?::[^{;]+)?\{\s*$/);
      if (memberMatch && !NOT_A_SYMBOL.has(memberMatch[1])) member = memberMatch[1];
      if (/^\s*(?:\*|\/\/|import\b)/.test(line)) continue;
      if (/^(?:export\s+)?(?:async\s+)?function\s/.test(line)) continue; // the definition itself
      for (const primitive of PRIMITIVES) {
        if (new RegExp(`\\b${primitive}\\s*\\(`).test(line)) {
          sites.add(`${rel}:${[top, member].filter(Boolean).join('.')}→${primitive}`);
        }
      }
    }
  }
  return [...sites].sort();
}

/**
 * Every discovered site → the harness(es) below that prove the property for it.
 * `restoreSystemBackupSelection→extractServiceConfigToNode` IS the guided
 * per-service System-Snapshot restore; `agentRestoreBackend.extractTar` is what
 * a `wipe-config` reinstall reaches through `autoRestoreServiceOnReinstall`.
 */
const SITE_HARNESSES: Record<string, string[]> = {
  'systemBackup.ts:stageServiceConfig→safeTarExtract': ['safeTarExtract'],
  'systemBackup.ts:stageRemoteSystemd→safeTarExtract': ['safeTarExtract'],
  'systemBackup.ts:hashSnapshotConfig→safeTarExtract': ['safeTarExtract'],
  'systemBackup.ts:restoreSystemBackup→safeTarExtract': ['safeTarExtract'],
  'systemBackup.ts:previewSystemBackup→safeTarExtract': ['safeTarExtract'],
  'systemBackup.ts:readSystemBackupFile→safeTarExtract': ['safeTarExtract'],
  'systemBackup.ts:restoreSystemBackupSelection→safeTarExtract': ['safeTarExtract'],
  'systemBackup.ts:restoreSystemBackupSelection→extractServiceConfigToNode': ['extractServiceConfigToNode'],
  'externalBackup/restore.ts:localRestoreBackend.extractTar→safeTarExtract': ['safeTarExtract'],
  'externalBackup/restore.ts:agentRestoreBackend.extractTar→extractServiceConfigToNode': [
    'extractServiceConfigToNode',
    'restoreServiceBackup(force)',
    'autoRestoreServiceOnReinstall(wipe-config)',
  ],
};

// ---------------------------------------------------------------------------
// 2. Fixtures — a live destination, and the two archives.
// ---------------------------------------------------------------------------

let tmpRoot: string;
let dataDir: string;

const INSTALLED_TEMPLATES = Object.fromEntries(
  ['home-assistant', 'auth', 'media', 'file-share', 'nginx', 'adguard', 'vaultwarden', 'radicale', 'beets']
    .map(name => [name, { schemaVersion: 1, installedAt: '2026-01-01T00:00:00.000Z' }]),
);

/**
 * Seed a destination the way a live service data dir looks on a `wipe-config`
 * reinstall: kept DATA, plus a symlink that was ALREADY there and is dangling on
 * the host (it points into the container's own filesystem). None of it is the
 * archive's doing, so none of it may be judged or removed.
 */
async function seedLiveDir(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, '.storage'), { recursive: true });
  await fs.writeFile(path.join(dir, 'home-assistant_v2.db'), 'RECORDER-DB');
  await fs.writeFile(path.join(dir, '.storage', 'zwave_js'), '{"keys":"MESH"}');
  await fs.symlink('/config/secrets.yaml', path.join(dir, 'secrets.yaml'));
}

async function expectLiveDirIntact(dir: string): Promise<void> {
  expect(await fs.readFile(path.join(dir, 'home-assistant_v2.db'), 'utf8')).toBe('RECORDER-DB');
  expect(await fs.readFile(path.join(dir, '.storage', 'zwave_js'), 'utf8')).toBe('{"keys":"MESH"}');
  expect(await fs.readlink(path.join(dir, 'secrets.yaml'))).toBe('/config/secrets.yaml');
}

/** A plain, entirely benign config tar — the everyday restore payload. */
async function benignTarFile(): Promise<string> {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-benign-'));
  await fs.writeFile(path.join(stage, 'configuration.yaml'), 'restored:');
  const tarPath = path.join(stage, 'benign.tar');
  await execFileAsync('tar', ['-cf', tarPath, '-C', stage, 'configuration.yaml']);
  return tarPath;
}

/** An archive that is REFUSED by the in-container tar pre-pass (traversal). */
async function traversalTarFile(): Promise<string> {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-evil-'));
  await fs.mkdir(path.join(stage, 'sub'), { recursive: true });
  await fs.writeFile(path.join(stage, 'sub', 'escape'), 'EVIL');
  const tarPath = path.join(stage, 'evil.tar');
  await execFileAsync('tar', ['-cf', tarPath, '-C', path.join(stage, 'sub'), '--transform', 's,^,../,', 'escape']);
  return tarPath;
}

/**
 * An archive that PASSES the pre-pass (its link target is lexically inside the
 * root) but is refused by the post-extraction symlink walk — i.e. the refusal
 * that used to reach `fs.rm(destination)`.
 */
async function postPassRefusedTarFile(): Promise<string> {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-postpass-'));
  const src = path.join(stage, 'src', 'inner');
  await fs.mkdir(src, { recursive: true });
  await fs.symlink('../outside', path.join(src, 'link'));
  const tarPath = path.join(stage, 'postpass.tar');
  await execFileAsync('tar', ['-cf', tarPath, '-C', path.join(stage, 'src'), '.']);
  return tarPath;
}

// ---------------------------------------------------------------------------
// 3. A fake node agent backed by a real temp dir, so the host-side
//    mktemp/tar/ls/find/readlink/rm run against actual files.
// ---------------------------------------------------------------------------

function fakeHostExecutor(): Executor {
  const staged = new Map<string, string>();
  const exec: Partial<Executor> = {
    exists: async (p: string) => fs.access(p).then(() => true, () => false),
    writeFile: async (p: string, content: string) => { staged.set(p, content); },
    // `base64 -d "$1" > "$2"` genuinely needs a shell, so it arrives as a
    // quoted string; the two paths are the last two words (#2737).
    exec: async (command: string) => {
      const parts = command.split(' ');
      await fs.writeFile(parts[parts.length - 1], Buffer.from(staged.get(parts[parts.length - 2]) ?? '', 'base64'));
      return { stdout: '', stderr: '' };
    },
    execSafe: async (argv: string[]) => {
      const [cmd, ...rest] = argv;
      const ok = (stdout = '') => ({ stdout, stderr: '', code: 0 });
      if (cmd === 'mktemp') {
        const dirMode = rest.includes('-d');
        const p = path.join(tmpRoot, `mktemp-${Math.random().toString(36).slice(2)}`);
        if (dirMode) await fs.mkdir(p, { recursive: true });
        else await fs.writeFile(p, '');
        return ok(p + '\n');
      }
      if (cmd === 'mkdir') { await fs.mkdir(rest[rest.length - 1], { recursive: true }); return ok(); }
      if (cmd === 'ls') {
        // `ls -A <dir>` — throws (like the agent's non-zero exit) when absent.
        const entries = await fs.readdir(rest[rest.length - 1]);
        return ok(entries.join('\n'));
      }
      if (cmd === 'tar') {
        const f = argv[argv.indexOf('-xf') + 1];
        const c = argv[argv.indexOf('-C') + 1];
        await execFileAsync('tar', ['-xf', f, '-C', c, '--no-same-owner']);
        return ok();
      }
      if (cmd === 'readlink') {
        const target = rest[rest.length - 1];
        if (!rest.includes('-f')) return ok((await fs.readlink(target)) + '\n');
        // GNU `readlink -f`: canonicalize, allowing the LAST component to be
        // missing; fails (empty, non-zero) when a parent doesn't resolve.
        const direct = await fs.realpath(target).catch(() => null);
        if (direct) return ok(direct + '\n');
        const parent = await fs.realpath(path.dirname(target)).catch(() => null);
        if (parent) return ok(path.join(parent, path.basename(target)) + '\n');
        throw new Error(`readlink -f: ${target}`);
      }
      if (cmd === 'find') {
        const dir = rest[0];
        const type = argv[argv.indexOf('-type') + 1];
        const out: string[] = [];
        const walk = async (d: string): Promise<void> => {
          for (const ent of await fs.readdir(d, { withFileTypes: true })) {
            const full = path.join(d, ent.name);
            if (ent.isSymbolicLink()) { if (type === 'l') out.push(full); }
            else if (ent.isDirectory()) { if (type === 'd') out.push(full); await walk(full); }
            else if (type === 'f') out.push(full);
          }
        };
        await walk(dir).catch(() => {});
        return ok(out.join('\n') + '\n');
      }
      if (cmd === 'rm') {
        for (const a of rest) if (a.startsWith('/')) await fs.rm(a, { recursive: true, force: true }).catch(() => {});
        return ok();
      }
      return ok();
    },
  };
  return exec as Executor;
}

// ---------------------------------------------------------------------------
// 4. The harnesses — one per way a caller-owned destination reaches a primitive.
// ---------------------------------------------------------------------------

interface Harness {
  /** Drive a REFUSED restore into `dataDir`; resolve once the refusal happened. */
  refuse(): Promise<void>;
  /** Drive a BENIGN restore into `dataDir`; it must succeed despite what is
   *  already in there (nothing pre-existing is the archive's doing). */
  benign(): Promise<void>;
}

function serveTar(tar: Buffer) {
  mockNas.nasDownload.mockImplementation(async (p: string) => {
    if (p === `${NAS_BACKUP_DIR}/home-assistant.tar`) return tar;
    throw new Error('not found'); // no meta sidecar
  });
}

const HARNESSES: Record<string, Harness> = {
  safeTarExtract: {
    async refuse() {
      await expect(safeTarExtract(await postPassRefusedTarFile(), dataDir, { gzip: false }))
        .rejects.toThrow(/symlink/i);
    },
    async benign() {
      await safeTarExtract(await benignTarFile(), dataDir, { gzip: false });
      expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('restored:');
    },
  },
  extractServiceConfigToNode: {
    async refuse() {
      const tar = await fs.readFile(await traversalTarFile());
      await expect(extractServiceConfigToNode(fakeHostExecutor(), tar, dataDir)).rejects.toThrow(/traversal/i);
    },
    async benign() {
      const tar = await fs.readFile(await benignTarFile());
      await extractServiceConfigToNode(fakeHostExecutor(), tar, dataDir);
      expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('restored:');
    },
  },
  'restoreServiceBackup(force)': {
    async refuse() {
      serveTar(await fs.readFile(await traversalTarFile()));
      await expect(restoreServiceBackup('home-assistant', { node: 'Local', force: true }))
        .rejects.toThrow(/traversal/i);
    },
    async benign() {
      serveTar(await fs.readFile(await benignTarFile()));
      const r = await restoreServiceBackup('home-assistant', { node: 'Local', force: true });
      expect(r.dataDir).toBe(dataDir);
      expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('restored:');
    },
  },
  'autoRestoreServiceOnReinstall(wipe-config)': {
    async refuse() {
      serveTar(await fs.readFile(await traversalTarFile()));
      const logs: string[] = [];
      // Best-effort by design: it logs the failure loudly instead of throwing.
      await autoRestoreServiceOnReinstall(
        'home-assistant', { wipeMode: 'wipe-config', node: 'Local' }, async l => { logs.push(l); },
      );
      expect(logs.some(l => /restore FAILED/i.test(l))).toBe(true);
    },
    async benign() {
      serveTar(await fs.readFile(await benignTarFile()));
      const logs: string[] = [];
      await autoRestoreServiceOnReinstall(
        'home-assistant', { wipeMode: 'wipe-config', node: 'Local' }, async l => { logs.push(l); },
      );
      expect(logs.some(l => /restore FAILED/i.test(l))).toBe(false);
      expect(await fs.readFile(path.join(dataDir, 'configuration.yaml'), 'utf8')).toBe('restored:');
    },
  },
};

// ---------------------------------------------------------------------------

beforeEach(async () => {
  vi.clearAllMocks();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'refusal-class-'));
  dataDir = path.join(tmpRoot, 'home-assistant', 'homeassistant');
  mockCfg.getConfig.mockResolvedValue({ templateSettings: { DATA_DIR: tmpRoot }, installedTemplates: INSTALLED_TEMPLATES });
  mockCfg.saveConfig.mockResolvedValue(undefined);
  mockNas.nasList.mockResolvedValue([{ name: 'home-assistant.tar', size: 1024 }]);
  mockGetExecutor.mockImplementation(() => fakeHostExecutor());
  await seedLiveDir(dataDir);
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('#2935 — a refusal never deletes a destination the caller already owned', () => {
  const sites = discoverCallSites();

  it('every call site that hands a destination to an extract-or-refuse primitive is covered', () => {
    // A NEW caller shows up here and fails until it is mapped to a harness —
    // that is what makes this a class gate rather than four hand-picked cases.
    expect(sites).toEqual(Object.keys(SITE_HARNESSES).sort());
    for (const [site, harnesses] of Object.entries(SITE_HARNESSES)) {
      expect(harnesses.length, `${site} has no harness`).toBeGreaterThan(0);
      for (const name of harnesses) expect(HARNESSES[name], `unknown harness "${name}"`).toBeDefined();
    }
  });

  it.each(sites)('%s — a refusal leaves the live destination byte-for-byte intact', async site => {
    for (const name of SITE_HARNESSES[site]) {
      await fs.rm(dataDir, { recursive: true, force: true });
      await seedLiveDir(dataDir);
      await HARNESSES[name].refuse();
      await expectLiveDirIntact(dataDir);
    }
  });

  it.each(sites)('%s — a pre-existing symlink in the destination never triggers the refusal', async site => {
    for (const name of SITE_HARNESSES[site]) {
      await fs.rm(dataDir, { recursive: true, force: true });
      await seedLiveDir(dataDir);
      // `secrets.yaml -> /config/secrets.yaml` was already there and is dangling
      // on this host. It is not the archive's doing, so it is not judged.
      await HARNESSES[name].benign();
      await expectLiveDirIntact(dataDir);
    }
  });
});

describe('#2935 — a dangling host link is classified as dangling, not as an escape', () => {
  it('an archive link that resolves nowhere but stays inside the tree is accepted', async () => {
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-dangle-'));
    await fs.writeFile(path.join(stage, 'configuration.yaml'), 'restored:');
    await fs.symlink('missing-sibling', path.join(stage, 'inside-link'));
    const tarPath = path.join(stage, 'dangle.tar');
    await execFileAsync('tar', ['-cf', tarPath, '-C', stage, 'configuration.yaml', 'inside-link']);

    await extractServiceConfigToNode(fakeHostExecutor(), await fs.readFile(tarPath), dataDir);
    expect(await fs.readlink(path.join(dataDir, 'inside-link'))).toBe('missing-sibling');
  });

  it('names the link as DANGLING — not as an escape — when it is refused', async () => {
    const exec = fakeHostExecutor();
    // Force the host walk to see an unresolvable link with a traversing target:
    // `readlink -f` comes back empty, `readlink` reports the raw `../…`.
    const inner = path.join(tmpRoot, 'probe-src');
    await fs.mkdir(inner, { recursive: true });
    await fs.writeFile(path.join(inner, 'configuration.yaml'), 'x');
    const tarPath = path.join(tmpRoot, 'ok.tar');
    await execFileAsync('tar', ['-cf', tarPath, '-C', inner, '.']);

    const realExecSafe = exec.execSafe.bind(exec);
    vi.spyOn(exec, 'execSafe').mockImplementation(async (argv, options) => {
      if (argv[0] === 'find' && argv.includes('-type') && argv[argv.indexOf('-type') + 1] === 'l') {
        return { stdout: `${tmpRoot}/ghost-link\n`, stderr: '', code: 0 };
      }
      if (argv[0] === 'readlink' && argv[argv.length - 1].endsWith('ghost-link')) {
        if (argv.includes('-f')) throw new Error('unresolvable');
        return { stdout: '../../etc/shadow\n', stderr: '', code: 0 };
      }
      return realExecSafe(argv, options);
    });

    await expect(extractServiceConfigToNode(exec, await fs.readFile(tarPath), dataDir))
      .rejects.toThrow(/dangling symlink .* points outside/i);
    await expectLiveDirIntact(dataDir);
  });
});

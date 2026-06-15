/**
 * Phase-0 regression PINS for the per-service NAS-tar atom (epic #1607, #1608).
 *
 * The System-Snapshot unification (#1609+) refactors backup *collection* and the
 * restore engine. The per-service tar `sb-backup/<svc>.tar` is the canonical atom
 * that four producers feed (box-side producer, the `sb-config-upload` CLI, the
 * HA-OS importer, and the upload route), and the pre-install seed flow depends on
 * it byte-for-byte. These tests LOCK the behaviour that must not change so the
 * merge can't silently regress that path — they assert NO new behaviour, only the
 * existing contract:
 *
 *   1. `stageServiceBackup` selection against the REAL manifests — the golden
 *      include/exclude/glob/strip/transform/rename spec the Snapshot's
 *      service-config section must reproduce.
 *   2. `runConfigUpload` (`sb-config-upload --service/--from`) end-to-end with the
 *      REAL producer (only the NAS mocked): the on-NAS `<svc>.tar` + `.meta.json`
 *      shape matches the box-side producer, whitelist + strip applied.
 *   3. `importHaOsBackupToNas` (haOsImport.ts): a Supervisor backup → a
 *      `home-assistant.tar` of ONLY the manifest includes (selective extraction).
 *   4. `stageUploadedServiceTar` + its route: unknown-service / sub-512 rejects,
 *      canonical layout, and the `tokenScope:'lifecycle'` contract on the route.
 *
 * If a Phase-1 change needs to alter any assertion here, that is a deliberate
 * format break — update this file in the same commit and call it out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const { mockNas } = vi.hoisted(() => ({
  mockNas: { nasUpload: vi.fn(), nasDownload: vi.fn(), nasList: vi.fn(), nasRemove: vi.fn() },
}));
/** Match a dated slot tar `<service>-YYYYMMDD-HHMM.tar` (#1865). */
const datedTarRe = (service: string) => new RegExp(`/${service}-\\d{8}-\\d{4}\\.tar$`);
vi.mock('./nasClient', () => mockNas);
// configUpload + the producer's box path read config; keep DATA_DIR unset so the
// CLI's explicit serviceDataDir is the only source (the local fs backend).
vi.mock('../config', () => ({ getConfig: vi.fn(async () => ({ templateSettings: {} })) }));

import { stageServiceBackup } from './producer';
import { runConfigUpload, type UploadIO } from './configUpload';
import { importHaOsBackupToNas } from './haOsImport';
import { getServiceManifest } from './serviceManifest';

let tmpDirs: string[] = [];
async function mkTmp(prefix = 'atomreg-'): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
async function write(base: string, rel: string, content: string): Promise<void> {
  const full = path.join(base, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}
async function extractTar(tar: Buffer): Promise<string> {
  const out = await mkTmp('atomreg-extract-');
  const tarFile = path.join(out, 'a.tar');
  await fs.writeFile(tarFile, tar);
  await execFileAsync('tar', ['-xf', tarFile, '-C', out]);
  await fs.rm(tarFile, { force: true });
  return out;
}
/** Sorted list of every regular file (posix-relative) under `dir`. */
async function listFilesRel(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) out.push(r);
    }
  }
  await walk('');
  return out.sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNas.nasUpload.mockResolvedValue(undefined);
  // #1865 retention prune lists then removes; no prior snapshots here → no-op.
  mockNas.nasList.mockResolvedValue([]);
  mockNas.nasRemove.mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.all(tmpDirs.map(d => fs.rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Golden selection spec — stageServiceBackup against the REAL manifests.
//    This is the exact staged-file set each service's atom MUST contain; the
//    Snapshot's service-config section has to reproduce it (#1608 acceptance).
// ─────────────────────────────────────────────────────────────────────────────
describe('GOLDEN: stageServiceBackup selection per real manifest', () => {
  it('adguard — keeps only conf/AdGuardHome.yaml, drops querylog/stats/sessions/filters', async () => {
    const src = await mkTmp();
    await write(src, 'conf/AdGuardHome.yaml', 'bind_host: 0.0.0.0');
    await write(src, 'data/querylog.json', '[]');
    await write(src, 'data/stats.db', 'STATS');
    await write(src, 'data/sessions.db', 'SESS');
    await write(src, 'data/filters/0.txt', 'rules');
    const staging = await mkTmp();
    const staged = await stageServiceBackup(src, getServiceManifest('adguard')!, staging);
    expect(staged).toEqual(['conf/AdGuardHome.yaml']);
  });

  it('authelia — keeps users_database.yml with password hashes STRIPPED, identity kept', async () => {
    const src = await mkTmp();
    await write(
      src,
      'users_database.yml',
      'users:\n  alice:\n    password: $argon2id$SECRET\n    displayname: Alice\n    email: a@x\n    groups:\n      - admins\n',
    );
    const staging = await mkTmp();
    const staged = await stageServiceBackup(src, getServiceManifest('authelia')!, staging);
    expect(staged).toEqual(['users_database.yml']);
    const out = await fs.readFile(path.join(staging, 'users_database.yml'), 'utf8');
    expect(out).not.toContain('SECRET');
    expect(out).not.toMatch(/password:/);
    expect(out).toContain('a@x');
    expect(out).toContain('Alice');
    expect(out).toContain('admins');
  });

  it('home-assistant — globs (lovelace*/hacs*) + custom_components dir + config-entries transform; DB/logs excluded', async () => {
    const src = await mkTmp();
    // Manifest includes
    await write(src, 'automations.yaml', '[]');
    await write(src, 'scripts.yaml', '{}');
    await write(src, 'scenes.yaml', '[]');
    await write(src, 'configuration.yaml', 'default_config:');
    await write(src, '.storage/core.device_registry', '{}');
    await write(src, '.storage/core.entity_registry', '{}');
    await write(src, '.storage/core.area_registry', '{}');
    await write(src, '.storage/lovelace', '{"sidebar":true}');
    await write(src, '.storage/lovelace.lovelace', '{"dash":"main"}');
    await write(src, '.storage/lovelace.map', '{"dash":"map"}');
    await write(src, '.storage/zwave_js', '{"keys":"MESH"}');
    await write(src, '.storage/hacs.repositories', '[]');
    await write(src, '.storage/hacs.data', '{}');
    await write(src, 'custom_components/meross_lan/__init__.py', 'CODE');
    await write(src, 'custom_components/meross_lan/manifest.json', '{"domain":"meross_lan"}');
    // The config-entries file the transform rewrites: a zwave_js add-on entry +
    // a Supervisor-only `hassio` entry that must be dropped.
    await write(
      src,
      '.storage/core.config_entries',
      JSON.stringify({
        data: {
          entries: [
            { domain: 'zwave_js', data: { use_addon: true, integration_created_addon: true, url: 'ws://core-zwave-js:3000' } },
            { domain: 'hassio', data: {} },
            { domain: 'light', data: { keep: true } },
          ],
        },
      }),
    );
    // Excluded heavy data / logs
    await write(src, 'home-assistant_v2.db', 'DB');
    await write(src, 'home-assistant_v2.db-wal', 'WAL');
    await write(src, 'home-assistant.log', 'noise');
    await write(src, 'logs/today.log', 'noise');
    await write(src, 'www/photo.jpg', 'IMG');
    await write(src, 'deps/lib.py', 'dep');

    const staging = await mkTmp();
    const staged = await stageServiceBackup(src, getServiceManifest('home-assistant')!, staging);

    expect(staged).toEqual([
      '.storage/core.area_registry',
      '.storage/core.config_entries',
      '.storage/core.device_registry',
      '.storage/core.entity_registry',
      '.storage/hacs.data',
      '.storage/hacs.repositories',
      '.storage/lovelace',
      '.storage/lovelace.lovelace',
      '.storage/lovelace.map',
      '.storage/zwave_js',
      'automations.yaml',
      'configuration.yaml',
      'custom_components/meross_lan/__init__.py',
      'custom_components/meross_lan/manifest.json',
      'scenes.yaml',
      'scripts.yaml',
    ]);
    // Transform PIN: zwave_js add-on entry rewritten to in-pod localhost, the
    // Supervisor-only `hassio` entry dropped, the unrelated `light` entry kept.
    const entries = (
      JSON.parse(await fs.readFile(path.join(staging, '.storage/core.config_entries'), 'utf8')) as {
        data: { entries: { domain: string; data: Record<string, unknown> }[] };
      }
    ).data.entries;
    const domains = entries.map(e => e.domain);
    expect(domains).toEqual(['zwave_js', 'light']);
    expect(entries[0].data.use_addon).toBe(false);
    expect(entries[0].data.url).toBe('ws://localhost:3001');
  });

  it('home-assistant-zwave (sibling store #1594) — keeps settings.json + sb-external-settings.json verbatim, drops logs/store.jsonl', async () => {
    const src = await mkTmp();
    await write(src, 'settings.json', '{"securityKeys":{"S2_Authenticated":"KEY"}}');
    await write(src, 'sb-external-settings.json', '{"serverPort":3001}');
    await write(src, 'store.jsonl', '{"node":1}');
    await write(src, 'logs/zwave.log', 'noise');
    const manifest = getServiceManifest('home-assistant-zwave')!;
    const staging = await mkTmp();
    const staged = await stageServiceBackup(src, manifest, staging);
    expect(staged).toEqual(['sb-external-settings.json', 'settings.json']);
    // No strip on this manifest — keys are kept verbatim.
    expect(await fs.readFile(path.join(staging, 'settings.json'), 'utf8')).toContain('KEY');
  });

  it('nginx — keeps db + letsencrypt + custom_ssl, drops renewal logs / regenerated nginx conf', async () => {
    const src = await mkTmp();
    await write(src, 'data/database.sqlite', 'SQLITE');
    await write(src, 'letsencrypt/accounts/acme.json', '{}');
    await write(src, 'letsencrypt/logs/letsencrypt.log', 'noise');
    await write(src, 'data/custom_ssl/cert.pem', 'PEM');
    await write(src, 'data/nginx/proxy_host/1.conf', 'server {}');
    await write(src, 'data/logs/access.log', 'noise');
    const staging = await mkTmp();
    // No collector runs here (stageServiceBackup is the pure selection step).
    const staged = await stageServiceBackup(src, getServiceManifest('nginx')!, staging);
    expect(staged).toEqual([
      'data/custom_ssl/cert.pem',
      'data/database.sqlite',
      'letsencrypt/accounts/acme.json',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. sb-config-upload end-to-end with the REAL producer (NAS mocked).
//    Existing configUpload.test.ts mocks the producer, so the on-NAS atom shape
//    is unpinned there. This locks that `--service/--from` writes the SAME
//    canonical `<svc>.tar` + `.meta.json` the box-side producer does.
// ─────────────────────────────────────────────────────────────────────────────
describe('GOLDEN: runConfigUpload writes the canonical on-NAS atom (real producer)', () => {
  function silentIO(): UploadIO {
    return { log: () => {}, confirm: async () => true };
  }

  it('produces sb-backup/authelia.tar (whitelist + strip) + .meta.json sidecar', async () => {
    const from = await mkTmp();
    await write(
      from,
      'users_database.yml',
      'users:\n  bob:\n    password: $argon2$NOPE\n    email: b@x\n',
    );
    await write(from, 'ignored.txt', 'not in the manifest');

    const result = await runConfigUpload(
      { service: 'authelia', from, target: 'fritzbox', assumeYes: true },
      silentIO(),
    );

    // Result contract — a dated slot, not a single overwritten authelia.tar (#1865).
    expect(result.tarName).toMatch(/^authelia-\d{8}-\d{4}\.tar$/);
    expect(result.metaName).toBe(`${result.tarName}.meta.json`);
    expect(result.meta.service).toBe('authelia');
    expect(result.meta.schemaVersion).toBe(1);

    // Canonical NAS layout: both files under sb-backup/.
    const uploadPaths = mockNas.nasUpload.mock.calls.map(c => String(c[0]));
    expect(uploadPaths).toContain(`sb-backup/${result.tarName}`);
    expect(uploadPaths).toContain(`sb-backup/${result.metaName}`);

    // The tar carries the stripped whitelist file only — same as a box backup.
    const tarBuf = mockNas.nasUpload.mock.calls.find(c => datedTarRe('authelia').test(String(c[0])))![1] as Buffer;
    const extracted = await extractTar(tarBuf);
    expect(await listFilesRel(extracted)).toEqual(['users_database.yml']);
    const body = await fs.readFile(path.join(extracted, 'users_database.yml'), 'utf8');
    expect(body).not.toContain('NOPE');
    expect(body).toContain('b@x');

    // Sidecar JSON shape.
    const metaBuf = mockNas.nasUpload.mock.calls.find(c => String(c[0]).endsWith('.meta.json'))![1] as Buffer;
    const meta = JSON.parse(metaBuf.toString('utf8'));
    expect(meta.service).toBe('authelia');
    expect(meta.schemaVersion).toBe(1);
    expect(typeof meta.createdAt).toBe('string');
    expect(typeof meta.nodeId).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. HA-OS import → home-assistant.tar (selective extraction; manifest includes
//    only). Pins that the Supervisor-backup path produces the SAME atom layout
//    a box-side HA backup would, never unpacking the heavy data/ DB.
// ─────────────────────────────────────────────────────────────────────────────
describe('GOLDEN: importHaOsBackupToNas → manifest-filtered home-assistant.tar', () => {
  async function buildSupervisorBackup(): Promise<string> {
    const inner = await mkTmp();
    await write(inner, 'data/configuration.yaml', 'default_config:');
    await write(inner, 'data/automations.yaml', '[]');
    await write(inner, 'data/.storage/zwave_js', '{"keys":"MESH"}');
    await write(inner, 'data/.storage/core.entity_registry', '{}');
    await write(inner, 'data/.storage/lovelace.lovelace', '{"dash":"main"}');
    await write(inner, 'data/.storage/hacs.repositories', '[]');
    // The HA manifest also includes the `custom_components` DIR (HACS installed
    // — the common case). The inner tar lists the dir + intermediate dir members
    // alongside the leaf files; extractHaConfigDir must pass only the leaf files
    // to `tar -x` or GNU/libarchive tar aborts ("Not found in archive") (#1620).
    await write(inner, 'data/custom_components/meross_lan/__init__.py', 'CODE');
    await write(inner, 'data/custom_components/meross_lan/manifest.json', '{"domain":"meross_lan"}');
    // Heavy excluded members — must never be unpacked nor staged (#1353).
    await write(inner, 'data/home-assistant_v2.db', 'HUGE-DB');
    await write(inner, 'data/home-assistant.log', 'noise');

    const outer = await mkTmp();
    await execFileAsync('tar', ['-czf', path.join(outer, 'homeassistant.tar.gz'), '-C', inner, '.']);
    await fs.writeFile(path.join(outer, 'backup.json'), '{"version":2,"type":"partial"}');

    const out = await mkTmp();
    const tarPath = path.join(out, 'ha-backup.tar');
    await execFileAsync('tar', ['-cf', tarPath, '-C', outer, 'homeassistant.tar.gz', 'backup.json']);
    return tarPath;
  }

  it('stages only the HA manifest includes — never the DB or logs', async () => {
    const backup = await buildSupervisorBackup();
    const res = await importHaOsBackupToNas(backup);
    expect(res.tarName).toMatch(/^home-assistant-\d{8}-\d{4}\.tar$/); // dated slot (#1865)

    const tarBuf = mockNas.nasUpload.mock.calls.find(c => datedTarRe('home-assistant').test(String(c[0])))![1] as Buffer;
    const extracted = await extractTar(tarBuf);
    const files = await listFilesRel(extracted);
    expect(files).toEqual([
      '.storage/core.entity_registry',
      '.storage/hacs.repositories',
      '.storage/lovelace.lovelace',
      '.storage/zwave_js',
      'automations.yaml',
      'configuration.yaml',
      'custom_components/meross_lan/__init__.py',
      'custom_components/meross_lan/manifest.json',
    ]);
    // The heavy excluded members never make it into the atom.
    expect(files).not.toContain('home-assistant_v2.db');
    expect(files).not.toContain('home-assistant.log');

    // Canonical sidecar written alongside the dated slot.
    const uploadPaths = mockNas.nasUpload.mock.calls.map(c => String(c[0]));
    expect(uploadPaths).toContain(`sb-backup/${res.tarName}`);
    expect(uploadPaths).toContain(`sb-backup/${res.tarName}.meta.json`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Upload route contract: stageUploadedServiceTar rejects + the route's
//    tokenScope:'lifecycle' gate (the scoped sb_ token the TUI uses). The
//    behavioural rejects are exercised against the real producer; the route's
//    token scope is pinned as a source contract (no frontend test harness here).
// ─────────────────────────────────────────────────────────────────────────────
describe('GOLDEN: upload route + stageUploadedServiceTar contract', () => {
  it("the upload route enforces tokenScope: 'lifecycle'", async () => {
    // vitest runs with cwd at the repo root (the workspace root, not the package).
    const routePath = path.join(
      process.cwd(),
      'packages/frontend/src/app/api/system/external-backup/upload/route.ts',
    );
    const src = await fs.readFile(routePath, 'utf8');
    // The scoped sb_ token the TUI seed flow (#1352) presents is a lifecycle
    // token; a downgrade here would break or over-expose the upload endpoint.
    expect(src).toMatch(/withApiHandler\(\s*\{\s*tokenScope:\s*'lifecycle'\s*\}/);
  });
});

/**
 * Assist-catalog delivery (#2701).
 *
 * The point of these cases is the half that is easy to get wrong: a delivery
 * that FAILS must present as empty and loud, never as a quietly stale catalog.
 * So each case asserts on the *refusal* — that a read throws, and that the
 * message says which of the two failure shapes it is — rather than on a happy
 * path that would pass just as well against a baked-in copy.
 *
 * Note what these cases do NOT prove: that a merged assist reaches a running
 * box. That is a claim about the git sync + the box, and it can only be settled
 * on the box (`get_assist(<new id>)` after a `docs:` commit, with no release in
 * between). Proving delivery against the in-process loader is exactly the
 * substitution that produced #2701.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const BASE = '/tmp/sb-assist-delivery-test';
vi.hoisted(() => {
  process.env.DATA_DIR = '/tmp/sb-assist-delivery-test';
  // Deliberately NOT setting ASSIST_CATALOG_DIR: these cases exercise the
  // git-delivered path and its freshness contract.
  delete process.env.ASSIST_CATALOG_DIR;
});

import * as delivery from './delivery';
import {
  AGENT_KIT_REQUIRED_FILES,
  AssistCatalogUnavailableError,
  agentKitDir,
  catalogDir,
  resolveAgentKitDir,
  resolveCatalogDir,
  assistDeliveryStatus,
  verifyDeliveredKit,
} from './delivery';
import { listAssists, getAssist } from './catalog';

const STATE_FILE = path.join(BASE, 'agent-kit', 'delivery.json');

async function seedDeliveredTree(): Promise<void> {
  const dir = catalogDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'alpha.md'),
    '---\ntitle: Alpha\nwhenToUse: when alpha\nkind: guide\n---\nbody\n',
    'utf-8',
  );
  for (const rel of AGENT_KIT_REQUIRED_FILES) {
    const file = path.join(agentKitDir(), rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '#!/usr/bin/env node\n', 'utf-8');
  }
}

async function writeState(state: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state), 'utf-8');
}

beforeEach(async () => {
  await fs.rm(BASE, { recursive: true, force: true });
  delete process.env.ASSIST_CATALOG_MAX_AGE_HOURS;
});

afterAll(async () => {
  await fs.rm(BASE, { recursive: true, force: true });
});

describe('assist catalog delivery (#2701)', () => {
  it('refuses to serve when the catalog was never delivered — loudly, not as an empty list', async () => {
    await seedDeliveredTree(); // files on disk, but no successful delivery recorded

    await expect(resolveCatalogDir()).rejects.toBeInstanceOf(AssistCatalogUnavailableError);
    await expect(listAssists()).rejects.toThrow(/never been delivered/i);
    await expect(getAssist('alpha')).rejects.toThrow(/never been delivered/i);
  });

  it('names the runtime delivery, not the image, in the refusal', async () => {
    const err = await resolveCatalogDir().then(() => null, (e: unknown) => e as Error);
    // A reader must be able to tell "the delivery is broken" from "no such
    // assist" — so the message has to name the mechanism and say it is an outage.
    expect(err?.message).toMatch(/NOT in the image/);
    expect(err?.message).toMatch(/outage, not an empty catalog/);
  });

  it('serves the delivered tree while the last successful delivery is fresh', async () => {
    await seedDeliveredTree();
    await writeState({
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      sha: 'abc1234',
      entryCount: 1,
      lastError: null,
    });

    await expect(resolveCatalogDir()).resolves.toBe(catalogDir());
    const list = await listAssists();
    expect(list.map(e => e.id)).toEqual(['alpha']);
  });

  it('stops serving once the last successful delivery ages past the window', async () => {
    await seedDeliveredTree();
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await writeState({
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: twoDaysAgo,
      sha: 'abc1234',
      entryCount: 1,
      lastError: 'fatal: unable to access',
    });

    // The tree is still on disk and perfectly readable — that is the whole
    // point. Serving it would be the stale-and-quiet failure the decision bans.
    await expect(listAssists()).rejects.toBeInstanceOf(AssistCatalogUnavailableError);
    const err = await getAssist('alpha').then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toMatch(/no longer served/);
    expect(err?.message).toMatch(/fatal: unable to access/);
  });

  it('honours a widened freshness window', async () => {
    await seedDeliveredTree();
    process.env.ASSIST_CATALOG_MAX_AGE_HOURS = '72';
    await writeState({
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      sha: 'abc1234',
      entryCount: 1,
      lastError: null,
    });

    await expect(resolveCatalogDir()).resolves.toBe(catalogDir());
  });

  it('retries a failed boot delivery instead of leaving the box dark until the hourly timer', async () => {
    // Observed on the box: an anonymous fetch of a public GitHub repo is refused
    // intermittently, several times in a row, then works. One boot attempt would
    // mean an hour of (correctly loud, but avoidable) darkness.
    const attempts = ['failed', 'failed', 'synced'] as const;
    let call = 0;
    const sync = vi.fn(async () => ({ status: attempts[call++], dir: catalogDir() }));

    vi.useFakeTimers();
    const promise = delivery.deliverAssistCatalogAtBoot(sync);
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.status).toBe('synced');
    expect(sync).toHaveBeenCalledTimes(3);
  });

  it('gives up loudly when every boot attempt fails', async () => {
    const sync = vi.fn(async () => ({ status: 'failed' as const, dir: catalogDir(), error: 'no route to host' }));
    vi.useFakeTimers();
    const promise = delivery.deliverAssistCatalogAtBoot(sync);
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result).toMatchObject({ status: 'failed', error: 'no route to host' });
    // …and the catalog stays unserved rather than falling back to anything.
    await expect(resolveCatalogDir()).rejects.toBeInstanceOf(AssistCatalogUnavailableError);
  });

  it('reports delivery status without throwing, so a broken box can still be diagnosed', async () => {
    const status = await assistDeliveryStatus();
    expect(status).toMatchObject({ lastSuccessAt: null, external: false });
    expect(status.dir).toBe(catalogDir());
    expect(status.kitDir).toBe(agentKitDir());
  });
});

// #2908: the same delivery carries the agent CLI. One checkout, one gate, one
// mount point — so these cases assert the KIT, not a second mechanism.
describe('agent-kit delivery (#2908)', () => {
  it('puts the catalog and the CLI under one root a container can mount', async () => {
    await seedDeliveredTree();
    await writeState({
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      sha: 'abc1234',
      entryCount: 1,
      lastError: null,
    });

    const root = await resolveAgentKitDir();
    expect(catalogDir().startsWith(`${root}${path.sep}`)).toBe(true);
    for (const rel of AGENT_KIT_REQUIRED_FILES) {
      await expect(fs.access(path.join(root, rel))).resolves.toBeUndefined();
    }
  });

  it('holds the kit root behind the SAME gate as the catalog — never delivered means no mount point either', async () => {
    await seedDeliveredTree(); // on disk, but nothing vouches for it
    await expect(resolveAgentKitDir()).rejects.toBeInstanceOf(AssistCatalogUnavailableError);
    await expect(resolveAgentKitDir()).rejects.toThrow(/never been delivered/i);
  });

  it('stops handing out the kit root once the delivery ages out', async () => {
    await seedDeliveredTree();
    await writeState({
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      sha: 'abc1234',
      entryCount: 1,
      lastError: 'fatal: unable to access',
    });

    await expect(resolveAgentKitDir()).rejects.toThrow(/no longer served/);
  });

  it('counts a checkout missing the CLI as a FAILED delivery, not an empty directory', async () => {
    // The half-filled path is the failure worth naming: the assists are there,
    // the directory mounts, and the CLI the agent came for is silently absent.
    await seedDeliveredTree();
    for (const rel of AGENT_KIT_REQUIRED_FILES) await fs.rm(path.join(agentKitDir(), rel));

    const err = await verifyDeliveredKit(agentKitDir()).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/FAILED delivery, not an empty directory/);
    expect(err?.message).toContain(AGENT_KIT_REQUIRED_FILES[0]);
  });

  it('counts a checkout with no assist entries as a FAILED delivery too', async () => {
    await seedDeliveredTree();
    await fs.rm(path.join(catalogDir(), 'alpha.md'));

    await expect(verifyDeliveredKit(agentKitDir())).rejects.toThrow(/carries no assist entries/);
  });
});

// The git delivery itself (#2908). These cases run the real `syncAssistCatalog()`
// against a local repo served over `file://`, because the behaviours worth
// pinning are the ones the mechanism only exhibits end to end: the sparse set
// being re-applied on an existing checkout, the legacy root being dropped, and
// a checkout that lands without the kit's own files being recorded as a FAILED
// delivery rather than served as a half-filled directory.
describe('git delivery of the agent kit (#2908)', () => {
  const run = promisify(execFile);
  const ORIGIN = '/tmp/sb-assist-delivery-test-origin';
  const KIT: Record<string, string> = {
    'assists/alpha.md': '---\ntitle: Alpha\nwhenToUse: when alpha\nkind: guide\n---\nbody\n',
    'agent-cli/servicebay.mjs': '#!/usr/bin/env node\n',
    'agent-docs/AGENTS.md': '# AGENTS\n',
  };

  async function makeOriginRepo(files: Record<string, string>): Promise<void> {
    await fs.rm(ORIGIN, { recursive: true, force: true });
    for (const [rel, body] of Object.entries(files)) {
      const file = path.join(ORIGIN, rel);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body, 'utf-8');
    }
    await run('git', ['init', '-q', '-b', 'main', ORIGIN]);
    // Without this a `--filter=blob:none` clone is refused and the code falls
    // back to a full clone; enabling it keeps the sparse path under test.
    await run('git', ['-C', ORIGIN, 'config', 'uploadpack.allowFilter', 'true']);
    await run('git', ['-C', ORIGIN, 'config', 'user.email', 'delivery@test.invalid']);
    await run('git', ['-C', ORIGIN, 'config', 'user.name', 'delivery test']);
    await run('git', ['-C', ORIGIN, 'add', '-A']);
    await run('git', ['-C', ORIGIN, 'commit', '-qm', 'kit']);
  }

  beforeEach(() => {
    process.env.ASSIST_CATALOG_REPO_URL = `file://${ORIGIN}`;
  });

  afterAll(async () => {
    delete process.env.ASSIST_CATALOG_REPO_URL;
    await fs.rm(ORIGIN, { recursive: true, force: true });
  });

  it('lands catalog, CLI and orientation in one checkout and records the commit', async () => {
    await makeOriginRepo(KIT);

    const result = await delivery.syncAssistCatalog();

    expect(result).toMatchObject({ status: 'synced', entryCount: 1, dir: catalogDir() });
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    for (const rel of AGENT_KIT_REQUIRED_FILES) {
      await expect(fs.access(path.join(agentKitDir(), rel))).resolves.toBeUndefined();
    }
    // …and the delivery now vouches for the tree, so the gate opens.
    await expect(resolveAgentKitDir()).resolves.toBe(agentKitDir());
    expect((await listAssists()).map(e => e.id)).toEqual(['alpha']);
    const status = await assistDeliveryStatus();
    expect(status.sha).toBe(result.sha);
    expect(status.lastError).toBeNull();
  });

  it('removes the pre-#2908 checkout root once the kit has landed, so no second tree ages beside it', async () => {
    const legacy = path.join(BASE, 'assist-catalog');
    await fs.mkdir(path.join(legacy, 'assists'), { recursive: true });
    await fs.writeFile(path.join(legacy, 'assists', 'stale.md'), 'old\n', 'utf-8');
    await makeOriginRepo(KIT);

    await expect(delivery.syncAssistCatalog()).resolves.toMatchObject({ status: 'synced' });

    await expect(fs.access(legacy)).rejects.toThrow();
  });

  it('re-applies the sparse set on a refresh, so a widened kit reaches an existing checkout', async () => {
    // The regression this pins: a checkout made before `agent-cli`/`agent-docs`
    // joined AGENT_KIT_SUBDIRS keeps its narrower set forever if the refresh
    // only fetches and resets — the fetch succeeds and the new dirs never
    // materialise, which is a half-filled kit that mounts fine.
    await makeOriginRepo(KIT);
    await expect(delivery.syncAssistCatalog()).resolves.toMatchObject({ status: 'synced' });
    await run('git', ['-C', agentKitDir(), 'sparse-checkout', 'set', 'assists']);
    await expect(fs.access(path.join(agentKitDir(), AGENT_KIT_REQUIRED_FILES[0]))).rejects.toThrow();

    await expect(delivery.syncAssistCatalog()).resolves.toMatchObject({ status: 'synced' });

    for (const rel of AGENT_KIT_REQUIRED_FILES) {
      await expect(fs.access(path.join(agentKitDir(), rel))).resolves.toBeUndefined();
    }
  });

  it('picks up a new assist on the second sync without re-cloning', async () => {
    await makeOriginRepo(KIT);
    const first = await delivery.syncAssistCatalog();
    await fs.writeFile(
      path.join(ORIGIN, 'assists', 'beta.md'),
      '---\ntitle: Beta\nwhenToUse: when beta\nkind: guide\n---\nbody\n',
      'utf-8',
    );
    await run('git', ['-C', ORIGIN, 'add', '-A']);
    await run('git', ['-C', ORIGIN, 'commit', '-qm', 'add beta']);

    const second = await delivery.syncAssistCatalog();

    expect(second).toMatchObject({ status: 'synced', entryCount: 2 });
    expect(second.sha).not.toBe(first.sha);
    expect((await listAssists()).map(e => e.id)).toEqual(['alpha', 'beta']);
  });

  it('records a checkout without the kit files as a FAILED delivery, and keeps the gate shut', async () => {
    // Half the kit is the dangerous shape: the assists are there, the directory
    // mounts, and the CLI the agent came for is silently absent.
    await makeOriginRepo({ 'assists/alpha.md': KIT['assists/alpha.md'] });

    const result = await delivery.syncAssistCatalog();

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/FAILED delivery, not an empty directory/);
    const status = await assistDeliveryStatus();
    expect(status.lastSuccessAt).toBeNull();
    expect(status.lastError).toMatch(/agent-cli\/servicebay\.mjs/);
    await expect(resolveCatalogDir()).rejects.toBeInstanceOf(AssistCatalogUnavailableError);
    await expect(resolveAgentKitDir()).rejects.toThrow(/never been delivered/i);
  });

  it('records a failed refresh without discarding the last successful delivery', async () => {
    await makeOriginRepo(KIT);
    const first = await delivery.syncAssistCatalog();
    const delivered = await assistDeliveryStatus();
    // The repo goes away under an existing checkout: the refresh fails, the
    // re-clone fails, and the whole attempt is a recorded failure.
    await fs.rm(ORIGIN, { recursive: true, force: true });

    const result = await delivery.syncAssistCatalog();

    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
    const status = await assistDeliveryStatus();
    expect(status.lastError).toBeTruthy();
    // One failed fetch does not rewrite history: what takes the catalog dark is
    // the freshness window, not a single unreachable moment.
    expect(status.lastSuccessAt).toBe(delivered.lastSuccessAt);
    expect(status.lastSuccessAt).toBeTruthy();
    expect(status.sha).toBe(first.sha);
  });

  it('treats a checkout with no catalog directory at all as a failed delivery', async () => {
    const bare = path.join(BASE, 'bare-checkout');
    await fs.mkdir(bare, { recursive: true });

    await expect(verifyDeliveredKit(bare)).rejects.toThrow(/carries no assist entries/);
  });

  it('short-circuits to an operator-supplied kit dir, with no sync and no freshness clock', async () => {
    const external = path.join(BASE, 'external', 'assists');
    process.env.ASSIST_CATALOG_DIR = external;
    try {
      // No delivery has ever run here, and that is fine: the operator said
      // where the one source is, so there is nothing to vouch for.
      await expect(delivery.syncAssistCatalog()).resolves.toMatchObject({ status: 'external', dir: external });
      await expect(resolveCatalogDir()).resolves.toBe(external);
      await expect(resolveAgentKitDir()).resolves.toBe(path.dirname(external));
      expect(await assistDeliveryStatus()).toMatchObject({ external: true, kitDir: path.dirname(external) });
    } finally {
      delete process.env.ASSIST_CATALOG_DIR;
    }
  });
});

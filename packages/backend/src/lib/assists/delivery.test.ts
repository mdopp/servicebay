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

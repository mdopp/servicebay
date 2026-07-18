import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Learning-proposal LANDING + secret-scan gate (#2326 slice 4).
//
// On approval, a clean proposal is written to `DATA_DIR/local-assists/<slug>.md`
// (status `landed`) and is then loadable via the catalog as id `local/<slug>`
// with `source: Local`. Content matching a known secret signature is REJECTED
// before it reaches disk (status `blocked`, no file). A not-yet-approved
// proposal never lands, and landing is idempotent.

const dirState = vi.hoisted(() => ({ dir: '/tmp/sb-proposals-landing-boot' }));

vi.mock('@/lib/dirs', () => ({
  get DATA_DIR() {
    return dirState.dir;
  },
}));

// Pin known built-in ids so submit's collision check is hermetic. Point the
// catalog at the same tmp DATA_DIR for its Local loader via process.cwd (the
// built-in dir is process.cwd()/assists; we chdir into the tmp dir so it is
// empty, and the loader reads local-assists from DATA_DIR).
vi.mock('@/lib/assists/catalog', async (orig) => {
  const actual = await orig<typeof import('@/lib/assists/catalog')>();
  return {
    ...actual,
    listBuiltinAssistIds: vi.fn().mockResolvedValue(['servicebay-overview']),
  };
});

import {
  submitProposal,
  approveProposal,
  rejectProposal,
  getProposal,
} from '@/lib/assists/proposals';
import { listAssists, getAssist } from '@/lib/assists/catalog';
import { DATA_DIR } from '@/lib/dirs';

/** The additive, namespaced landing dir the loader serves as `local/<slug>`. */
function landedDir() {
  return path.join(DATA_DIR, 'local-assists', 'landed');
}

const CLEAN = {
  title: 'A runtime companion recipe',
  whenToUse: 'When you want a runtime-only companion.',
  kind: 'recipe' as const,
  tags: ['companion', 'runtime'],
  body: '# Companion\n\nSome helpful markdown.\n',
};

// A body carrying a concrete ServiceBay token — a known secret signature.
const WITH_SECRET = {
  ...CLEAN,
  title: 'A leaky recipe',
  body: '# Leak\n\nUse token sb_abc123_ABCDEFGHIJKLMNOPQRSTUVWX to auth.\n',
};

let origCwd: string;

beforeEach(async () => {
  dirState.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-proposals-landing-'));
  origCwd = process.cwd();
  // Built-in dir = process.cwd()/assists; chdir into an empty tmp so no real
  // built-in shadows a local id in listAssists.
  process.chdir(dirState.dir);
  vi.clearAllMocks();
});
afterEach(async () => {
  process.chdir(origCwd);
  await fs.rm(dirState.dir, { recursive: true, force: true });
});

describe('learning-proposal landing (#2326 s4)', () => {
  it('an approved clean proposal is written under local-assists/ with status landed', async () => {
    const p = await submitProposal(CLEAN);
    const slug = p.assistId.replace(/^local\//, '');
    const outcome = await approveProposal(p.id, 'session:admin');
    expect(outcome.result).toBe('ok');

    const after = await getProposal(p.id);
    expect(after!.status).toBe('landed');
    expect(after!.landedFile).toBe(`${slug}.md`);

    const written = await fs.readFile(path.join(landedDir(), `${slug}.md`), 'utf-8');
    expect(written).toContain(`title: ${JSON.stringify(CLEAN.title)}`);
    expect(written).toContain(`kind: ${CLEAN.kind}`);
    expect(written).toContain('Some helpful markdown.');
  });

  it('the landed assist is loadable as id local/<slug> with source Local', async () => {
    const p = await submitProposal(CLEAN);
    const slug = p.assistId.replace(/^local\//, '');
    await approveProposal(p.id, 'session:admin');

    const list = await listAssists();
    const entry = list.find(a => a.id === `local/${slug}`);
    expect(entry).toBeTruthy();
    expect(entry!.source).toBe('Local');
    expect(entry!.title).toBe(CLEAN.title);

    const raw = await getAssist(`local/${slug}`);
    expect(raw).toContain('Some helpful markdown.');
  });

  it('a proposal whose content matches a secret signature is BLOCKED before disk', async () => {
    const p = await submitProposal(WITH_SECRET);
    const slug = p.assistId.replace(/^local\//, '');
    const outcome = await approveProposal(p.id, 'session:admin');
    // The outcome is still 'ok' (the store transition happened) but status is blocked.
    expect(outcome.result).toBe('ok');

    const after = await getProposal(p.id);
    expect(after!.status).toBe('blocked');
    expect(after!.landingError).toMatch(/secret/i);
    expect(after!.landingError).toMatch(/ServiceBay token/i);
    expect(after!.landedFile).toBeUndefined();

    // NOTHING written to disk.
    const files = await fs.readdir(landedDir()).catch(() => []);
    expect(files).toEqual([]);
    const raw = await getAssist(`local/${slug}`);
    expect(raw).toBeNull();
  });

  it('a rejected proposal never lands', async () => {
    const p = await submitProposal(CLEAN);
    await rejectProposal(p.id, 'session:admin');
    expect((await getProposal(p.id))!.status).toBe('rejected');
    const files = await fs.readdir(landedDir()).catch(() => []);
    expect(files).toEqual([]);
  });

  it('a not-yet-approved (pending) proposal cannot land', async () => {
    const p = await submitProposal(CLEAN);
    expect((await getProposal(p.id))!.status).toBe('pending');
    const files = await fs.readdir(landedDir()).catch(() => []);
    expect(files).toEqual([]);
  });

  it('landing is idempotent — re-approving a landed proposal does not duplicate or corrupt', async () => {
    const p = await submitProposal(CLEAN);
    const slug = p.assistId.replace(/^local\//, '');
    await approveProposal(p.id, 'session:admin');
    const firstBytes = await fs.readFile(path.join(landedDir(), `${slug}.md`), 'utf-8');

    // Re-approve: already landed -> not-pending, no-op.
    const again = await approveProposal(p.id, 'session:other');
    expect(again.result).toBe('not-pending');

    const files = await fs.readdir(landedDir());
    expect(files).toEqual([`${slug}.md`]); // exactly one file, no dupe
    const secondBytes = await fs.readFile(path.join(landedDir(), `${slug}.md`), 'utf-8');
    expect(secondBytes).toBe(firstBytes); // unchanged
    expect((await getProposal(p.id))!.status).toBe('landed');
  });
});

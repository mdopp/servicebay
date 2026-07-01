import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

// Point DATA_DIR at a fixed tmp base BEFORE catalog.ts (→ @/lib/dirs) evaluates,
// so LOCAL_ASSISTS_DIR resolves under our sandbox. Mirrors registry.local.test.ts.
const BASE = '/tmp/sb-assist-catalog-test';
vi.hoisted(() => {
  process.env.DATA_DIR = '/tmp/sb-assist-catalog-test';
});

import { listAssists, getAssist } from './catalog';

const BUILTIN = path.join(BASE, 'assists');
const LOCAL = path.join(BASE, 'local-assists');
let origCwd: string;

async function seed(dir: string, id: string, front: Record<string, string>, body = 'body') {
  const fm = Object.entries(front).map(([k, v]) => `${k}: ${v}`).join('\n');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.md`), `---\n${fm}\n---\n${body}\n`, 'utf-8');
}

beforeEach(async () => {
  await fs.rm(BASE, { recursive: true, force: true });
  await fs.mkdir(BUILTIN, { recursive: true });
  await fs.mkdir(LOCAL, { recursive: true });
  origCwd = process.cwd();
  process.chdir(BASE); // BUILTIN = process.cwd()/assists
});

afterEach(() => {
  process.chdir(origCwd);
});

afterAll(async () => {
  await fs.rm(BASE, { recursive: true, force: true });
});

describe('assist catalog', () => {
  it('lists built-in entries with parsed frontmatter', async () => {
    await seed(BUILTIN, 'alpha', { title: 'Alpha guide', whenToUse: 'when alpha', kind: 'guide', tags: '[a, b]' });
    const list = await listAssists();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'alpha', title: 'Alpha guide', kind: 'guide', source: 'Built-in' });
    expect(list[0].tags).toEqual(['a', 'b']);
  });

  it('local drop overrides built-in by id', async () => {
    await seed(BUILTIN, 'dup', { title: 'Built-in title', kind: 'guide' });
    await seed(LOCAL, 'dup', { title: 'Local title', kind: 'recipe' });
    const list = await listAssists();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Local title', kind: 'recipe', source: 'Local' });
  });

  it('ranks + filters by query', async () => {
    await seed(BUILTIN, 'deploy', { title: 'Deploy a service', whenToUse: 'deploy behind sso', kind: 'recipe' });
    await seed(BUILTIN, 'backup', { title: 'Backup restore', whenToUse: 'restore data', kind: 'guide' });
    const list = await listAssists({ query: 'deploy service' });
    expect(list.map(a => a.id)).toEqual(['deploy']);
  });

  it('filters by kind', async () => {
    await seed(BUILTIN, 'g', { title: 'G', kind: 'guide' });
    await seed(BUILTIN, 'f', { title: 'F', kind: 'footgun' });
    const list = await listAssists({ kind: 'footgun' });
    expect(list.map(a => a.id)).toEqual(['f']);
  });

  it('defaults title to id and kind to guide when frontmatter is thin', async () => {
    await fs.writeFile(path.join(BUILTIN, 'bare.md'), 'no frontmatter here\n', 'utf-8');
    const list = await listAssists();
    expect(list[0]).toMatchObject({ id: 'bare', title: 'bare', kind: 'guide' });
  });

  it('ignores dotfiles and non-markdown files', async () => {
    await seed(BUILTIN, 'real', { title: 'Real' });
    await fs.writeFile(path.join(BUILTIN, '.hidden.md'), '---\ntitle: Hidden\n---\n', 'utf-8');
    await fs.writeFile(path.join(BUILTIN, 'notes.txt'), 'nope', 'utf-8');
    const list = await listAssists();
    expect(list.map(a => a.id)).toEqual(['real']);
  });

  it('a missing source dir is a no-op', async () => {
    await fs.rm(LOCAL, { recursive: true, force: true }); // local gone
    await seed(BUILTIN, 'only', { title: 'Only' });
    const list = await listAssists();
    expect(list.map(a => a.id)).toEqual(['only']);
  });

  it('getAssist returns raw markdown (frontmatter + body), local winning', async () => {
    await seed(BUILTIN, 'x', { title: 'Built-in' }, 'built-in body');
    await seed(LOCAL, 'x', { title: 'Local' }, 'local body');
    const raw = await getAssist('x');
    expect(raw).toContain('title: Local');
    expect(raw).toContain('local body');
  });

  it('getAssist rejects traversal / unknown ids', async () => {
    expect(await getAssist('../catalog')).toBeNull();
    expect(await getAssist('..')).toBeNull();
    expect(await getAssist('a/b')).toBeNull();
    expect(await getAssist('does-not-exist')).toBeNull();
  });
});

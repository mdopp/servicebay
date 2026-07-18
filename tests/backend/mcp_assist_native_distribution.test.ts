import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Native MCP distribution of the assist catalog (#2326 slice 6):
//   - assists are exposed as MCP Resources (assist://<id>), list + read,
//     including landed local-assists, with `source` in the metadata;
//   - the curated actionable guides (kinds guide/recipe/checklist/adr) are
//     exposed as MCP Prompts that return the assist markdown;
//   - list_assists / get_assist tools stay unchanged (additive invariant).
//
// We test the catalog→MCP mapping data layer directly (the SDK's
// resource/prompt registration is awkward to drive through a full transport in
// a unit test; the mapping is where the real logic lives).

const dirState = vi.hoisted(() => ({ dir: '/tmp/sb-native-boot' }));

vi.mock('@/lib/dirs', () => ({
  get DATA_DIR() {
    return dirState.dir;
  },
}));

import {
  assistUri,
  assistIdFromUri,
  assistPromptName,
  assistResourceDescriptor,
  listAssistResources,
  readAssistResource,
  listPromptAssists,
  readAssistPrompt,
  PROMPT_ASSIST_KINDS,
  ASSIST_URI_SCHEME,
} from '@/lib/mcp/assistCatalog';
import { DATA_DIR } from '@/lib/dirs';

function builtinDir() {
  return path.join(dirState.dir, 'assists');
}
function landedDir() {
  return path.join(DATA_DIR, 'local-assists', 'landed');
}

async function writeAssist(
  dir: string,
  slug: string,
  opts: { title?: string; kind?: string; whenToUse?: string } = {},
) {
  await fs.mkdir(dir, { recursive: true });
  const title = opts.title ?? 'Test Assist';
  const kind = opts.kind ?? 'guide';
  const when = opts.whenToUse ?? 'When you need to test.';
  const content = `---
title: "${title}"
whenToUse: "${when}"
kind: ${kind}
tags: ["test"]
---
# ${title}

Body of ${slug}.
`;
  await fs.writeFile(path.join(dir, `${slug}.md`), content, 'utf-8');
}

let origCwd: string;

beforeEach(async () => {
  dirState.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-native-'));
  origCwd = process.cwd();
  // Built-in dir = process.cwd()/assists; chdir into the tmp dir so we control
  // the built-in catalog contents.
  process.chdir(dirState.dir);
  vi.clearAllMocks();
});

afterEach(async () => {
  process.chdir(origCwd);
  await fs.rm(dirState.dir, { recursive: true, force: true });
});

describe('assist URI helpers (#2326 s6)', () => {
  it('round-trips a bare id through assist://', () => {
    const uri = assistUri('servicebay-overview');
    expect(uri).toBe(`${ASSIST_URI_SCHEME}://servicebay-overview`);
    expect(assistIdFromUri(uri)).toBe('servicebay-overview');
    expect(assistIdFromUri(new URL(uri))).toBe('servicebay-overview');
  });

  it('round-trips a namespaced landed id (keeps the local/ path segment)', () => {
    const uri = assistUri('local/my-recipe');
    expect(assistIdFromUri(uri)).toBe('local/my-recipe');
  });

  it('returns null for a non-assist URI', () => {
    expect(assistIdFromUri('https://example.com/x')).toBeNull();
    expect(assistIdFromUri(`${ASSIST_URI_SCHEME}://`)).toBeNull();
  });

  it('flattens the slash in a prompt name', () => {
    expect(assistPromptName('servicebay-overview')).toBe('assist_servicebay-overview');
    expect(assistPromptName('local/my-recipe')).toBe('assist_local_my-recipe');
  });
});

describe('assist resources (#2326 s6)', () => {
  it('lists built-in assists AND a landed local-assist as resources', async () => {
    await writeAssist(builtinDir(), 'servicebay-overview', { title: 'ServiceBay Overview', kind: 'guide' });
    await writeAssist(landedDir(), 'my-landed-recipe', { title: 'My Landed Recipe', kind: 'recipe' });

    const { resources } = await listAssistResources();
    const byUri = new Map(resources.map(r => [r.uri, r]));

    // Built-in resource present.
    const builtin = byUri.get(assistUri('servicebay-overview'));
    expect(builtin).toBeDefined();
    expect(builtin!.name).toBe('servicebay-overview');
    expect(builtin!.mimeType).toBe('text/markdown');
    expect(builtin!.description).toContain('Built-in');
    expect((builtin!._meta as Record<string, unknown>).source).toBe('Built-in');

    // Landed local-assist present under its namespaced id + Local source.
    const landed = byUri.get(assistUri('local/my-landed-recipe'));
    expect(landed).toBeDefined();
    expect(landed!.name).toBe('local/my-landed-recipe');
    expect(landed!.description).toContain('Local');
    expect((landed!._meta as Record<string, unknown>).source).toBe('Local');
  });

  it('reflects a newly-landed local-assist dynamically (same loader as the tools)', async () => {
    const before = (await listAssistResources()).resources;
    expect(before.map(r => r.uri)).not.toContain(assistUri('local/fresh'));

    await writeAssist(landedDir(), 'fresh', { title: 'Fresh' });

    const after = (await listAssistResources()).resources;
    expect(after.map(r => r.uri)).toContain(assistUri('local/fresh'));
  });

  it('reads a resource and returns the assist markdown body', async () => {
    await writeAssist(builtinDir(), 'servicebay-overview', { title: 'ServiceBay Overview' });

    const result = await readAssistResource(new URL(assistUri('servicebay-overview')));
    expect(result.contents).toHaveLength(1);
    const c = result.contents[0] as { uri: string; mimeType?: string; text: string };
    expect(c.uri).toBe(assistUri('servicebay-overview'));
    expect(c.mimeType).toBe('text/markdown');
    expect(String(c.text)).toContain('Body of servicebay-overview.');
    expect(String(c.text)).toContain('title:');
  });

  it('reads a landed local-assist by its namespaced URI', async () => {
    await writeAssist(landedDir(), 'my-landed-recipe', { title: 'My Landed Recipe' });
    const result = await readAssistResource(new URL(assistUri('local/my-landed-recipe')));
    expect(String((result.contents[0] as { text: string }).text)).toContain('Body of my-landed-recipe.');
  });

  it('throws for an unknown assist id', async () => {
    await expect(readAssistResource(new URL(assistUri('does-not-exist')))).rejects.toThrow(/No assist found/);
  });

  it('descriptor carries source + kind in _meta', () => {
    const d = assistResourceDescriptor({
      id: 'x',
      title: 'X',
      whenToUse: 'when x',
      kind: 'footgun',
      tags: ['a'],
      source: 'Built-in',
    });
    expect(d.uri).toBe(assistUri('x'));
    expect(d.mimeType).toBe('text/markdown');
    expect((d._meta as Record<string, unknown>).source).toBe('Built-in');
    expect((d._meta as Record<string, unknown>).kind).toBe('footgun');
  });
});

describe('assist prompts (#2326 s6)', () => {
  it('exposes actionable-kind assists as prompts and excludes footgun/snippet', async () => {
    await writeAssist(builtinDir(), 'a-guide', { title: 'A Guide', kind: 'guide' });
    await writeAssist(builtinDir(), 'a-recipe', { title: 'A Recipe', kind: 'recipe' });
    await writeAssist(builtinDir(), 'a-checklist', { title: 'A Checklist', kind: 'checklist' });
    await writeAssist(builtinDir(), 'an-adr', { title: 'An ADR', kind: 'adr' });
    await writeAssist(builtinDir(), 'a-footgun', { title: 'A Footgun', kind: 'footgun' });
    await writeAssist(builtinDir(), 'a-snippet', { title: 'A Snippet', kind: 'snippet' });

    const prompts = await listPromptAssists();
    const ids = prompts.map(p => p.id).sort();
    expect(ids).toEqual(['a-checklist', 'a-guide', 'a-recipe', 'an-adr']);
    // footgun/snippet stay resources-only.
    expect(ids).not.toContain('a-footgun');
    expect(ids).not.toContain('a-snippet');
  });

  it('PROMPT_ASSIST_KINDS is the curated actionable subset', () => {
    expect([...PROMPT_ASSIST_KINDS].sort()).toEqual(['adr', 'checklist', 'guide', 'recipe']);
  });

  it('reads a prompt and returns the assist content as a user message', async () => {
    await writeAssist(builtinDir(), 'a-guide', { title: 'A Guide', kind: 'guide' });
    const result = await readAssistPrompt('a-guide');
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0];
    expect(msg.role).toBe('user');
    expect(msg.content.type).toBe('text');
    expect(String((msg.content as { text: string }).text)).toContain('Body of a-guide.');
  });

  it('includes a landed actionable local-assist as a prompt', async () => {
    await writeAssist(landedDir(), 'landed-recipe', { title: 'Landed Recipe', kind: 'recipe' });
    const prompts = await listPromptAssists();
    expect(prompts.map(p => p.id)).toContain('local/landed-recipe');
  });

  it('throws for an unknown prompt id', async () => {
    await expect(readAssistPrompt('nope')).rejects.toThrow(/No assist found/);
  });
});

describe('additive invariant: list_assists / get_assist tools unchanged (#2326 s6)', () => {
  it('the catalog tools remain read-scoped in TOOL_SCOPES (no new scope, additive)', async () => {
    const { TOOL_SCOPES } = await import('@/lib/mcp/server');
    expect(TOOL_SCOPES['list_assists']).toBe('read');
    expect(TOOL_SCOPES['get_assist']).toBe('read');
  });

  it('createMcpServer still constructs (tools + native resources) after s6', async () => {
    // A fresh server construction must not throw when the native resource/prompt
    // surface was added, and must expose the underlying McpServer for the
    // prompt-registration boundary.
    const { createMcpServer } = await import('@/lib/mcp/server');
    const server = createMcpServer();
    expect(server).toBeTruthy();
    expect(typeof server.__baseServer).toBe('object');
    // The list_assists / get_assist tools are still registered on the base
    // server's private registry (additive — s6 didn't remove them).
    const reg = (server.__baseServer as unknown as {
      _registeredTools: Record<string, unknown>;
    })._registeredTools;
    expect(reg).toHaveProperty('list_assists');
    expect(reg).toHaveProperty('get_assist');
  });
});

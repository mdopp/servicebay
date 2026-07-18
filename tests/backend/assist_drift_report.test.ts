import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Drift-report tool (#2326 slice 5): listAssistDrift compares
// DATA_DIR/local-assists/landed/ against the built-in assists/ directory and
// returns entries that are present as landed local-assists but have NO
// corresponding built-in (i.e. the promotion backlog).

const dirState = vi.hoisted(() => ({ dir: '/tmp/sb-drift-boot' }));

vi.mock('@/lib/dirs', () => ({
  get DATA_DIR() {
    return dirState.dir;
  },
}));

// The drift report's built-in check uses listBuiltinAssistIds (reads the real
// process.cwd()/assists dir). We keep it unmocked so we can control
// what the "built-in" dir contains by manipulating process.cwd() in each test.

import { listAssistDrift } from '@/lib/assists/catalog';
import { DATA_DIR } from '@/lib/dirs';

function landedDir() {
  return path.join(DATA_DIR, 'local-assists', 'landed');
}

/** Write a minimal valid assist markdown into a file. */
async function writeAssist(dir: string, slug: string, title = 'Test Assist') {
  await fs.mkdir(dir, { recursive: true });
  const content = `---
title: "${title}"
whenToUse: "When you need to test."
kind: guide
tags: ["test"]
---
# ${title}

Some body text.
`;
  await fs.writeFile(path.join(dir, `${slug}.md`), content, 'utf-8');
}

let origCwd: string;

beforeEach(async () => {
  dirState.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-drift-'));
  origCwd = process.cwd();
  // Built-in dir = process.cwd()/assists; chdir into an empty tmp so no real
  // built-in exists by default, and tests can seed it as needed.
  process.chdir(dirState.dir);
  vi.clearAllMocks();
});

afterEach(async () => {
  process.chdir(origCwd);
  await fs.rm(dirState.dir, { recursive: true, force: true });
});

describe('listAssistDrift (#2326 s5)', () => {
  it('returns empty when the landed dir is missing', async () => {
    const drift = await listAssistDrift();
    expect(drift).toEqual([]);
  });

  it('returns empty when the landed dir exists but is empty', async () => {
    await fs.mkdir(landedDir(), { recursive: true });
    const drift = await listAssistDrift();
    expect(drift).toEqual([]);
  });

  it('returns a landed local-assist that has no built-in counterpart', async () => {
    // No built-in assists/ dir — so any landed entry is drift.
    await writeAssist(landedDir(), 'my-new-recipe', 'My New Recipe');

    const drift = await listAssistDrift();

    expect(drift).toHaveLength(1);
    const entry = drift[0];
    expect(entry.id).toBe('local/my-new-recipe');
    expect(entry.title).toBe('My New Recipe');
    expect(entry.kind).toBe('guide');
    expect(entry.whenToUse).toBeTruthy();
    expect(Array.isArray(entry.tags)).toBe(true);
    expect(entry.promotionHint).toContain('assists/my-new-recipe.md');
  });

  it('omits a landed assist whose slug matches a built-in', async () => {
    // Seed a built-in with the SAME slug as the landed entry.
    const builtinDir = path.join(dirState.dir, 'assists');
    await writeAssist(builtinDir, 'my-new-recipe', 'My New Recipe (built-in)');
    await writeAssist(landedDir(), 'my-new-recipe', 'My New Recipe (landed)');

    const drift = await listAssistDrift();

    // The slug collides — nothing to promote.
    expect(drift).toHaveLength(0);
  });

  it('returns only the entries that lack a built-in counterpart (mixed set)', async () => {
    const builtinDir = path.join(dirState.dir, 'assists');
    // One built-in and two landed: one collides, one is new.
    await writeAssist(builtinDir, 'servicebay-overview', 'ServiceBay Overview');
    await writeAssist(landedDir(), 'servicebay-overview', 'ServiceBay Overview (landed)');
    await writeAssist(landedDir(), 'my-custom-guide', 'My Custom Guide');

    const drift = await listAssistDrift();

    // Only my-custom-guide is in the drift report.
    expect(drift).toHaveLength(1);
    expect(drift[0].id).toBe('local/my-custom-guide');
    expect(drift[0].title).toBe('My Custom Guide');
  });

  it('returns multiple new entries when none have built-in counterparts', async () => {
    await writeAssist(landedDir(), 'alpha-recipe', 'Alpha Recipe');
    await writeAssist(landedDir(), 'beta-guide', 'Beta Guide');

    const drift = await listAssistDrift();

    const ids = drift.map(e => e.id).sort();
    expect(ids).toEqual(['local/alpha-recipe', 'local/beta-guide']);
  });

  it('each entry carries a promotionHint referencing its slug', async () => {
    await writeAssist(landedDir(), 'footgun-example', 'Footgun Example');

    const drift = await listAssistDrift();

    expect(drift).toHaveLength(1);
    expect(drift[0].promotionHint).toContain('assists/footgun-example.md');
  });
});

describe('list_assist_drift tool scope', () => {
  it('list_assist_drift is registered as read-scoped in TOOL_SCOPES', async () => {
    const { TOOL_SCOPES } = await import('@/lib/mcp/server');
    expect(TOOL_SCOPES['list_assist_drift']).toBe('read');
  });
});

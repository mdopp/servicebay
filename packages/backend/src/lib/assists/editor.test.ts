/**
 * Assists editor (#2221) — validation + versioned history store unit tests.
 *
 * A fresh temp DATA_DIR per run isolates the local-assists tree. We drive the
 * REAL editor functions against real fs, and cross-check catalog precedence
 * (Local overrides Built-in) by pointing the built-in dir at a temp seed via a
 * cwd shim.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

// Computed with no module imports — vi.hoisted runs before import bindings init.
const { TMP } = vi.hoisted(() => ({
  TMP: `${process.env.TMPDIR || '/tmp'}/assists-editor-${process.pid}-${Date.now()}`,
}));
vi.mock('@/lib/dirs', () => ({ DATA_DIR: TMP }));

import {
  validateProposal,
  scanForSecret,
  safeAssistId,
  writeProposal,
  applyApproved,
  discardRejected,
  readHistory,
  readHistoryVersion,
  ProposalValidationError,
  type AssistProposalPayload,
} from './editor';

const LOCAL_DIR = () => path.join(TMP, 'local-assists');

function mkProposal(overrides: { title?: string; whenToUse?: string; kind?: string; body?: string } = {}): string {
  const title = overrides.title ?? 'My Assist';
  const whenToUse = overrides.whenToUse ?? 'When you need it';
  const kind = overrides.kind ?? 'guide';
  const body = overrides.body ?? 'Body text here.';
  const fm: string[] = ['---'];
  if (title !== '__omit__') fm.push(`title: ${title}`);
  if (whenToUse !== '__omit__') fm.push(`whenToUse: ${whenToUse}`);
  if (kind !== '__omit__') fm.push(`kind: ${kind}`);
  fm.push('---', '', body, '');
  return fm.join('\n');
}

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(TMP, { recursive: true });
});
afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe('safeAssistId', () => {
  it('accepts a plain id', () => {
    expect(safeAssistId('create-service')).toBe('create-service');
  });
  it('rejects traversal / separators / dots', () => {
    expect(safeAssistId('../etc/passwd')).toBeNull();
    expect(safeAssistId('a/b')).toBeNull();
    expect(safeAssistId('..')).toBeNull();
    expect(safeAssistId('.')).toBeNull();
    expect(safeAssistId('a\0b')).toBeNull();
    expect(safeAssistId('')).toBeNull();
  });
});

describe('validateProposal — required fields + kind', () => {
  it('accepts a well-formed proposal', () => {
    expect(() => validateProposal(mkProposal())).not.toThrow();
  });
  it('rejects a missing title', () => {
    expect(() => validateProposal(mkProposal({ title: '__omit__' }))).toThrow(ProposalValidationError);
    expect(() => validateProposal(mkProposal({ title: '__omit__' }))).toThrow(/title/);
  });
  it('rejects a missing whenToUse', () => {
    expect(() => validateProposal(mkProposal({ whenToUse: '__omit__' }))).toThrow(/whenToUse/);
  });
  it('rejects a missing kind', () => {
    expect(() => validateProposal(mkProposal({ kind: '__omit__' }))).toThrow(/kind/);
  });
  it('rejects an invalid kind', () => {
    expect(() => validateProposal(mkProposal({ kind: 'banana' }))).toThrow(/invalid kind/);
  });
  it('accepts snake_case when_to_use', () => {
    const raw = ['---', 'title: T', 'when_to_use: use it', 'kind: guide', '---', '', 'body'].join('\n');
    expect(() => validateProposal(raw)).not.toThrow();
  });
});

describe('secret scan', () => {
  const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
  it('flags a PEM private key', () => {
    expect(scanForSecret(PEM)).toBe('PEM private key');
  });
  it('flags an sb_ token and cloud tokens', () => {
    expect(scanForSecret('token sb_abcdef_ABCDEFGHIJKLMNOPQRSTUV here')).toMatch(/sb_/);
    expect(scanForSecret('AKIAABCDEFGHIJKLMNOP')).toMatch(/AWS/);
    expect(scanForSecret('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).toMatch(/GitHub/);
  });
  it('validateProposal rejects a PEM in the body', () => {
    const raw = mkProposal({ body: `intro\n${PEM}\noutro` });
    expect(() => validateProposal(raw)).toThrow(/secret/);
  });
  it('returns null for clean text', () => {
    expect(scanForSecret('just normal markdown, no keys')).toBeNull();
  });
});

describe('apply / reject / history mechanics', () => {
  const payload = (assistId: string, message = 'edit'): AssistProposalPayload => ({
    kind: 'assist-edit',
    assistId,
    message,
  });

  it('applyApproved writes the Local drop file and a history v1', async () => {
    const content = mkProposal({ title: 'V1' });
    await writeProposal('demo', 'req1', content);
    const version = await applyApproved(payload('demo', 'first'), 'req1', 'alice');
    expect(version).toBe(1);

    const local = await fs.readFile(path.join(LOCAL_DIR(), 'demo.md'), 'utf-8');
    expect(local).toBe(content);

    const hist = await readHistory('demo');
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ version: 1, author: 'alice', message: 'first' });
    expect(typeof hist[0].timestamp).toBe('string');

    // The pending proposal body is removed on apply.
    await expect(
      fs.access(path.join(LOCAL_DIR(), '.proposals', 'demo.req1.md')),
    ).rejects.toThrow();
  });

  it('history entries accumulate in version order', async () => {
    await writeProposal('demo', 'r1', mkProposal({ title: 'One' }));
    await applyApproved(payload('demo', 'one'), 'r1', 'a');
    await writeProposal('demo', 'r2', mkProposal({ title: 'Two' }));
    await applyApproved(payload('demo', 'two'), 'r2', 'b');
    await writeProposal('demo', 'r3', mkProposal({ title: 'Three' }));
    await applyApproved(payload('demo', 'three'), 'r3', 'c');

    const hist = await readHistory('demo');
    expect(hist.map(h => h.version)).toEqual([1, 2, 3]);
    expect(hist.map(h => h.message)).toEqual(['one', 'two', 'three']);

    // The index is genuine JSONL (one JSON object per line).
    const raw = await fs.readFile(path.join(LOCAL_DIR(), '.history', 'demo', 'index.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('readHistoryVersion returns the frozen content of that version', async () => {
    const c1 = mkProposal({ title: 'One' });
    await writeProposal('demo', 'r1', c1);
    await applyApproved(payload('demo'), 'r1', 'a');
    const c2 = mkProposal({ title: 'Two' });
    await writeProposal('demo', 'r2', c2);
    await applyApproved(payload('demo'), 'r2', 'a');

    expect(await readHistoryVersion('demo', 1)).toBe(c1);
    expect(await readHistoryVersion('demo', 2)).toBe(c2);
    expect(await readHistoryVersion('demo', 99)).toBeNull();
  });

  it('discardRejected removes the proposal and writes NO local file', async () => {
    await writeProposal('demo', 'r1', mkProposal());
    await discardRejected(payload('demo'), 'r1');
    // No Local override.
    await expect(fs.access(path.join(LOCAL_DIR(), 'demo.md'))).rejects.toThrow();
    // No history.
    expect(await readHistory('demo')).toEqual([]);
    // Proposal body gone.
    await expect(
      fs.access(path.join(LOCAL_DIR(), '.proposals', 'demo.r1.md')),
    ).rejects.toThrow();
  });

  it('applyApproved re-validates and refuses a secret-bearing body', async () => {
    const bad = mkProposal({ body: '-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----' });
    await writeProposal('demo', 'r1', bad);
    await expect(applyApproved(payload('demo'), 'r1', 'a')).rejects.toThrow(/secret/);
    // Nothing published.
    await expect(fs.access(path.join(LOCAL_DIR(), 'demo.md'))).rejects.toThrow();
  });
});

describe('catalog precedence — an approved proposal overrides the built-in', () => {
  it('listAssists + getAssist serve the Local entry after apply', async () => {
    // Seed a built-in assist under a temp cwd so catalog reads it as Built-in.
    const builtinRoot = path.join(TMP, 'app');
    const builtinAssists = path.join(builtinRoot, 'assists');
    await fs.mkdir(builtinAssists, { recursive: true });
    await fs.writeFile(
      path.join(builtinAssists, 'demo.md'),
      mkProposal({ title: 'Built-in title', body: 'builtin body' }),
      'utf-8',
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(builtinRoot);

    // Import catalog AFTER the DATA_DIR mock is in place (top-of-file mock).
    const { listAssists, getAssist } = await import('./catalog');

    // Before any local edit: built-in wins.
    let list = await listAssists();
    const beforeDemo = list.find(a => a.id === 'demo');
    expect(beforeDemo?.source).toBe('Built-in');
    expect(beforeDemo?.title).toBe('Built-in title');

    // Approve a local edit.
    const localContent = mkProposal({ title: 'Local override title', body: 'local body' });
    await writeProposal('demo', 'r1', localContent);
    await applyApproved({ kind: 'assist-edit', assistId: 'demo', message: 'override' }, 'r1', 'admin');

    // Now the Local entry overrides the built-in in list_assists.
    list = await listAssists();
    const afterDemo = list.find(a => a.id === 'demo');
    expect(afterDemo?.source).toBe('Local');
    expect(afterDemo?.title).toBe('Local override title');
    expect(await getAssist('demo')).toBe(localContent);

    cwdSpy.mockRestore();
  });
});

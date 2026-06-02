/**
 * Per-job log cap (#1098 Phase 2).
 *
 * A thrashing install can't unbound the per-job .log file: appendLog
 * stops persisting after `maxBytes` or `maxLines`, writing one
 * `[TRUNCATED]` marker and dropping subsequent lines silently. The
 * runner keeps running; we just stop preserving its chatter.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

vi.mock('@/lib/dirs', () => ({
  DATA_DIR: path.join(os.tmpdir(), `sb-jobstore-logcap-${process.pid}`),
}));

// Tight caps so the test doesn't have to spam thousands of writes.
const TEST_LIMITS = { maxJobLogLines: 5, maxJobLogBytes: 100 };

vi.mock('@/lib/config', async () => {
  const actual = await vi.importActual<typeof import('@/lib/config')>('@/lib/config');
  return {
    ...actual,
    getConfig: vi.fn(async () => ({ logging: TEST_LIMITS }) as never),
  };
});

const TEST_DIR = path.join(os.tmpdir(), `sb-jobstore-logcap-${process.pid}`);

import { createJob, appendLog, readLog, type JobInput } from './jobStore';

function mkInput(): JobInput {
  return {
    items: [],
    variables: [],
    wipeMode: 'install',
    templateSource: 'test',
    host: 'localhost',
  };
}

beforeEach(async () => {
  await fs.rm(path.join(TEST_DIR, 'install-jobs'), { recursive: true, force: true });
  await fs.mkdir(path.join(TEST_DIR, 'install-jobs'), { recursive: true });
});

describe('appendLog per-job cap (#1098)', () => {
  it('writes a [TRUNCATED] marker and drops further lines once maxLines is exceeded', async () => {
    const job = await createJob({ source: 'cap-lines', input: mkInput() });
    // maxJobLogLines = 5 → 6th append should be dropped + marker appears.
    for (let i = 0; i < 8; i++) await appendLog(job.id, `line ${i}`);
    const { content } = await readLog(job.id);
    const lines = content.split('\n').filter(Boolean);
    expect(lines.filter(l => l.startsWith('line ')).length).toBe(5);
    expect(lines.some(l => l.startsWith('[TRUNCATED:'))).toBe(true);
    expect(lines.some(l => l === 'line 5' || l === 'line 6' || l === 'line 7')).toBe(false);
  });

  it('writes a [TRUNCATED] marker once maxBytes is exceeded', async () => {
    const job = await createJob({ source: 'cap-bytes', input: mkInput() });
    // maxBytes=100. A 30-byte line × 4 = 120 → the 4th line triggers.
    for (let i = 0; i < 4; i++) await appendLog(job.id, 'x'.repeat(29));
    const { content } = await readLog(job.id);
    expect(content).toContain('[TRUNCATED:');
    // File size must not blow past the cap by more than the marker.
    expect(Buffer.byteLength(content, 'utf-8')).toBeLessThan(300);
  });

  it('emits exactly one [TRUNCATED] marker even after many further appends', async () => {
    const job = await createJob({ source: 'cap-once', input: mkInput() });
    for (let i = 0; i < 20; i++) await appendLog(job.id, `line ${i}`);
    const { content } = await readLog(job.id);
    const markerCount = (content.match(/\[TRUNCATED:/g) ?? []).length;
    expect(markerCount).toBe(1);
  });
});

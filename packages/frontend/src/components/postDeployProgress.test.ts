/**
 * postDeployProgress (#1288) — parses structured post-deploy progress lines
 * (jlog `{ts, level, tag, message, args:{percent, completed_mb, total_mb}}`)
 * out of the install-log tail so the card can render them on a bar.
 */
import { describe, it, expect } from 'vitest';
import { parsePostDeployProgressLine, latestPostDeployProgress } from './postDeployProgress';

const line = (obj: unknown) => JSON.stringify(obj);

describe('parsePostDeployProgressLine', () => {
  it('extracts percent + MB from an OSCAR ollama:pull progress line', () => {
    const p = parsePostDeployProgressLine(
      line({ ts: 1, level: 'info', tag: 'ollama:pull', message: 'pulling model', args: { percent: 42, completed_mb: 4200, total_mb: 10000 } }),
    );
    expect(p).toEqual({ tag: 'ollama:pull', message: 'pulling model', percent: 42, completedMb: 4200, totalMb: 10000 });
  });

  it('accepts a percent-only producer (no MB fields)', () => {
    const p = parsePostDeployProgressLine(line({ tag: 'seed', args: { percent: 12 } }));
    expect(p).toEqual({ tag: 'seed', message: undefined, percent: 12, completedMb: undefined, totalMb: undefined });
  });

  it('clamps percent into 0–100 and rounds', () => {
    expect(parsePostDeployProgressLine(line({ args: { percent: 142.6 } }))?.percent).toBe(100);
    expect(parsePostDeployProgressLine(line({ args: { percent: -5 } }))?.percent).toBe(0);
    expect(parsePostDeployProgressLine(line({ args: { percent: 33.4 } }))?.percent).toBe(33);
  });

  it('rejects plain log lines, non-JSON, and lines without args.percent', () => {
    expect(parsePostDeployProgressLine('🔑 Reusing 7 saved secrets')).toBeNull();
    expect(parsePostDeployProgressLine('Pulling image 1/3: ollama')).toBeNull();
    expect(parsePostDeployProgressLine('{ not json')).toBeNull();
    expect(parsePostDeployProgressLine(line({ tag: 'x', args: { completed_mb: 10 } }))).toBeNull();
    expect(parsePostDeployProgressLine(line({ tag: 'x', message: 'done' }))).toBeNull();
    expect(parsePostDeployProgressLine(line({ args: { percent: 'NaN' } }))).toBeNull();
  });
});

describe('latestPostDeployProgress', () => {
  it('returns the most recent progress event from the tail', () => {
    const logs = [
      line({ tag: 'ollama:pull', args: { percent: 10, completed_mb: 1000, total_mb: 10000 } }),
      'some interleaved log line',
      line({ tag: 'ollama:pull', args: { percent: 60, completed_mb: 6000, total_mb: 10000 } }),
      '✅ ollama deployed',
    ];
    expect(latestPostDeployProgress(logs)?.percent).toBe(60);
  });

  it('returns null when no line carries progress', () => {
    expect(latestPostDeployProgress(['a', 'b', '{}'])).toBeNull();
    expect(latestPostDeployProgress([])).toBeNull();
  });
});

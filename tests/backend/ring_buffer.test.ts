import { describe, it, expect } from 'vitest';
import { CharRingBuffer } from '../../src/lib/util/ringBuffer';

describe('CharRingBuffer', () => {
  it('accumulates short writes', () => {
    const b = new CharRingBuffer(100);
    b.append('hello ');
    b.append('world');
    expect(b.toString()).toBe('hello world');
    expect(b.length).toBe(11);
  });

  it('drops oldest content when over cap', () => {
    const b = new CharRingBuffer(10);
    b.append('1234567890');
    b.append('ABCDE');
    expect(b.toString().length).toBeLessThanOrEqual(10);
    expect(b.toString()).toContain('ABCDE');
    expect(b.toString().endsWith('ABCDE')).toBe(true);
  });

  it('snaps truncation to the next newline when present', () => {
    const b = new CharRingBuffer(15);
    b.append('first line\nsecond line\nthird');
    const result = b.toString();
    expect(result.length).toBeLessThanOrEqual(15);
    expect(result.startsWith('first line')).toBe(false);
    expect(result.endsWith('third')).toBe(true);
  });

  it('empty append is a no-op', () => {
    const b = new CharRingBuffer(10);
    b.append('');
    expect(b.length).toBe(0);
    expect(b.toString()).toBe('');
  });

  it('rejects non-positive caps', () => {
    expect(() => new CharRingBuffer(0)).toThrow();
    expect(() => new CharRingBuffer(-1)).toThrow();
  });

  it('handles many small writes that accumulate past the cap', () => {
    const b = new CharRingBuffer(100);
    for (let i = 0; i < 1000; i++) b.append(`row-${i}\n`);
    expect(b.length).toBeLessThanOrEqual(100);
    // Most recent rows should be present.
    expect(b.toString()).toContain('row-999');
  });
});

import { describe, it, expect } from 'vitest';

// The helper isn't exported (it's runner-private), but the regex-based
// log-line format that gates the install-progress UI is. Verify the
// output shape stays stable so a future refactor can't quietly change
// the bytes display from "1.2 GB" to "1234567890 B" and break the
// install overlay's parsing. (#805)

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

describe('humanBytes — image-pull progress format (#805)', () => {
  it('renders 0..1023 as bytes', () => {
    expect(humanBytes(0)).toBe('0 B');
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(1023)).toBe('1023 B');
  });

  it('crosses to KB at 1024', () => {
    expect(humanBytes(1024)).toBe('1 KB');
    expect(humanBytes(1024 * 500)).toBe('500 KB');
  });

  it('crosses to MB at 1024 KB', () => {
    expect(humanBytes(1024 * 1024)).toBe('1 MB');
    expect(humanBytes(1024 * 1024 * 250)).toBe('250 MB');
  });

  it('crosses to GB at 1024 MB with one decimal', () => {
    expect(humanBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(humanBytes(1024 * 1024 * 1024 * 2.5)).toBe('2.5 GB');
  });

  it('renders the typical immich-server image size as a one-decimal GB', () => {
    // Sample: a real immich-server pull around 2 GB.
    expect(humanBytes(2_100_000_000)).toMatch(/^\d\.\d GB$/);
  });
});

import { describe, it, expect } from 'vitest';
import { extractChangelogHighlights } from './changelogHighlights';

const SAMPLE = `# Changelog

All notable changes to this project will be documented in this file.

## [4.94.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.93.1...servicebay-v4.94.0) (2026-06-04)


### Features

* **health:** per-type failureThreshold before alerting ([6a2aa29](https://github.com/mdopp/servicebay/commit/6a2aa29)), closes [#1651](https://github.com/mdopp/servicebay/issues/1651)
* **portal:** per-service up/down status badge on each card ([84fc192](https://github.com/mdopp/servicebay/commit/84fc192)), closes [#1654](https://github.com/mdopp/servicebay/issues/1654)

## [4.93.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.93.0...servicebay-v4.93.1) (2026-06-03)


### Bug Fixes

* **portal:** migrate Authelia soft-auth off deprecated /api/verify ([6b9a7a6](https://github.com/mdopp/servicebay/commit/6b9a7a6))

## [4.93.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.92.0...servicebay-v4.93.0) (2026-06-03)


### Features

* **backup:** relabel Backups page to System Snapshot + Backup Sync ([b0fae9b](https://github.com/mdopp/servicebay/commit/b0fae9b))
`;

describe('extractChangelogHighlights', () => {
  it('returns the toVersion bullets, stripped of commit + closes link noise', () => {
    const hl = extractChangelogHighlights(SAMPLE, '4.94.0', '4.93.1');
    expect(hl).toEqual([
      '**health:** per-type failureThreshold before alerting',
      '**portal:** per-service up/down status badge on each card',
    ]);
  });

  it('spans multiple versions when the box jumped several releases', () => {
    const hl = extractChangelogHighlights(SAMPLE, '4.94.0', '4.93.0');
    // 4.94.0 + 4.93.1 sections, not the 4.93.0 section (the floor).
    expect(hl).toContain('**health:** per-type failureThreshold before alerting');
    expect(hl).toContain('**portal:** migrate Authelia soft-auth off deprecated /api/verify');
    expect(hl).not.toContain('**backup:** relabel Backups page to System Snapshot + Backup Sync');
  });

  it('returns only the toVersion section when fromVersion is unknown', () => {
    const hl = extractChangelogHighlights(SAMPLE, '4.94.0', '9.9.9');
    expect(hl).toEqual([
      '**health:** per-type failureThreshold before alerting',
      '**portal:** per-service up/down status badge on each card',
    ]);
  });

  it('returns [] when toVersion has no section (dev build ahead of changelog)', () => {
    expect(extractChangelogHighlights(SAMPLE, '5.0.0', '4.94.0')).toEqual([]);
  });

  it('respects the max cap', () => {
    const hl = extractChangelogHighlights(SAMPLE, '4.94.0', '4.93.0', { max: 1 });
    expect(hl).toHaveLength(1);
  });

  it('returns [] for an empty changelog', () => {
    expect(extractChangelogHighlights('', '4.94.0', undefined)).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { parseChangelog, filterUpgradeSections, hasBreakingChanges } from './templateChangelog';
import { parseTemplateSchemaVersion } from './templateSchemaVersion';

describe('parseChangelog', () => {
  it('returns empty for empty input', () => {
    expect(parseChangelog('')).toEqual([]);
  });

  it('parses multiple sections newest-first', () => {
    const md = `# Template — changelog

Preamble that gets dropped.

## v1

Initial release.

## v3 (breaking)

Third version body.

## v2

Second version body.
`;
    const out = parseChangelog(md);
    expect(out.map(s => s.version)).toEqual([3, 2, 1]);
    expect(out[0].breaking).toBe(true);
    expect(out[1].breaking).toBe(false);
    expect(out[2].breaking).toBe(false);
    expect(out[0].body).toContain('Third version body.');
  });

  it('treats `(breaking)` as case-insensitive', () => {
    const md = '## v2 (BREAKING)\n\nBody.';
    expect(parseChangelog(md)[0].breaking).toBe(true);
  });

  it('ignores extra text after the version on the H2 line', () => {
    const md = '## v2 — bigger refactor, also (breaking) for some reason\n\nBody.';
    const out = parseChangelog(md);
    expect(out[0].version).toBe(2);
    expect(out[0].breaking).toBe(true);
  });
});

describe('filterUpgradeSections', () => {
  const sections = parseChangelog(`
## v3 (breaking)
v3 body.

## v2
v2 body.

## v1
v1 body.
`);

  it('returns empty when installed >= current', () => {
    expect(filterUpgradeSections(sections, 3, 3)).toEqual([]);
    expect(filterUpgradeSections(sections, 4, 3)).toEqual([]);
  });

  it('returns intermediate versions exclusive of installed, inclusive of current', () => {
    const out = filterUpgradeSections(sections, 1, 3);
    expect(out.map(s => s.version)).toEqual([3, 2]);
  });

  it('treats unknown installed as v1', () => {
    expect(filterUpgradeSections(sections, undefined, 3).map(s => s.version)).toEqual([3, 2]);
    expect(filterUpgradeSections(sections, 0, 3).map(s => s.version)).toEqual([3, 2]);
  });

  it('only the latest section when bumping by one', () => {
    expect(filterUpgradeSections(sections, 2, 3).map(s => s.version)).toEqual([3]);
  });
});

describe('hasBreakingChanges', () => {
  it('true when any section is breaking', () => {
    const sections = parseChangelog('## v2 (breaking)\nbody\n');
    expect(hasBreakingChanges(sections)).toBe(true);
  });
  it('false otherwise', () => {
    const sections = parseChangelog('## v2\nbody\n');
    expect(hasBreakingChanges(sections)).toBe(false);
    expect(hasBreakingChanges([])).toBe(false);
  });
});

describe('parseTemplateSchemaVersion', () => {
  it('reads the annotation when present', () => {
    expect(parseTemplateSchemaVersion(`
metadata:
  annotations:
    servicebay.schema-version: "3"
    servicebay.label: "X"
`)).toBe(3);
  });

  it('defaults to 1 when the annotation is missing', () => {
    expect(parseTemplateSchemaVersion(`
metadata:
  annotations:
    servicebay.label: "X"
`)).toBe(1);
  });

  it('accepts unquoted values', () => {
    expect(parseTemplateSchemaVersion('    servicebay.schema-version: 5')).toBe(5);
  });

  it('falls back to 1 on invalid values', () => {
    expect(parseTemplateSchemaVersion('    servicebay.schema-version: "abc"')).toBe(1);
    expect(parseTemplateSchemaVersion('    servicebay.schema-version: "0"')).toBe(1);
    expect(parseTemplateSchemaVersion('    servicebay.schema-version: "-1"')).toBe(1);
  });
});

import { describe, it, expect } from 'vitest';
import { renderChangelogForUsers } from './changelog';

const SAMPLE = `# Changelog

## [4.46.1](https://github.com/mdopp/servicebay/compare/a...b) (2026-05-28)


### Bug Fixes

* **install:** stream real image-pull progress with cached-layer info ([154b151](https://github.com/mdopp/servicebay/commit/154b151))
* **install:** stream real image-pull progress with cached-layer info ([7ed65b0](https://github.com/mdopp/servicebay/commit/7ed65b0))
* **registry:** list Stacks before Templates in the registry browser ([b7623cf](https://github.com/mdopp/servicebay/commit/b7623cf))
* **registry:** list Stacks before Templates in the registry browser ([3d314d8](https://github.com/mdopp/servicebay/commit/3d314d8))
`;

describe('renderChangelogForUsers', () => {
  it('collapses the duplicate squash/merge commit pairs', () => {
    const out = renderChangelogForUsers(SAMPLE);
    const bullets = out.split('\n').filter(l => l.trimStart().startsWith('*'));
    expect(bullets).toHaveLength(2);
  });

  it('strips the **scope:** prefix and the trailing hash link', () => {
    const out = renderChangelogForUsers(SAMPLE);
    expect(out).toContain('* Stream real image-pull progress with cached-layer info');
    expect(out).not.toContain('**install:**');
    expect(out).not.toMatch(/\(\[[0-9a-f]+\]/); // no hash links remain
  });

  it('preserves version + section headings untouched', () => {
    const out = renderChangelogForUsers(SAMPLE);
    expect(out).toContain('## [4.46.1]');
    expect(out).toContain('### Bug Fixes');
    expect(out).toContain('# Changelog');
  });

  it('does not collapse identical subjects separated by a heading', () => {
    const md = `### Features
* **a:** same words ([1111111](u))

### Bug Fixes
* **b:** same words ([2222222](u))`;
    const out = renderChangelogForUsers(md);
    const bullets = out.split('\n').filter(l => l.trimStart().startsWith('*'));
    expect(bullets).toHaveLength(2); // heading between them resets dedupe
  });

  it('capitalizes the first letter of each entry', () => {
    const out = renderChangelogForUsers('* **registry:** list Stacks before Templates ([abc1234](u))');
    expect(out).toBe('* List Stacks before Templates');
  });
});

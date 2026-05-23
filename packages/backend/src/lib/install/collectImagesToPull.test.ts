import { describe, it, expect } from 'vitest';
import { collectImagesToPull } from './runner';

describe('collectImagesToPull', () => {
  it('extracts unique image refs from item yaml', () => {
    const items = [
      {
        name: 'a',
        yaml: 'spec:\n  containers:\n  - image: docker.io/foo/bar:1.2.3\n    name: bar\n',
      },
      {
        name: 'b',
        yaml: 'containers:\n  - image: ghcr.io/baz/qux:latest\n',
      },
    ];
    expect(collectImagesToPull(items)).toEqual([
      'docker.io/foo/bar:1.2.3',
      'ghcr.io/baz/qux:latest',
    ]);
  });

  it('de-duplicates images referenced by multiple items', () => {
    const items = [
      { name: 'a', yaml: '  image: nginx:1.25' },
      { name: 'b', yaml: '  image: nginx:1.25' },
    ];
    expect(collectImagesToPull(items)).toEqual(['nginx:1.25']);
  });

  it('skips items flagged alreadyInstalled', () => {
    const items = [
      { name: 'a', yaml: '  image: a:1', alreadyInstalled: true },
      { name: 'b', yaml: '  image: b:1' },
    ];
    expect(collectImagesToPull(items)).toEqual(['b:1']);
  });

  it('skips items with no yaml', () => {
    const items = [
      { name: 'a' },
      { name: 'b', yaml: '  image: b:1' },
    ];
    expect(collectImagesToPull(items)).toEqual(['b:1']);
  });

  it('handles initContainers and sidecar definitions', () => {
    const yaml = [
      'spec:',
      '  initContainers:',
      '  - image: busybox:1.36',
      '  containers:',
      '  - image: nginx:1.25',
      '  - image: redis:7',
    ].join('\n');
    expect(collectImagesToPull([{ name: 'a', yaml }])).toEqual([
      'busybox:1.36',
      'nginx:1.25',
      'redis:7',
    ]);
  });

  it('ignores commented-out lines and `image:` substrings in env values', () => {
    const yaml = [
      '# image: ghost:1',
      'env:',
      '  IMAGE_NAME: not-a-pull',
      'containers:',
      '  - image: real/image:1   # trailing comment',
    ].join('\n');
    expect(collectImagesToPull([{ name: 'a', yaml }])).toEqual(['real/image:1']);
  });

  it('returns an empty array for empty input', () => {
    expect(collectImagesToPull([])).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import {
  detectHostArch,
  parseStreamImages,
  buildChoices,
  defaultChoiceIndex,
  downloadCommand,
  type IsoChoice,
} from './isoPicker';

describe('detectHostArch', () => {
  it('passes x86_64 through', () => {
    expect(detectHostArch('x86_64')).toBe('x86_64');
  });

  it('normalises arm64/aarch64 to aarch64', () => {
    expect(detectHostArch('aarch64')).toBe('aarch64');
    expect(detectHostArch('arm64')).toBe('aarch64');
  });

  it('echoes anything unrecognised unchanged', () => {
    expect(detectHostArch('riscv64')).toBe('riscv64');
  });
});

describe('parseStreamImages', () => {
  const stream = {
    architectures: {
      x86_64: {
        artifacts: {
          metal: {
            release: '40.20240101.3.0',
            formats: { iso: { disk: { location: 'https://example/x86.iso' } } },
          },
        },
      },
      aarch64: {
        artifacts: {
          metal: {
            release: '40.20240101.3.0',
            formats: { iso: { disk: { location: 'https://example/arm.iso' } } },
          },
        },
      },
    },
  };

  it('extracts arch/release/location per architecture', () => {
    expect(parseStreamImages(stream)).toEqual([
      { arch: 'x86_64', release: '40.20240101.3.0', location: 'https://example/x86.iso' },
      { arch: 'aarch64', release: '40.20240101.3.0', location: 'https://example/arm.iso' },
    ]);
  });

  it('skips an arch missing a metal ISO artifact rather than throwing', () => {
    const partial = {
      architectures: {
        x86_64: { artifacts: { metal: { release: 'r', formats: { iso: { disk: { location: 'u' } } } } } },
        s390x: { artifacts: {} },
      },
    };
    expect(parseStreamImages(partial)).toEqual([{ arch: 'x86_64', release: 'r', location: 'u' }]);
  });

  it('returns [] for malformed or empty input', () => {
    expect(parseStreamImages(null)).toEqual([]);
    expect(parseStreamImages({})).toEqual([]);
    expect(parseStreamImages({ architectures: 'nope' })).toEqual([]);
  });
});

describe('buildChoices', () => {
  it('lists local ISOs first, then remote builds, marking the host arch', () => {
    const choices = buildChoices({
      localIsos: [{ path: '/b/old.iso', name: 'old.iso', date: '2024-01-01' }],
      remote: [
        {
          stream: 'stable',
          images: [
            { arch: 'x86_64', release: 'r1', location: 'u1' },
            { arch: 'aarch64', release: 'r1', location: 'u2' },
          ],
        },
      ],
      hostArch: 'x86_64',
    });
    expect(choices.map(c => c.kind)).toEqual(['local', 'remote', 'remote']);
    expect(choices[0].path).toBe('/b/old.iso');
    expect(choices[1]).toMatchObject({ stream: 'stable', arch: 'x86_64', location: 'u1', isHostArch: true });
    expect(choices[2].isHostArch).toBe(false);
    expect(choices[1].label).toContain('← host arch');
  });
});

describe('defaultChoiceIndex', () => {
  const remote = (stream: 'stable' | 'testing', arch: string): IsoChoice => ({
    kind: 'remote',
    label: `${stream} ${arch}`,
    stream,
    arch,
  });

  it('prefers the first local ISO', () => {
    const choices: IsoChoice[] = [remote('stable', 'x86_64'), { kind: 'local', label: 'l', path: '/x' }];
    expect(defaultChoiceIndex(choices, 'x86_64')).toBe(1);
  });

  it('falls back to the stable build for the host arch when no local ISO', () => {
    const choices = [remote('testing', 'x86_64'), remote('stable', 'aarch64'), remote('stable', 'x86_64')];
    expect(defaultChoiceIndex(choices, 'x86_64')).toBe(2);
  });

  it('falls back to the first choice when nothing better matches', () => {
    const choices = [remote('testing', 'aarch64'), remote('testing', 'x86_64')];
    expect(defaultChoiceIndex(choices, 's390x')).toBe(0);
  });

  it('returns -1 for an empty list', () => {
    expect(defaultChoiceIndex([], 'x86_64')).toBe(-1);
  });
});

describe('downloadCommand', () => {
  it('builds the coreos-installer metal-iso download argv', () => {
    expect(downloadCommand('next', 'aarch64', '/build/fcos')).toEqual({
      cmd: 'coreos-installer',
      args: ['download', '-s', 'next', '-a', 'aarch64', '-p', 'metal', '-f', 'iso', '-C', '/build/fcos'],
    });
  });
});

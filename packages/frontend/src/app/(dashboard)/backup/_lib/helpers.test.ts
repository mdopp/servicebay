/**
 * Pure helpers for the Backup app (moved out of Settings IA in #1958).
 * These are the data-shaping functions behind the backup file browser
 * (categorization, per-service grouping, byte/language formatting).
 */
import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  groupServiceDataFiles,
  groupFilesByService,
  resolveFilePreviewLanguage,
} from './helpers';

describe('formatBytes', () => {
  it('returns 0 B for non-positive or non-finite input', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });

  it('keeps small values in bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('scales up through the unit ladder', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
  });

  it('drops fractional precision once the value reaches 10', () => {
    // 15 KB -> value 15 >= 10 -> 0 decimals
    expect(formatBytes(15 * 1024)).toBe('15 KB');
    // 1.5 KB -> value 1.5 < 10 -> 1 decimal
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('clamps at the largest unit (TB) for very large values', () => {
    expect(formatBytes(1024 ** 5)).toBe('1024 TB');
  });
});

describe('groupServiceDataFiles', () => {
  it('categorizes files and returns them in canonical order', () => {
    const result = groupServiceDataFiles([
      'svc/logs/app.log',
      'svc/config.json',
      'svc/data/store.sqlite',
      'svc/letsencrypt/fullchain.pem',
      'svc/random.bin',
    ]);
    expect(result.map(g => g.category)).toEqual(['config', 'certs', 'data', 'logs', 'other']);
  });

  it('omits categories with no members', () => {
    const result = groupServiceDataFiles(['svc/config.json']);
    expect(result).toEqual([{ category: 'config', files: ['svc/config.json'] }]);
  });

  it('classifies nginx proxy-host confs as config', () => {
    const [group] = groupServiceDataFiles(['nginx/proxy_host/1.conf']);
    expect(group.category).toBe('config');
  });

  it('classifies cert extensions and db dirs', () => {
    expect(groupServiceDataFiles(['x/server.crt'])[0].category).toBe('certs');
    expect(groupServiceDataFiles(['x/database/dump'])[0].category).toBe('data');
  });

  it('falls back to other for unknown files', () => {
    expect(groupServiceDataFiles(['x/payload.bin'])[0].category).toBe('other');
  });

  it('returns empty array for no files', () => {
    expect(groupServiceDataFiles([])).toEqual([]);
  });
});

describe('groupFilesByService', () => {
  const f = (fileName: string) => ({ relativePath: `stacks/${fileName}`, fileName });

  it('derives the service name from quadlet filename stems', () => {
    const result = groupFilesByService([
      f('immich-server.container'),
      f('media.kube'),
      f('immich-redis.container'),
    ]);
    const services = result.map(g => g.service);
    expect(services).toContain('immich');
    expect(services).toContain('media');
    const immich = result.find(g => g.service === 'immich')!;
    expect(immich.files).toHaveLength(2);
  });

  it('strips a leading dotted segment from the stem', () => {
    const [group] = groupFilesByService([f('foo.bar.container')]);
    expect(group.service).toBe('foo');
  });

  it('buckets non-quadlet files under _other and sorts it last', () => {
    const result = groupFilesByService([f('notes.txt'), f('app.container')]);
    expect(result[result.length - 1].service).toBe('_other');
  });

  it('sorts services alphabetically', () => {
    const result = groupFilesByService([f('zebra.kube'), f('alpha.kube')]);
    expect(result.map(g => g.service)).toEqual(['alpha', 'zebra']);
  });
});

describe('resolveFilePreviewLanguage', () => {
  it('maps known extensions to syntax languages', () => {
    expect(resolveFilePreviewLanguage('a.yml')).toBe('yaml');
    expect(resolveFilePreviewLanguage('a.yaml')).toBe('yaml');
    expect(resolveFilePreviewLanguage('a.kube')).toBe('ini');
    expect(resolveFilePreviewLanguage('a.container')).toBe('ini');
    expect(resolveFilePreviewLanguage('a.pod')).toBe('ini');
    expect(resolveFilePreviewLanguage('a.network')).toBe('ini');
    expect(resolveFilePreviewLanguage('a.volume')).toBe('ini');
    expect(resolveFilePreviewLanguage('a.json')).toBe('json');
    expect(resolveFilePreviewLanguage('a.sh')).toBe('bash');
  });

  it('defaults to bash for unknown extensions', () => {
    expect(resolveFilePreviewLanguage('a.txt')).toBe('bash');
    expect(resolveFilePreviewLanguage('noext')).toBe('bash');
  });
});

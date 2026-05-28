import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveBasicSyncApkUrl,
  isBasicSyncAbi,
  DEFAULT_BASICSYNC_ABI,
  __resetBasicSyncCache,
} from './basicSync';

vi.mock('../logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const RELEASE = {
  tag_name: 'v1.30',
  assets: [
    { name: 'BasicSync-1.30-arm64-v8a-release.apk', browser_download_url: 'https://gh/arm64-v8a.apk' },
    { name: 'BasicSync-1.30-armeabi-v7a-release.apk', browser_download_url: 'https://gh/armeabi-v7a.apk' },
    { name: 'BasicSync-1.30-x86-release.apk', browser_download_url: 'https://gh/x86.apk' },
    { name: 'BasicSync-1.30-x86_64-release.apk', browser_download_url: 'https://gh/x86_64.apk' },
    { name: 'mapping.txt.zst', browser_download_url: 'https://gh/mapping' },
  ],
};

function stubFetch(release: unknown, ok = true, status = 200) {
  const f = vi.fn(async () => ({ ok, status, json: async () => release }));
  vi.stubGlobal('fetch', f);
  return f;
}

beforeEach(() => __resetBasicSyncCache());
afterEach(() => vi.unstubAllGlobals());

describe('resolveBasicSyncApkUrl', () => {
  it('resolves the arm64-v8a APK', async () => {
    stubFetch(RELEASE);
    expect(await resolveBasicSyncApkUrl('arm64-v8a')).toBe('https://gh/arm64-v8a.apk');
  });

  it('matches x86 without picking up the x86_64 asset (endsWith guard)', async () => {
    stubFetch(RELEASE);
    expect(await resolveBasicSyncApkUrl('x86')).toBe('https://gh/x86.apk');
    expect(await resolveBasicSyncApkUrl('x86_64')).toBe('https://gh/x86_64.apk');
  });

  it('caches the release — a second resolve does not re-fetch', async () => {
    const f = stubFetch(RELEASE);
    await resolveBasicSyncApkUrl('arm64-v8a');
    await resolveBasicSyncApkUrl('x86_64');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('returns null when no asset matches the ABI', async () => {
    stubFetch({ tag_name: 'v1.30', assets: [{ name: 'mapping.txt.zst', browser_download_url: 'x' }] });
    expect(await resolveBasicSyncApkUrl('arm64-v8a')).toBeNull();
  });

  it('returns null on an API error with nothing cached', async () => {
    stubFetch({}, false, 502);
    expect(await resolveBasicSyncApkUrl('arm64-v8a')).toBeNull();
  });
});

describe('isBasicSyncAbi / default', () => {
  it('accepts known ABIs, rejects others', () => {
    expect(isBasicSyncAbi('arm64-v8a')).toBe(true);
    expect(isBasicSyncAbi('mips')).toBe(false);
    expect(isBasicSyncAbi(null)).toBe(false);
  });
  it('defaults to arm64-v8a', () => {
    expect(DEFAULT_BASICSYNC_ABI).toBe('arm64-v8a');
  });
});

/**
 * Resolve the download URL for the latest BasicSync APK (an actively
 * maintained Android Syncthing client, https://github.com/chenxiaolong/BasicSync).
 *
 * BasicSync's release assets embed the version in their filename
 * (`BasicSync-1.30-arm64-v8a-release.apk`), so GitHub's stable
 * `releases/latest/download/<name>` permalink can't target them. We resolve
 * the per-ABI asset at request time via the releases API instead, so a link
 * never pins a stale version — "latest for the platform".
 */
import { logger } from '../logger';

const REPO = 'chenxiaolong/BasicSync';

/** ABIs BasicSync ships an APK for. `arm64-v8a` covers effectively every
 *  phone from the last several years; the rest are for older / x86 devices. */
export const BASICSYNC_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'] as const;
export type BasicSyncAbi = (typeof BASICSYNC_ABIS)[number];
export const DEFAULT_BASICSYNC_ABI: BasicSyncAbi = 'arm64-v8a';

export function isBasicSyncAbi(value: string | null | undefined): value is BasicSyncAbi {
  return !!value && (BASICSYNC_ABIS as readonly string[]).includes(value);
}

interface GithubAsset { name: string; browser_download_url: string }
interface GithubRelease { tag_name?: string; assets?: GithubAsset[] }

// GitHub's unauthenticated API allows only ~60 requests/hr per IP, and a
// download-redirect endpoint can be hit far more often, so cache the
// latest-release lookup. 1 h keeps "latest" fresh enough for app downloads.
const TTL_MS = 60 * 60 * 1000;
let cache: { at: number; release: GithubRelease } | null = null;

async function getLatestRelease(): Promise<GithubRelease | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.release;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'servicebay' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logger.warn('BasicSync', `GitHub releases API returned HTTP ${res.status}`);
      return cache?.release ?? null; // serve stale on a transient API error
    }
    const release = (await res.json()) as GithubRelease;
    cache = { at: Date.now(), release };
    return release;
  } catch (e) {
    logger.warn('BasicSync', `Failed to fetch latest release: ${e instanceof Error ? e.message : String(e)}`);
    return cache?.release ?? null;
  }
}

/**
 * Resolve the `browser_download_url` of the latest BasicSync APK for `abi`.
 * Returns null when the release (or a matching asset) can't be found.
 *
 * Matches on the `-<abi>-release.apk` suffix; `endsWith` keeps `x86` from
 * matching the `x86_64` asset.
 */
export async function resolveBasicSyncApkUrl(abi: BasicSyncAbi): Promise<string | null> {
  const release = await getLatestRelease();
  const asset = release?.assets?.find(a => a.name.endsWith(`-${abi}-release.apk`));
  return asset?.browser_download_url ?? null;
}

/** Test-only: drop the cached release so a test can control each fetch. */
export function __resetBasicSyncCache(): void {
  cache = null;
}

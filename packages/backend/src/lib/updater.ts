import fs from 'fs/promises';
import path from 'path';
import semver from 'semver';
import { Server } from 'socket.io';
import { getExecutor } from '@/lib/executor';
import { getConfig, updateConfig } from '@/lib/config';
import { sendEmailAlert } from '@/lib/email';
import { logger } from '@/lib/logger';

declare global {
   
  var updaterIO: Server | null;
}

export function setUpdaterIO(socketIo: Server) {
  global.updaterIO = socketIo;
}

function emitProgress(step: string, progress: number, message: string) {
  logger.info('updater', `${step}: ${progress}% - ${message}`);
  if (global.updaterIO) {
    global.updaterIO.emit('update:progress', { step, progress, message });
  } else {
    logger.warn('Update', 'Socket.IO instance not set, cannot emit progress');
  }
}

const REPO = 'mdopp/servicebay';
const IMAGE = 'ghcr.io/mdopp/servicebay:latest';

interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  body: string;
}

/**
 * Pull the per-arch (amd64/linux) image digest out of a `podman manifest
 * inspect` manifest-list document. The list is multi-arch; the amd64/linux
 * entry's digest is the stable per-image identity that changes exactly when a
 * new image is pushed to the tag. Exported for unit testing the parsing.
 */
export function extractImageDigest(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== 'object') return null;
  const m = manifest as Record<string, unknown>;

  // Manifest list (multi-arch): pick the linux/amd64 platform entry.
  const manifests = m.manifests;
  if (Array.isArray(manifests)) {
    const amd64 = manifests.find((entry) => {
      const platform = (entry as Record<string, unknown>)?.platform as
        | Record<string, unknown>
        | undefined;
      return platform?.os === 'linux' && platform?.architecture === 'amd64';
    }) as Record<string, unknown> | undefined;
    const listed = amd64?.digest;
    if (typeof listed === 'string' && listed.length > 0) return listed;
  }

  // Single-arch image manifest: the config digest is its stable identity.
  const config = m.config as Record<string, unknown> | undefined;
  const single = config?.digest ?? m.Digest ?? m.digest;
  return typeof single === 'string' && single.length > 0 ? single : null;
}

/**
 * Resolve the image digest the **registry** currently publishes for
 * `:latest`. `podman manifest inspect` fetches only the manifest (a few KB),
 * not the layers, so this is cheap enough to run on every update check.
 * Returns null when the registry can't be reached / the tool errors — callers
 * must treat null as "unknown", never as "unchanged".
 */
async function getRemoteImageDigest(): Promise<string | null> {
  try {
    const executor = getExecutor('Local');
    const { stdout } = await executor.execArgv(['podman', 'manifest', 'inspect', IMAGE], {
      timeoutMs: 30 * 1000,
    });
    return extractImageDigest(JSON.parse(stdout));
  } catch (e) {
    logger.warn('Updater', `getRemoteImageDigest failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Resolve the image digest the **running** `servicebay` container was actually
 * created from — the ground truth for "what are we running right now", as
 * opposed to `appliedImageDigest` in config (which can drift: `performUpdate`
 * used to persist the registry digest even when the restart no-op'd and kept
 * the old image, leaving every later check falsely reporting "still building",
 * #2062). `podman inspect … {{.Image}}` returns the image ID; we map it to the
 * registry-style manifest digest via the image's RepoDigests so it's
 * comparable to `getRemoteImageDigest()`. Returns null on any failure — callers
 * treat null as "unknown" and fall back to the config baseline.
 */
async function getRunningImageDigest(): Promise<string | null> {
  try {
    const executor = getExecutor('Local');
    const { stdout } = await executor.execArgv(
      ['podman', 'inspect', 'servicebay', '--format', '{{.ImageDigest}}'],
      { timeoutMs: 30 * 1000 },
    );
    const digest = stdout.trim();
    return /^sha256:[0-9a-f]+$/.test(digest) ? digest : null;
  } catch (e) {
    logger.warn('Updater', `getRunningImageDigest failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function getCurrentVersion(): Promise<string> {
  try {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const content = await fs.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(content);
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

async function getLatestRelease(): Promise<Release | null> {
  try {
    // Default fetch has no timeout — without this guard a hung GitHub
    // connection would block the updater (called from a scheduled cron
    // task) until socket-keepalive eventually killed it tens of
    // minutes later. 8 s is plenty for a healthy GitHub call; if it
    // overruns we'll just retry on the next tick.
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  current: string;
  /**
   * True when the release tag is ahead of the running version but the
   * `:latest` image hasn't been (re)published yet — the release-please tag
   * lands *before* the Release workflow builds+pushes the image, so for a few
   * minutes the tag advertises a version no image exists for. We surface this
   * distinctly instead of a false "update available" that pulls an unchanged
   * image and reports a misleading success.
   */
  imageBuilding?: boolean;
  latest: {
    version: string;
    url: string;
    date: string;
    notes: string;
  } | null;
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const current = await getCurrentVersion();
  const latest = await getLatestRelease();

  if (!latest || !latest.tag_name) {
    if (latest && !latest.tag_name) {
      logger.warn('Updater', 'Latest release found but missing tag_name:', latest);
    }
    return { hasUpdate: false, current, latest: null };
  }

  // Remove 'v' prefix for semver comparison
  // Also handle cases where tag might be prefixed with package name (e.g. servicebay-v0.6.0)
  const currentClean = current.replace(/^v/, '');
  // Extract version part from tag: removes 'v', 'servicebay-v', etc. matches x.y.z
  const versionMatch = latest.tag_name.match(/(\d+\.\d+\.\d+.*)/);
  const latestClean = versionMatch ? versionMatch[0] : latest.tag_name.replace(/^v/, '');

  let tagAhead = false;
  try {
      tagAhead = semver.gt(latestClean, currentClean);
  } catch (err) {
      logger.warn('Updater', `Invalid version comparison: ${latestClean} vs ${currentClean}`, err);
      return { hasUpdate: false, current, latest: null };
  }

  const latestInfo = {
    version: latest.tag_name,
    url: latest.html_url,
    date: latest.published_at,
    notes: latest.body,
  };

  const config = await getConfig();

  if (!tagAhead) {
    // We're current. Record the digest we're running on (if not already) so a
    // later tag-ahead check has a baseline to reconcile against — the digest
    // the registry serves now is, by definition, the image this version runs.
    if (!config.autoUpdate.appliedImageDigest) {
      const seedDigest = await getRemoteImageDigest();
      if (seedDigest) {
        await updateConfig({
          autoUpdate: { ...config.autoUpdate, appliedImageDigest: seedDigest },
        });
      }
    }
    return { hasUpdate: false, current, latest: latestInfo };
  }

  // The release tag is ahead. Reconcile against the *actual* image so we don't
  // advertise an update that would pull an unchanged image (the tag→image
  // window). Prefer the digest the RUNNING container was created from — it's
  // ground truth. `appliedImageDigest` in config is only a fallback: it could
  // have drifted ahead of reality if a past restart no-op'd while config
  // recorded the registry digest, which is exactly what made a genuinely-new
  // `:latest` look "still building" forever (#2062).
  const remoteDigest = await getRemoteImageDigest();
  const baselineDigest = (await getRunningImageDigest()) ?? config.autoUpdate.appliedImageDigest;

  // If we can't resolve the remote digest (registry unreachable / no podman) or
  // have no baseline at all, fall back to the tag check alone — never block a
  // genuine update on a transient digest-lookup failure, and never claim
  // "building" on unknown.
  if (!remoteDigest || !baselineDigest) {
    return { hasUpdate: true, current, latest: latestInfo };
  }

  if (remoteDigest === baselineDigest) {
    // Tag advanced but the image we're running is genuinely the one the
    // registry serves — the new image is still building. Not actionable yet.
    return { hasUpdate: false, imageBuilding: true, current, latest: latestInfo };
  }

  // Registry `:latest` differs from what we're actually running → real update.
  return { hasUpdate: true, current, latest: latestInfo };
}

/**
 * Check for an update and email the operator if a new version is available.
 * Deduped via `autoUpdate.lastNotifiedVersion` in config so we send one mail
 * per release, not one per tick. No-op when email isn't configured/enabled
 * (sendEmailAlert handles that — we just skip the work).
 */
async function notifyOnUpdate(): Promise<void> {
  try {
    const config = await getConfig();
    if (!config.notifications?.email?.enabled) return;

    const status = await checkForUpdates();
    if (!status.hasUpdate || !status.latest) return;

    const latestVersion = status.latest.version;
    if (config.autoUpdate.lastNotifiedVersion === latestVersion) return;

    const subject = `ServiceBay update available: ${latestVersion}`;
    const message = [
      `A new ServiceBay release is available.`,
      ``,
      `  Current: ${status.current}`,
      `  Latest:  ${latestVersion}`,
      `  Released: ${status.latest.date}`,
      `  Details: ${status.latest.url}`,
      ``,
      `Release notes:`,
      status.latest.notes || '(no notes provided)',
      ``,
      config.autoUpdate.enabled
        ? `Auto-update is ON — your appliance will install this on its next scheduled run.`
        : `Auto-update is OFF — install from Settings → System → Check for Updates when you're ready.`,
    ].join('\n');

    await sendEmailAlert(subject, message);

    // Persist after the send so a transient SMTP failure doesn't suppress the
    // next attempt. Worst case: a duplicate email if we crash between send
    // and persist — preferable to dropping the notification entirely.
    await updateConfig({
      autoUpdate: { ...config.autoUpdate, lastNotifiedVersion: latestVersion },
    });

    logger.info('Updater', `Notified operator about new release ${latestVersion}`);
  } catch (e) {
    logger.warn('Updater', `notifyOnUpdate failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const NOTIFY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const NOTIFY_INITIAL_DELAY_MS = 60 * 1000; // 1 min after boot — let everything settle first
let notifyTimer: NodeJS.Timeout | null = null;

/**
 * Kick off the periodic update-availability email notifier. Safe to call
 * multiple times — second call clears the existing timer first. Idempotent.
 */
export function scheduleUpdateNotifier(): void {
  if (notifyTimer) clearInterval(notifyTimer);
  setTimeout(() => { void notifyOnUpdate(); }, NOTIFY_INITIAL_DELAY_MS);
  notifyTimer = setInterval(() => { void notifyOnUpdate(); }, NOTIFY_INTERVAL_MS);
  logger.info('Updater', `Update-notification poll scheduled every ${NOTIFY_INTERVAL_MS / 3600000}h`);
}

export interface PerformUpdateResult {
  success: boolean;
  /** True when the image actually advanced and a restart was triggered. */
  updated: boolean;
  message: string;
}

export async function performUpdate(version: string): Promise<PerformUpdateResult> {
  try {
    emitProgress('init', 0, 'Initializing update...');
    const executor = getExecutor('Local');

    // Capture the digest we're running on *before* pulling, so we can tell
    // whether the pull actually advanced us to a new image — never report a
    // silent success no-op (memory feedback_dont_mask_failures).
    const config = await getConfig();
    const beforeDigest = config.autoUpdate.appliedImageDigest ?? null;

    // 1. Pull new image
    logger.info('updater', `Pulling new image for version ${version}...`);
    emitProgress('download', 0, 'Pulling new image...');

    // Pulls can take time on slower links; extend timeout to avoid premature failure
    const { stdout, stderr } = await executor.exec('podman pull ghcr.io/mdopp/servicebay:latest', { timeoutMs: 5 * 60 * 1000 });
    const pullOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join(' | ');
    const safeOutput = pullOutput.length > 800 ? `${pullOutput.slice(0, 800)}...` : pullOutput;

    // What does the registry serve now, after the pull? If it matches the
    // digest we were already running, nothing changed — the image isn't ready
    // yet (the release tag raced ahead of the image push). Report it honestly
    // and skip the pointless restart.
    const afterDigest = await getRemoteImageDigest();
    const imageChanged = afterDigest !== null && afterDigest !== beforeDigest;

    if (afterDigest !== null && !imageChanged) {
      const message =
        'Already on the latest image — the new version is still building. Try again shortly.';
      logger.info('updater', message);
      emitProgress('download', 100, message);
      if (global.updaterIO) global.updaterIO.emit('update:noop', { message });
      return { success: true, updated: false, message };
    }

    const downloadMessage = safeOutput ? `Image pulled successfully. podman pull output: ${safeOutput}` : 'Image pulled successfully.';
    emitProgress('download', 100, downloadMessage);

    // Persist the digest we advanced to so the next availability check knows
    // what we're actually running (closes the tag→image false-positive window).
    if (afterDigest) {
      await updateConfig({
        autoUpdate: { ...config.autoUpdate, appliedImageDigest: afterDigest },
      });
    }

    // 2. Recreate + restart. A plain `systemctl restart` reuses the existing
    // container definition and keeps running the OLD image even after the pull
    // (#2063), so a fresh image silently never lands. Force a recreate by
    // removing the container first; the quadlet unit then rebuilds it from the
    // freshly-pulled image on start. `--no-block` so this request can return
    // before ServiceBay (which is serving it) is torn down.
    logger.info('updater', 'Recreating service container with the new image...');
    emitProgress('restart', 0, 'Recreating container via podman rm -f + systemctl --user restart --no-block servicebay.service');
    void (async () => {
      try {
        await executor.exec('podman rm -f servicebay');
        await executor.exec('systemctl --user restart --no-block servicebay.service');
        logger.info('updater', 'Container recreate + restart triggered.');
      } catch (e) {
        logger.error('updater', 'Recreate/restart failed:', e);
      }
    })();
    emitProgress('restart', 100, 'Recreate triggered. ServiceBay will restart with the new image.');

    return { success: true, updated: true, message: 'Update applied. Service is restarting with the new image.' };
  } catch (e) {
    logger.error('updater', 'Update failed:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    if (global.updaterIO) global.updaterIO.emit('update:error', { error: message });
    throw new Error(`Update failed: ${message}`);
  }
}

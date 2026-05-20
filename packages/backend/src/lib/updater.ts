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
  console.log(`[Update Progress] ${step}: ${progress}% - ${message}`);
  if (global.updaterIO) {
    global.updaterIO.emit('update:progress', { step, progress, message });
  } else {
    console.warn('[Update] Socket.IO instance not set, cannot emit progress');
  }
}

const REPO = 'mdopp/servicebay';

interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  body: string;
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

export async function checkForUpdates() {
  const current = await getCurrentVersion();
  const latest = await getLatestRelease();

  if (!latest || !latest.tag_name) {
    if (latest && !latest.tag_name) {
      console.warn('[Updater] Latest release found but missing tag_name:', latest);
    }
    return { hasUpdate: false, current, latest: null };
  }

  // Remove 'v' prefix for semver comparison
  // Also handle cases where tag might be prefixed with package name (e.g. servicebay-v0.6.0)
  const currentClean = current.replace(/^v/, '');
  // Extract version part from tag: removes 'v', 'servicebay-v', etc. matches x.y.z
  const versionMatch = latest.tag_name.match(/(\d+\.\d+\.\d+.*)/);
  const latestClean = versionMatch ? versionMatch[0] : latest.tag_name.replace(/^v/, '');

  let hasUpdate = false;
  try {
      hasUpdate = semver.gt(latestClean, currentClean);
  } catch (err) {
      console.warn(`[Updater] Invalid version comparison: ${latestClean} vs ${currentClean}`, err);
      return { hasUpdate: false, current, latest: null };
  }

  return {
    hasUpdate,
    current,
    latest: {
      version: latest.tag_name,
      url: latest.html_url,
      date: latest.published_at,
      notes: latest.body
    }
  };
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

export async function performUpdate(version: string) {
  try {
    emitProgress('init', 0, 'Initializing update...');
    const executor = getExecutor('Local');
    
    // 1. Pull new image
    console.log(`Pulling new image for version ${version}...`);
    emitProgress('download', 0, 'Pulling new image...');
    
    // Pulls can take time on slower links; extend timeout to avoid premature failure
    const { stdout, stderr } = await executor.exec('podman pull ghcr.io/mdopp/servicebay:latest', { timeoutMs: 5 * 60 * 1000 });
    const pullOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join(' | ');
    const safeOutput = pullOutput.length > 800 ? `${pullOutput.slice(0, 800)}...` : pullOutput;
    const downloadMessage = safeOutput ? `Image pulled successfully. podman pull output: ${safeOutput}` : 'Image pulled successfully.';
    emitProgress('download', 100, downloadMessage);

    // 2. Restart via systemd instead of auto-update to ensure deterministic restart
    console.log('Restarting service...');
    emitProgress('restart', 0, 'Restarting service via systemctl --user restart --no-block servicebay.service');
    await executor.exec('systemctl --user restart --no-block servicebay.service');
    emitProgress('restart', 100, 'Restart triggered. ServiceBay will restart with the new image.');

    return { success: true };
  } catch (e) {
    console.error('Update failed:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    if (global.updaterIO) global.updaterIO.emit('update:error', { error: message });
    throw new Error(`Update failed: ${message}`);
  }
}

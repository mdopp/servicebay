import fs from 'fs/promises';
import path from 'path';
import semver from 'semver';
import { Server } from 'socket.io';
import { getExecutor } from '@/lib/executor';

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
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
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

export async function performUpdate(version: string) {
  try {
    emitProgress('init', 0, 'Initializing update...');
    const executor = getExecutor('Local');
    
    // 1. Pull new image
    console.log(`Pulling new image for version ${version}...`);
    emitProgress('download', 0, 'Pulling new image...');
    
    // Pulls can take time on slower links; extend timeout to avoid premature failure
    await executor.exec('podman pull ghcr.io/mdopp/servicebay:latest', { timeoutMs: 5 * 60 * 1000 });
    emitProgress('download', 100, 'Image pulled successfully');

    // 2. Restart
    console.log('Restarting service...');
    emitProgress('restart', 0, 'Restarting service...');
    
    // Trigger auto-update to restart the service
    // This requires the service to be running with AutoUpdate=registry (which we set in install.sh)
    // And the image to be updated.
    
    // Run auto-update asynchronously over SSH so the container can restart itself safely.
    await executor.exec('nohup podman auto-update >/tmp/servicebay-auto-update.log 2>&1 &');
    emitProgress('restart', 100, 'Auto-update triggered');

    return { success: true };
  } catch (e) {
    console.error('Update failed:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    if (global.updaterIO) global.updaterIO.emit('update:error', { error: message });
    throw new Error(`Update failed: ${message}`);
  }
}

import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import semver from 'semver';
import { Server } from 'socket.io';

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

function spawnCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args);
    
    proc.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[${command}]: ${msg}`);
    });
    
    proc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.error(`[${command}]: ${msg}`);
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with code ${code}`));
    });

    proc.on('error', (err) => reject(err));
  });
}

export async function performUpdate(version: string) {
  try {
    emitProgress('init', 0, 'Initializing update...');
    
    // 1. Pull new image
    console.log(`Pulling new image for version ${version}...`);
    emitProgress('download', 0, 'Pulling new image...');
    
    // We use spawn instead of exec to stream output and avoid buffer buffer overflows/hangs
    await spawnCommand('podman', ['pull', 'ghcr.io/mdopp/servicebay:latest']);
    emitProgress('download', 100, 'Image pulled successfully');

    // 2. Restart
    console.log('Restarting service...');
    emitProgress('restart', 0, 'Restarting service...');
    
    // Trigger auto-update to restart the service
    // This requires the service to be running with AutoUpdate=registry (which we set in install.sh)
    // And the image to be updated.
    
    // We use 'podman auto-update' which restarts containers if image is new.
    // Since we just pulled it, it should be new.
    // We use --force to ensure it restarts even if it thinks it's up to date (e.g. if we pulled manually)
    // Actually, auto-update only restarts if image changed.
    // If we pulled manually, the running container is using the old image ID.
    // The new image tag points to a new ID.
    // So auto-update should detect that.
    const subprocess = spawn('podman', ['auto-update'], {
      detached: true,
      stdio: 'ignore'
    });
    subprocess.unref();

    return { success: true };
  } catch (e) {
    console.error('Update failed:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    if (global.updaterIO) global.updaterIO.emit('update:error', { error: message });
    throw new Error(`Update failed: ${message}`);
  }
}

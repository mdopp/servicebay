import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import semver from 'semver';
import { Server } from 'socket.io';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

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

const execAsync = promisify(exec);
const REPO = 'mdopp/servicebay';
const INSTALL_DIR = path.join(os.homedir(), '.servicebay');

interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  body: string;
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await fs.access(path);
        return true;
    } catch {
        return false;
    }
}

async function downloadFile(url: string, dest: string, onProgress?: (percent: number) => void) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!res.ok) throw new Error(`Failed to download: ${res.statusText} (${res.status})`);

        const contentLength = res.headers.get('content-length');
        const total = contentLength ? parseInt(contentLength, 10) : 0;
        let loaded = 0;

        if (!res.body) throw new Error('Response body is empty');

        const fileStream = createWriteStream(dest);
        const reader = res.body.getReader();

        // Create a readable stream from the fetch reader to pipe to file
        const readable = new Readable({
            async read() {
                const { done, value } = await reader.read();
                if (done) {
                    this.push(null);
                } else {
                    loaded += value.length;
                    if (total > 0 && onProgress) {
                        const progress = (loaded / total) * 100;
                        onProgress(progress);
                    }
                    this.push(Buffer.from(value));
                }
            }
        });

        await pipeline(readable, fileStream);
    } catch (e) {
        clearTimeout(timeout);
        throw e;
    }
}

export async function getCurrentVersion(): Promise<string> {
  try {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const content = await fs.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(content);
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export async function getLatestRelease(): Promise<Release | null> {
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

  if (!latest) return { hasUpdate: false, current, latest: null };

  // Remove 'v' prefix for semver comparison
  const currentClean = current.replace(/^v/, '');
  const latestClean = latest.tag_name.replace(/^v/, '');

  const hasUpdate = semver.gt(latestClean, currentClean);

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
  const tempDir = path.join(os.tmpdir(), `servicebay-update-${Date.now()}`);

  try {
    emitProgress('init', 0, 'Initializing update...');
    await fs.mkdir(tempDir, { recursive: true });

    // 1. Download Update (Code only)
    const updateUrl = `https://github.com/${REPO}/releases/download/${version}/servicebay-update-linux-x64.tar.gz`;
    const depsUrl = `https://github.com/${REPO}/releases/download/${version}/servicebay-deps-linux-x64.tar.gz`;
    
    console.log(`Downloading update code from ${updateUrl}...`);
    emitProgress('download', 0, 'Downloading application code...');
    
    await downloadFile(updateUrl, path.join(tempDir, 'update.tar.gz'), (p) => emitProgress('download', Math.round(p/2), `Downloading code... ${Math.round(p)}%`));

    // 2. Extract Code to Temp
    console.log('Extracting update code...');
    emitProgress('extract', 0, 'Analyzing update...');
    await execAsync(`tar xzf "${path.join(tempDir, 'update.tar.gz')}" -C "${tempDir}"`);

    // 3. Smart Dependency Check
    let needDeps = true;
    try {
        const oldLockPath = path.join(INSTALL_DIR, 'package-lock.json');
        // The tarball extracts to a 'servicebay' folder
        const newLockPath = path.join(tempDir, 'servicebay', 'package-lock.json');

        if (await fileExists(oldLockPath) && await fileExists(newLockPath)) {
            const oldLock = JSON.parse(await fs.readFile(oldLockPath, 'utf-8'));
            const newLock = JSON.parse(await fs.readFile(newLockPath, 'utf-8'));

            // Compare dependencies only, ignoring version/name of the root package
            // We need to remove the root package info from comparison as version changes on every release
            if (oldLock.packages && oldLock.packages['']) {
                delete oldLock.packages[''].version;
                delete oldLock.packages[''].name;
            }
            if (newLock.packages && newLock.packages['']) {
                delete newLock.packages[''].version;
                delete newLock.packages[''].name;
            }

            if (JSON.stringify(oldLock.packages) === JSON.stringify(newLock.packages)) {
                console.log('Dependencies unchanged. Skipping dependency download.');
                needDeps = false;
            } else {
                console.log('Dependencies changed.');
            }
        }
    } catch (e) {
        console.warn('Failed to compare lockfiles, forcing dependency update', e);
    }

    // 4. Download Dependencies if needed
    if (needDeps) {
        console.log(`Downloading dependencies from ${depsUrl}...`);
        emitProgress('download', 50, 'Downloading dependencies...');
        await downloadFile(depsUrl, path.join(tempDir, 'deps.tar.gz'), (p) => emitProgress('download', 50 + Math.round(p/2), `Downloading deps... ${Math.round(p)}%`));
        
        console.log('Extracting dependencies...');
        emitProgress('extract', 50, 'Extracting dependencies...');
        // Remove old node_modules
        await fs.rm(path.join(INSTALL_DIR, 'node_modules'), { recursive: true, force: true });
        // Extract new node_modules directly to INSTALL_DIR
        await execAsync(`tar xzf "${path.join(tempDir, 'deps.tar.gz')}" -C "${INSTALL_DIR}"`);
    }

    // 5. Install Code (Overwrite)
    console.log(`Installing code to ${INSTALL_DIR}...`);
    emitProgress('install', 0, 'Installing update...');
    
    const sourceDir = path.join(tempDir, 'servicebay');
    // Copy code files
    await execAsync(`cp -rf "${sourceDir}/." "${INSTALL_DIR}/"`);
    
    emitProgress('install', 100, 'Installation complete');

    // 6. Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });

    // 7. Restart
    console.log('Restarting service...');
    emitProgress('restart', 0, 'Restarting service...');
    
    // We can't await this because the process will die.
    // We spawn it detached.
    const subprocess = spawn('systemctl', ['--user', 'restart', 'servicebay'], {
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

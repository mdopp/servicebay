import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import semver from 'semver';
import { Server } from 'socket.io';

let io: Server | null = null;

export function setUpdaterIO(socketIo: Server) {
  io = socketIo;
}

function emitProgress(step: string, progress: number, message: string) {
  console.log(`[Update Progress] ${step}: ${progress}% - ${message}`);
  if (io) {
    io.emit('update:progress', { step, progress, message });
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
  const downloadUrl = `https://github.com/${REPO}/releases/download/${version}/servicebay-linux-x64.tar.gz`;
  const tempDir = path.join(os.tmpdir(), `servicebay-update-${Date.now()}`);
  const tarPath = path.join(tempDir, 'update.tar.gz');

  try {
    emitProgress('init', 0, 'Initializing update...');
    await fs.mkdir(tempDir, { recursive: true });

    // 1. Download
    console.log(`Downloading update from ${downloadUrl}...`);
    emitProgress('download', 0, 'Downloading update package...');
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout for initial connection

    try {
        const res = await fetch(downloadUrl, { signal: controller.signal });
        clearTimeout(timeout);
        
        if (!res.ok) throw new Error(`Failed to download update: ${res.statusText} (${res.status})`);
        
        const contentLength = res.headers.get('content-length');
        const total = contentLength ? parseInt(contentLength, 10) : 0;
        let loaded = 0;

        if (res.body) {
            const reader = res.body.getReader();
            const chunks = [];
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                chunks.push(value);
                loaded += value.length;
                
                if (total > 0) {
                    const progress = Math.round((loaded / total) * 100);
                    // Emit every 5% or so to avoid spamming
                    if (progress % 5 === 0) {
                        emitProgress('download', progress, `Downloading... ${progress}%`);
                    }
                }
            }
            
            const buffer = Buffer.concat(chunks);
            await fs.writeFile(tarPath, buffer);
        } else {
            // Fallback if no body (shouldn't happen with fetch)
            const buffer = await res.arrayBuffer();
            await fs.writeFile(tarPath, Buffer.from(buffer));
        }
    } catch (e) {
        clearTimeout(timeout);
        throw e;
    }
    
    emitProgress('download', 100, 'Download complete');

    // 2. Extract
    console.log('Extracting update...');
    emitProgress('extract', 0, 'Extracting update package...');
    // We extract to tempDir first
    await execAsync(`tar xzf "${tarPath}" -C "${tempDir}"`);
    emitProgress('extract', 100, 'Extraction complete');
    
    // The tarball contains a 'servicebay' folder. We need the contents of that folder.
    const sourceDir = path.join(tempDir, 'servicebay');

    // 3. Install (Overwrite)
    console.log(`Installing to ${INSTALL_DIR}...`);
    emitProgress('install', 0, 'Installing update...');
    // Use rsync or cp to overwrite files. cp -r is simpler but we need to be careful about open files.
    // Since we are running from INSTALL_DIR, we are overwriting ourself.
    // Linux allows this (unlink/rename).
    
    // We use a shell command to copy files.
    // We exclude config files if we had any in the root that should be preserved, 
    // but currently config is in ~/.servicebay/config.json which is NOT in the tarball (tarball has code).
    // So overwriting everything is safe, assuming tarball structure matches.
    
    // Use cp -rf with /. to include hidden files (like .next)
    await execAsync(`cp -rf "${sourceDir}/." "${INSTALL_DIR}/"`);
    emitProgress('install', 100, 'Installation complete');

    // 4. Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });

    // 5. Restart
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
    if (io) io.emit('update:error', { error: message });
    throw new Error(`Update failed: ${message}`);
  }
}

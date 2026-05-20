import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Extract nginx .conf files from a full ServiceBay backup tar.gz.
 *
 * The backup stores nginx configs under service-data/<label>/ where
 * <label> is derived from the container mount path (e.g. "etc-nginx-conf.d").
 * We look for any service-data subdirectory containing .conf files.
 */
export async function extractNginxConfFromBackup(
    buffer: Buffer
): Promise<Record<string, string> | null> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'servicebay-nginx-import-'));
    try {
        const archivePath = path.join(tmpDir, 'backup.tar.gz');
        await fs.writeFile(archivePath, buffer);
        await execFileAsync('tar', ['-xzf', archivePath, '-C', tmpDir]);

        const serviceDataDir = path.join(tmpDir, 'service-data');
        try {
            await fs.access(serviceDataDir);
        } catch {
            return null;
        }

        const files: Record<string, string> = {};
        const subdirs = await fs.readdir(serviceDataDir, { withFileTypes: true });

        for (const dirent of subdirs) {
            if (!dirent.isDirectory()) continue;
            // Look for directories that likely contain nginx conf
            // e.g. "etc-nginx-conf.d", or any dir with .conf files
            const dirPath = path.join(serviceDataDir, dirent.name);
            const entries = await fs.readdir(dirPath);
            const confFiles = entries.filter(f => f.endsWith('.conf'));

            for (const confFile of confFiles) {
                const content = await fs.readFile(path.join(dirPath, confFile), 'utf-8');
                files[confFile] = content;
            }
        }

        return Object.keys(files).length > 0 ? files : null;
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
}

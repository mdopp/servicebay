// src/lib/dirs.ts
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

// In container, we map host's .servicebay to /app/data
// But os.homedir() is /root.
// So we should check if /app/data exists, otherwise use os.homedir()/.servicebay
// CRITICAL: .servicebay folder must strictly map to /app/data in container for SSH Keys persistence across re-deployments
const isContainer = existsSync('/.dockerenv') || (process.env.NODE_ENV === 'production' && existsSync('/app'));
export const DATA_DIR = process.env.DATA_DIR || (isContainer ? '/app/data' : path.join(os.homedir(), '.servicebay'));
export const SSH_DIR = path.join(DATA_DIR, 'ssh');
export const SERVICEBAY_BACKUP_DIR = path.join(DATA_DIR, 'backups');

export function getLocalSystemdDir(): string {
	return path.join(os.homedir(), '.config/containers/systemd');
}

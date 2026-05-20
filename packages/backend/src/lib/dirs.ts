// src/lib/dirs.ts
import path from 'path';
import os from 'os';

export const DATA_DIR = process.env.DATA_DIR || '/app/data';
export const SSH_DIR = path.join(DATA_DIR, 'ssh');
export const SERVICEBAY_BACKUP_DIR = path.join(DATA_DIR, 'backups');

export function getLocalSystemdDir(): string {
	return path.join(os.homedir(), '.config/containers/systemd');
}

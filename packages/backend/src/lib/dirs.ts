// src/lib/dirs.ts
import path from 'path';
import os from 'os';

export const DATA_DIR = process.env.DATA_DIR || '/app/data';

// HOST-side path of the data volume, as the agent's `safe_exec`/`podman run`
// see it on the box — NOT the in-container DATA_DIR. The servicebay container
// mounts `${DATA_ROOT}/servicebay:/app/data` (butane), so a host-side command
// (e.g. the disk-import worker's `podman run -v <out>:/out` and its `mkdir`)
// must use `/mnt/data/servicebay`, never `/app/data` (which is read-only on the
// host). The quadlet sets HOST_DATA_DIR=${DATA_ROOT}/servicebay; it falls back
// to DATA_DIR for dev/test where host == container.
export const HOST_DATA_DIR = process.env.HOST_DATA_DIR || DATA_DIR;
export const SSH_DIR = path.join(DATA_DIR, 'ssh');
export const SERVICEBAY_BACKUP_DIR = path.join(DATA_DIR, 'backups');

export function getLocalSystemdDir(): string {
	return path.join(os.homedir(), '.config/containers/systemd');
}

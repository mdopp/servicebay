/**
 * Stage an exported LLDAP directory onto the FritzBox NAS for the
 * config-survival feature (#1354, epic #1350).
 *
 * Unlike the file-based per-service backups (`producer.ts`), LLDAP keeps its
 * data in a DB and is re-populated programmatically over GraphQL — so the
 * "backup" is a JSON directory dump (users + groups + memberships, no
 * passwords) rather than a `<service>.tar`. It lands beside the service tars in
 * `sb-backup/` so the restore flow can find and re-seed it on a fresh install.
 */
import path from 'path';
import { nasUpload } from './nasClient';
import { NAS_BACKUP_DIR } from './producer';
import { logger } from '../logger';
import type { LldapDirectory } from '../lldap/client';

/** File on the NAS holding the exported LLDAP directory. */
export const LLDAP_DIRECTORY_FILE = 'lldap-directory.json';

export interface LldapStageResult {
  file: string;
  users: number;
  groups: number;
}

/** Write the exported directory to `sb-backup/lldap-directory.json` on the NAS. */
export async function stageLldapDirectoryToNas(directory: LldapDirectory): Promise<LldapStageResult> {
  const buf = Buffer.from(JSON.stringify(directory, null, 2));
  await nasUpload(path.posix.join(NAS_BACKUP_DIR, LLDAP_DIRECTORY_FILE), buf);
  logger.info('ExternalBackup', `Staged LLDAP directory to NAS (${directory.users.length} users, ${directory.groups.length} groups)`);
  return { file: LLDAP_DIRECTORY_FILE, users: directory.users.length, groups: directory.groups.length };
}

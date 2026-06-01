/**
 * #1218 entry point 2 — the onboarding "orphan hint" source. After a reinstall
 * or a foreign-backup seed (#1350), the FritzBox NAS can hold config backups
 * for services the operator hasn't (re)installed yet. This surfaces those so
 * the wizard can offer "N service backups available — install them?" (installing
 * then re-seeds the config via the entry-1 restore). Epic #1190.
 */
import { listServiceBackups, type ServiceBackupListEntry } from './producer';

/** NAS service backups whose service is NOT in `installed` — i.e. config sitting
 *  on the NAS with no running service to own it. Pure; `installed` is any
 *  iterable of service names. */
export function selectOrphanBackups(
  nasBackups: ServiceBackupListEntry[],
  installed: Iterable<string>,
): ServiceBackupListEntry[] {
  const have = new Set(installed);
  return nasBackups.filter(b => !have.has(b.service));
}

/** List NAS config backups for services not currently installed (the wizard
 *  orphan-hint feed). */
export async function listOrphanServiceBackups(
  installed: Iterable<string>,
): Promise<ServiceBackupListEntry[]> {
  return selectOrphanBackups(await listServiceBackups(), installed);
}

/**
 * Core logic for the `sb-config-upload` CLI (#1219): seed the FritzBox NAS with
 * a service's config from a non-ServiceBay source (a retired HA Yellow, a
 * community automation pack, a test snapshot).
 *
 * It reuses the backup producer (#1216) so the whitelist, stripping rules, and
 * tar + meta format are identical to what the nightly backup writes and the
 * restore flow expects — one source of truth, no drift. This module is the
 * testable core; `scripts/sb-config-upload.ts` is the thin argv + readline shell.
 */
import fs from 'fs/promises';
import path from 'path';
import { backupServiceToNas, type ServiceBackupResult } from './producer';
import { getServiceManifest, SERVICE_BACKUP_MANIFESTS, type ServiceBackupManifest } from './serviceManifest';

/** Thrown for user-facing failures (bad args, abort) so the CLI can print a
 *  clean `error: <message>` instead of a stack trace. */
export class ConfigUploadError extends Error {}

export interface UploadOptions {
  service: string;
  from: string;
  target: string;
  /** Skip the unrecognized-layout confirmation prompt. */
  assumeYes: boolean;
}

export const USAGE = `Usage: sb-config-upload --service <svc> --from <path> [--target fritzbox] [--yes]

Seed the config-backup NAS with a service's config from an arbitrary directory,
using the same whitelist, stripping rules, and tar format as the built-in backup.

Options:
  --service <svc>   Service to upload (${SERVICE_BACKUP_MANIFESTS.map(m => m.service).join(', ')})
  --from <path>     Directory holding the service's config files
  --target <name>   Backup target (default: fritzbox)
  --yes, -y         Don't prompt to confirm an unrecognized source layout
  --help, -h        Show this help`;

/**
 * Parse `process.argv.slice(2)`. Returns `{ help: true }` for --help, or a
 * validated `UploadOptions`. Throws `ConfigUploadError` on malformed input.
 */
export function parseUploadArgs(argv: string[]): UploadOptions | { help: true } {
  const opts: Partial<UploadOptions> & { assumeYes: boolean } = { target: 'fritzbox', assumeYes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        return { help: true };
      case '--yes':
      case '-y':
        opts.assumeYes = true;
        break;
      case '--service':
      case '--from':
      case '--target': {
        const value = argv[++i];
        if (value === undefined) throw new ConfigUploadError(`Missing value for ${arg}`);
        if (arg === '--service') opts.service = value;
        else if (arg === '--from') opts.from = value;
        else opts.target = value;
        break;
      }
      default:
        throw new ConfigUploadError(`Unknown argument: ${arg}`);
    }
  }
  if (!opts.service) throw new ConfigUploadError('--service is required');
  if (!opts.from) throw new ConfigUploadError('--from is required');
  return { service: opts.service, from: opts.from, target: opts.target!, assumeYes: opts.assumeYes };
}

/** True when `dir` contains at least one of the service's expected config paths
 *  — i.e. it plausibly is that service's data dir rather than a wrong folder. */
export async function looksLikeServiceLayout(dir: string, manifest: ServiceBackupManifest): Promise<boolean> {
  for (const include of manifest.include) {
    try {
      await fs.access(path.join(dir, include));
      return true;
    } catch {
      // keep checking the remaining include paths
    }
  }
  return false;
}

export interface UploadIO {
  log: (message: string) => void;
  /** Ask the operator a yes/no question; resolve true to proceed. */
  confirm: (question: string) => Promise<boolean>;
}

/** Validate options, confirm an unrecognized layout, then build + upload the
 *  service tar via the shared producer. */
export async function runConfigUpload(opts: UploadOptions, io: UploadIO): Promise<ServiceBackupResult> {
  const manifest = getServiceManifest(opts.service);
  if (!manifest) {
    throw new ConfigUploadError(
      `Unknown service "${opts.service}". Known services: ${SERVICE_BACKUP_MANIFESTS.map(m => m.service).join(', ')}`,
    );
  }
  if (opts.target !== 'fritzbox') {
    throw new ConfigUploadError(`Unsupported --target "${opts.target}" (only "fritzbox" is supported)`);
  }
  const stat = await fs.stat(opts.from).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new ConfigUploadError(`--from is not a directory: ${opts.from}`);
  }

  if (!opts.assumeYes && !(await looksLikeServiceLayout(opts.from, manifest))) {
    const proceed = await io.confirm(
      `"${opts.from}" contains none of ${opts.service}'s expected config files ` +
        `(${manifest.include.join(', ')}). Upload anyway?`,
    );
    if (!proceed) throw new ConfigUploadError('Aborted.');
  }

  io.log(`Uploading ${opts.service} config from ${opts.from} to the FritzBox NAS…`);
  const result = await backupServiceToNas(opts.service, { serviceDataDir: opts.from });
  io.log(`Wrote ${result.tarName} (${result.size} bytes) and ${result.metaName} to NAS sb-backup/.`);
  return result;
}

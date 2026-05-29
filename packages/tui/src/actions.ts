/**
 * Command + box-target builders for the launcher TUI (#1231).
 *
 * Pure helpers — they only build argv / resolve a host:port, so they're
 * unit-testable. Both the ISO build and install-watch legs now hand off to the
 * native Go launcher's subcommands (#1278/#1295 ported install-fedora-coreos.sh
 * and #1274 ported scripts/install-tui.sh into tools/sb-tui); this Ink launcher
 * itself is retired in #1280.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** packages/tui/src → repo root. */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** Default ServiceBay HTTP port on the box. */
export const DEFAULT_SB_PORT = '5888';

export interface Command {
  cmd: string;
  args: string[];
}

export function isoBuildCommand(root: string = REPO_ROOT): Command {
  return { cmd: 'go', args: ['run', path.join(root, 'tools', 'sb-tui'), 'build'] };
}

export function installWatchCommand(root: string = REPO_ROOT): Command {
  return { cmd: 'go', args: ['run', path.join(root, 'tools', 'sb-tui'), 'watch'] };
}

export interface BoxTarget {
  host: string;
  port: string;
}

/** Parse the host/port out of build/fcos/install-settings.env (the same file
 *  install-tui.sh reads). Missing keys come back undefined. */
export function parseInstallSettings(envText: string): { host?: string; port?: string } {
  const host = envText.match(/^STATIC_IP=(.*)$/m)?.[1]?.trim();
  const port = envText.match(/^SERVICEBAY_PORT=(.*)$/m)?.[1]?.trim();
  return { host: host || undefined, port: port || undefined };
}

/** Resolve the box address: explicit SB_HOST/SB_PORT env wins, else the values
 *  from install-settings.env, else the default port. Host is '' when unknown. */
export function resolveBoxTarget(
  settings: { host?: string; port?: string },
  env: Record<string, string | undefined>,
): BoxTarget {
  return {
    host: env.SB_HOST || settings.host || '',
    port: env.SB_PORT || settings.port || DEFAULT_SB_PORT,
  };
}

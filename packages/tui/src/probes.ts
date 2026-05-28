/**
 * Concrete phase probes for the launcher TUI (#1231): a filesystem check for a
 * built ISO and an HTTP check of the box's install status. Kept separate from
 * phase.ts so the decision logic stays pure and testable.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT, parseInstallSettings, resolveBoxTarget } from './actions';
import type { BoxStatus, PhaseProbes } from './phase';

const BUILD_DIR = path.join(REPO_ROOT, 'build', 'fcos');
const SETTINGS_FILE = path.join(BUILD_DIR, 'install-settings.env');
const STATUS_TIMEOUT_MS = 3000;

async function readSettings(): Promise<{ host?: string; port?: string }> {
  try {
    return parseInstallSettings(await fs.readFile(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** An ISO build leaves install-settings.env (what install-tui.sh reads) and a
 *  *.iso under build/fcos — either marker counts as "built". */
export async function isoBuilt(): Promise<boolean> {
  try {
    await fs.access(SETTINGS_FILE);
    return true;
  } catch {
    // fall through to the iso glob
  }
  try {
    const entries = await fs.readdir(BUILD_DIR);
    return entries.some(e => e.endsWith('.iso'));
  } catch {
    return false;
  }
}

async function boxStatus(env: Record<string, string | undefined>): Promise<BoxStatus> {
  const target = resolveBoxTarget(await readSettings(), env);
  if (!target.host) return { reachable: false, wizardDone: false };
  try {
    const res = await fetch(`http://${target.host}:${target.port}/api/install/status`, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return { reachable: true, wizardDone: false };
    const data = (await res.json()) as { jobIsActive?: boolean; stackSetupPending?: boolean };
    return { reachable: true, wizardDone: data.jobIsActive === false && data.stackSetupPending === false };
  } catch {
    return { reachable: false, wizardDone: false };
  }
}

export function makeProbes(env: Record<string, string | undefined> = process.env): PhaseProbes {
  return {
    isoBuilt,
    boxStatus: () => boxStatus(env),
  };
}

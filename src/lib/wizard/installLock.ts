/**
 * Tiny file-based lock so the onboarding wizard can detect when an install
 * is already running in another browser tab / device / session.
 *
 * Why a lock and not just client-side state: the wizard wants to refuse a
 * second initial-install attempt regardless of *who* started the first one
 * — could be a different browser, the operator's phone, or a Claude MCP
 * session. The shared signal has to live somewhere both can see, and the
 * filesystem is what every code path can reach without bundle / Next /
 * webpack contortions.
 *
 * Stale detection: if the lock file is older than `STALE_AFTER_MS`, treat
 * it as expired (the original install probably crashed / lost power /
 * timed out). The wizard auto-renews the lock with a heartbeat while
 * the install is actively running.
 */
import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR } from '@/lib/dirs';

const LOCK_FILE = path.join(DATA_DIR, 'wizard-install.lock');
const STALE_AFTER_MS = 30 * 60_000; // 30 min — generous, covers slow first-time pulls.

interface LockState {
  startedAt: string; // ISO
  source?: string;   // free-form note: "wizard", "mcp", "api"
}

/** Acquire (or refresh) the install lock. Idempotent — always wins; the
 *  caller is the source of truth for "is install actually running". */
export async function setInstallActive(source: string = 'wizard'): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => undefined);
  const state: LockState = { startedAt: new Date().toISOString(), source };
  await fs.writeFile(LOCK_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/** Check whether an install is currently active. Returns the lock state
 *  if active, or null. Stale locks (older than STALE_AFTER_MS without a
 *  refresh) report null and are also auto-removed so the next status
 *  check is fast. */
export async function getInstallActive(): Promise<LockState | null> {
  try {
    const raw = await fs.readFile(LOCK_FILE, 'utf-8');
    const stat = await fs.stat(LOCK_FILE);
    if (Date.now() - stat.mtimeMs > STALE_AFTER_MS) {
      // Stale: clean up so the next caller doesn't trip on it.
      await fs.unlink(LOCK_FILE).catch(() => undefined);
      return null;
    }
    return JSON.parse(raw) as LockState;
  } catch {
    return null;
  }
}

/** Clear the lock — call when install completes (success or skip). */
export async function clearInstallActive(): Promise<void> {
  await fs.unlink(LOCK_FILE).catch(() => undefined);
}

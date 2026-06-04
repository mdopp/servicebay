/**
 * Persisted boot state for the restart/update digest (#1653, epic #1650
 * item C).
 *
 * The boot-grace digest ({@link NotificationBatcher}) wants to frame a
 * restart with context the running process can't derive from memory alone:
 *   - **version change** — was this a plain restart, or did we come up on a
 *     new release? Needs the *previous* boot's version, which only survives
 *     across the restart if it's on disk.
 *   - **recovery duration** — how long was the box down + recovering? Needs
 *     the timestamp of the last healthy moment before the restart.
 *
 * Both are persisted to a tiny JSON file in {@link DATA_DIR}. It lives
 * alongside `checks.json` so it survives an app restart (same volume) but
 * is intentionally NOT part of the config document — it's ephemeral runtime
 * breadcrumbs, not operator config, and a missing/corrupt file degrades
 * gracefully (first boot ⇒ no prior version ⇒ "restarted, no version
 * change").
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../dirs';
import { logger } from '../logger';

const BOOT_STATE_FILE = path.join(DATA_DIR, 'boot-state.json');

export interface BootState {
  /** The app version recorded at the previous boot (or last heartbeat). */
  lastSeenVersion?: string;
  /** Epoch ms of the last time the running process wrote a heartbeat.
   *  Approximates "the last healthy moment before this restart", so the
   *  digest can report downtime + recovery as a single duration. */
  lastSeenAt?: number;
}

/** Read the persisted boot state. Returns `{}` on first boot or any read /
 *  parse error — the digest treats an empty state as "no prior version". */
export function readBootState(): BootState {
  try {
    if (!fs.existsSync(BOOT_STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(BOOT_STATE_FILE, 'utf-8')) as BootState;
  } catch (e) {
    logger.warn('BootState', `Could not read boot state: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}

/** Persist the current version + heartbeat timestamp. Best-effort: a write
 *  failure is logged, never thrown (the digest is non-critical). */
export function writeBootState(state: BootState): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BOOT_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    logger.warn('BootState', `Could not write boot state: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Read the app version from package.json at the process cwd. Falls back to
 *  `0.0.0` if unreadable (matches the updater's resolution). */
export function readAppVersion(): string {
  try {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

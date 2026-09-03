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
import { z } from 'zod';
import { DATA_DIR } from '../dirs';
import { logger } from '../logger';
import { defineStore, StoreVersionError } from '../store/defineStore';

const BootStateSchema = z.object({
  /** The app version recorded at the previous boot (or last heartbeat). */
  lastSeenVersion: z.string().optional(),
  /** Epoch ms of the last time the running process wrote a heartbeat.
   *  Approximates "the last healthy moment before this restart", so the
   *  digest can report downtime + recovery as a single duration. */
  lastSeenAt: z.number().optional(),
});

export type BootState = z.infer<typeof BootStateSchema>;

/**
 * The boot-state store (#2739 adoption).
 *
 * Version 1 is the first versioned shape; `migrations[1]` names the
 * pre-`defineStore` on-disk form every existing box carries — a bare
 * `{ lastSeenVersion?, lastSeenAt? }` object with no envelope. Anything that is
 * not an object migrates to `{}`, which is what this store has always reported
 * for an unreadable file.
 *
 * Adoption also puts the write on `atomicWriteFileSync` (it used to be a bare
 * `fs.writeFileSync`, which truncates before refilling): the heartbeat fires
 * every 60 s, so a restart landing mid-write is not hypothetical.
 */
const bootStateStore = defineStore<BootState>({
  name: 'boot-state',
  file: () => path.join(DATA_DIR, 'boot-state.json'),
  version: 1,
  schema: BootStateSchema,
  migrations: {
    1: previous => (previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
  },
  fallback: () => ({}),
});

/** Read the persisted boot state. Returns `{}` on first boot or an unreadable
 *  file — the digest treats an empty state as "no prior version". A file written
 *  by a NEWER ServiceBay is the one case that is not swallowed: it throws
 *  rather than letting the next heartbeat overwrite it (ADR 0016). */
export function readBootState(): BootState {
  try {
    return bootStateStore.readSync();
  } catch (e) {
    if (e instanceof StoreVersionError) throw e;
    logger.warn('BootState', `Could not read boot state: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}

/** Persist the current version + heartbeat timestamp. Best-effort: a write
 *  failure is logged, never thrown (the digest is non-critical) — except a
 *  refusal to overwrite a newer file, which must surface. */
export function writeBootState(state: BootState): void {
  try {
    bootStateStore.writeSync(state);
  } catch (e) {
    if (e instanceof StoreVersionError) throw e;
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

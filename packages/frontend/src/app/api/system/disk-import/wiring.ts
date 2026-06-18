// Disk-import API routes — shared host wiring (issue #1697).
//
// The three disk-import routes (`list-devices` / `scan` / `apply`) are thin
// wrappers over the engine service (`@/lib/diskImport/service`). This module
// holds the only non-engine bit they share: turning the target node into a
// `SafeExec` backed by the agent's structured `safe_exec`, plus the resolved
// defaults (catalog path, share gid). Kept out of the route files so each route
// stays a few lines of request → service → response.

import { AgentExecutor } from '@/lib/agent/executor';
import { getNodeIds } from '@/lib/store/repository';
import { DATA_DIR } from '@/lib/dirs';
import { listLldapUsers } from '@/lib/lldap/client';
import type { SafeExec } from '@servicebay/disk-import-worker';

/** Numeric gid that owns file-share data (rootless-podman subgid). */
export const SHARE_GID = 1024;

/** Persistent import catalog — the resume + cross-disk delta-dedup basis. */
export function catalogPath(): string {
  return `${DATA_DIR}/disk-import-catalog.sqlite`;
}

/** Resolve the node the host commands run on (the first/only node by default). */
export function resolveNode(node?: string): string {
  return node || getNodeIds()[0] || 'Local';
}

/** Build the engine's `SafeExec` seam over the agent's structured `safe_exec`. */
export function makeExec(node: string): SafeExec {
  const executor = new AgentExecutor(node);
  return (argv, options) => executor.execSafe(argv, options ?? {});
}

/**
 * The box-user list that drives the disk-import review Owner picker + exact-match
 * owner auto-assign (#1915). Sourced from the authoritative directory (LLDAP);
 * returns the user ids (the lower-case directory convention the engine matches a
 * top-level source-dir name against). Best-effort: an unreachable/​unconfigured
 * LLDAP yields an empty list (the picker then only offers `shared`).
 */
export async function listBoxUsers(): Promise<string[]> {
  const result = await listLldapUsers().catch(() => null);
  if (!result || !result.ok) return [];
  return result.users.map(u => u.id);
}

/**
 * Immich's loopback base URL for the admin-API library provisioning (#1904).
 * Immich publishes IMMICH_PORT on the host (default 2283, the template default);
 * the backend reaches it over loopback. Honours an IMMICH_PORT override.
 */
export function immichServerUrl(): string {
  const port = process.env.IMMICH_PORT || '2283';
  return `http://127.0.0.1:${port}`;
}

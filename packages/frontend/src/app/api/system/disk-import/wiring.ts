// Disk-import API routes — shared host wiring (#1953/#1954, slice of #1949).
//
// The disk-import UI moved into the worker container and is reached via a launch
// TILE; servicebay's routes are now thin LAUNCH/STATUS glue over the worker
// container (the heavy in-process path is retired). This module holds the only
// non-launcher bit they share: turning the target node into a `SafeExec` backed
// by the agent's structured `safe_exec` (the launcher runs `podman` + `mount`
// through it), plus the resolved defaults (node, share gid).

import { AgentExecutor } from '@/lib/agent/executor';
import { getNodeIds } from '@/lib/store/repository';
import type { SafeExec } from '@servicebay/disk-import-worker';

/** FALLBACK gid for file-share data, used ONLY when the real gid can't be
 *  resolved host-side. The service layer resolves the ACTUAL file-share group
 *  (`stat -c %g` on the share data dir — 973 on the box) at launch/apply time and
 *  chowns copies to `core:<that gid>`, never a per-user uid
 *  (feedback_fileshare_relabel_crashloop). This constant is the last-resort
 *  default for a not-yet-deployed share, not the value normally used. */
export const SHARE_GID = 1024;

/** Resolve the node the host commands run on (the first/only node by default). */
export function resolveNode(node?: string): string {
  return node || getNodeIds()[0] || 'Local';
}

/** Build the launcher's `SafeExec` seam over the agent's structured `safe_exec`. */
export function makeExec(node: string): SafeExec {
  const executor = new AgentExecutor(node);
  return (argv, options) => executor.execSafe(argv, options ?? {});
}

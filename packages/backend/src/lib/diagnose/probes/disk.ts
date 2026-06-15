/**
 * `disk` probe action — registers the `show_largest_dirs` handler so
 * the operator can find what's eating /mnt/data when the probe says
 * "above 90%". The detection lives inline in the diagnose route
 * (parses `df -h /mnt/data`); this file only contributes the action.
 *
 * Returns the top 10 directories under /mnt/data sorted by size as
 * multi-line `details`, which the UI renders as a code block under
 * the row (see #291).
 */

import { agentManager } from '@/lib/agent/manager';
import { registerProbeAction, type ProbeActionResult } from '../actions';

const PROBE_ID = 'disk';

/**
 * The single source of the "what's eating /mnt/data" measurement, shared
 * by the `show_largest_dirs` probe action and the `disk_usage` MCP tool
 * (#1872) so there is exactly ONE `du` invocation in the codebase.
 *
 * -x keeps du within /mnt/data's filesystem (don't traverse podman
 * bind-mounts to host overlays). 2>/dev/null swallows the
 * permission-denied lines from rootless container subdirs that du can't
 * read; the survivors are still the meaningful candidates.
 *
 * Returns the raw `du -shx … | sort -hr | head -N` block (size<TAB>path
 * per line), trimmed; empty string when nothing is found.
 */
export async function largestDirsUnderDataDir(node: string, top = 10): Promise<string> {
  const agent = await agentManager.ensureAgent(node);
  const n = Math.max(1, Math.min(50, Math.floor(top)));
  const res = await agent.sendCommand('exec', {
    command: `du -shx /mnt/data/* 2>/dev/null | sort -hr | head -${n}`,
  }, { timeoutMs: 30_000 }) as { code?: number; stdout?: string; stderr?: string };
  return (res.stdout ?? '').trim();
}

async function showLargestDirs({ node }: { node: string }): Promise<ProbeActionResult> {
  const out = await largestDirsUnderDataDir(node, 10);
  if (!out) {
    return {
      ok: true,
      message: 'No directories found under /mnt/data — the array may be freshly mounted with nothing on it yet.',
      refresh: false,
    };
  }
  return {
    ok: true,
    message: `Top 10 directories on /mnt/data — open details below.`,
    details: out,
    refresh: false,
  };
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'show_largest_dirs',
    label: 'Show largest directories',
    description:
      'Runs `du -shx /mnt/data/* | sort -hr | head -10` and shows the top 10 by size. Use to find what to clean when storage is near full — backups, container images, snapshot volumes are the usual suspects.',
  },
  showLargestDirs,
);

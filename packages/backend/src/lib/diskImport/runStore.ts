// Disk-import — active-run handle store (#1953/#1954, slice of #1949).
//
// The heavy job now runs in the worker CONTAINER, so the control plane no longer
// keeps in-memory session bookkeeping (that O(N) session store OOM'd us — it's
// retired). servicebay only needs to remember WHICH worker run is current so a
// reopened tile can re-attach to its status.json and so "Start over" can stop the
// right container. That's a single tiny JSON handle on disk — liveness itself is
// `podman ps`, never persisted state.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '@/lib/dirs';
import type { WorkerRun } from './launcher';

const HANDLE_PATH = path.join(DATA_DIR, 'disk-import-run.json');

/** Persist the current run handle (overwrites — one active run at a time). */
export async function setActiveRun(run: WorkerRun): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${HANDLE_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(run), 'utf-8');
  await fs.rename(tmp, HANDLE_PATH);
}

/** Read the current run handle, or null when no scan has been launched. */
export async function getActiveRun(): Promise<WorkerRun | null> {
  try {
    return JSON.parse(await fs.readFile(HANDLE_PATH, 'utf-8')) as WorkerRun;
  } catch {
    return null;
  }
}

/** Forget the current run handle (the tile's "Start over"). */
export async function clearActiveRun(): Promise<void> {
  await fs.rm(HANDLE_PATH, { force: true }).catch(() => {});
}

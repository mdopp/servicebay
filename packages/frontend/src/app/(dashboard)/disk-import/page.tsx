'use client';

// Disk-import LAUNCH TILE (#1953, slice of #1949).
//
// The disk-import feature moved OUT of servicebay's process into a resource-
// capped worker CONTAINER (the architecture turn in #1949). This page is the
// thin launch tile: it picks a USB disk, launches the worker container (which
// runs the heavy walk/hash/plan in ITS OWN capped memory and serves the lazy
// review-tree app), and shows compact progress from the worker's status.json.
// The heavy review tree itself is served by the worker app behind its own
// proxied, admin-gated route — NOT rendered in this control-plane page.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, HardDrive, RefreshCw, Download, ExternalLink } from 'lucide-react';

interface DeviceView {
  path: string;
  display: string;
}

interface RunStatus {
  runId: string;
  running: boolean;
  status: {
    phase: string;
    step: string;
    // Which pass the worker/host ran — distinguishes scan-done (offer "Import
    // now") from apply-done (show the terminal "imported" state). #1981.
    mode: 'dry-run' | 'apply';
    scanned: number;
    planned: number;
    applied: number;
    conflicts: number;
    error: string | null;
  } | null;
}

/** The worker app's own proxied route (provisioned in #1954). The tile links
 *  out to it for the lazy review tree, like an immich/jellyfin tile. */
const WORKER_APP_PATH = '/disk-import-app/';

function useDevices() {
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchDevices = useCallback(() => {
    fetch('/api/system/disk-import/list-devices')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { devices?: DeviceView[] } | null) => setDevices(d?.devices ?? []))
      .finally(() => setLoading(false));
  }, []);

  // Manual refresh flips the spinner from the click handler (not an effect).
  const refresh = useCallback(() => {
    setLoading(true);
    fetchDevices();
  }, [fetchDevices]);

  useEffect(fetchDevices, [fetchDevices]);
  return { devices, loading, refresh };
}

/** POST a disk-import action, surfacing `{error}` on failure. Shared by scan +
 *  apply so the hook stays thin. Returns the failure message, or '' on success. */
async function postAction(path: string, body?: unknown): Promise<string> {
  const r = await fetch(path, {
    method: 'POST',
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (r.ok) return '';
  const d = (await r.json().catch(() => ({}))) as { error?: string };
  return d.error || 'Request failed';
}

/** Poll the active worker run + expose launch/abort. Kept out of the component
 *  so the page stays a thin render container. */
function useDiskImportRun(selected: string, onAfterAbort: () => void) {
  const [run, setRun] = useState<RunStatus | null>(null);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState('');

  // Re-attach to an already-running worker on open + poll while one is active.
  useEffect(() => {
    let active = true;
    const poll = async () => {
      const r = await fetch('/api/system/disk-import/status');
      if (!active) return;
      setRun(r.ok ? ((await r.json()) as RunStatus) : null);
    };
    void poll();
    const id = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const runAction = async (path: string, body?: unknown) => {
    setError('');
    setLaunching(true);
    try {
      setError(await postAction(path, body));
    } finally {
      setLaunching(false);
    }
  };

  const launch = () =>
    selected ? runAction('/api/system/disk-import/scan', { device: selected }) : setError('Pick a USB disk first');

  const startOver = async () => {
    await fetch('/api/system/disk-import/abort', { method: 'POST' }).catch(() => {});
    setRun(null);
    onAfterAbort();
  };

  // APPLY runs on the HOST in servicebay (#1972) — the sandboxed worker only
  // scanned/planned. POST kicks off the privileged host apply; the status poll
  // then reflects the `applying` → `done` phase the backend writes.
  const apply = () => runAction('/api/system/disk-import/apply');

  return { run, launching, error, launch, startOver, apply };
}

export default function DiskImportPage() {
  const { devices, loading, refresh } = useDevices();
  const [selected, setSelected] = useState('');
  const { run, launching, error, launch, startOver, apply } = useDiskImportRun(selected, () => {
    setSelected('');
    refresh();
  });

  return (
    <div className="p-6 max-w-2xl space-y-4 overflow-auto">
      <header className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
          <Download size={20} />
        </div>
        <div>
          <h1 className="text-lg font-bold text-gray-900 dark:text-white">Import data from a disk</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Sort a USB disk into your library. The scan runs in its own resource-capped
            container, so it can&apos;t slow down or crash the box.
          </p>
        </div>
      </header>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <TileBody
        run={run}
        devices={devices}
        loading={loading}
        selected={selected}
        launching={launching}
        onSelect={setSelected}
        onRefresh={refresh}
        onLaunch={() => void launch()}
        onApply={() => void apply()}
        onStartOver={() => void startOver()}
      />
    </div>
  );
}

type TileState = 'active' | 'apply-done' | 'plan-ready' | 'pick';

/** Map a run's compact status to the tile state to render. Pure so the boolean
 *  complexity lives in one tested spot, not inline in the render. */
function tileState(run: RunStatus | null): TileState {
  const s = run?.status;
  if (run?.running || (s && s.phase !== 'done' && s.phase !== 'error')) return 'active';
  if (s?.phase !== 'done') return 'pick';
  // Apply finished (host pass, mode `apply`) — terminal imported state, NOT the
  // "Import now" plan again (#1981).
  if (s.mode === 'apply') return 'apply-done';
  // Dry-run scan finished with a plan to apply — offer the host-apply (#1972).
  // Gating on mode==='dry-run' keeps apply-done out of this branch.
  if (s.mode === 'dry-run' && (s.planned ?? 0) > 0) return 'plan-ready';
  return 'pick';
}

/** Picks the right tile state from the run status. Kept out of the page so the
 *  page stays a thin shell and the phase-selection complexity lives here. */
function TileBody({
  run,
  devices,
  loading,
  selected,
  launching,
  onSelect,
  onRefresh,
  onLaunch,
  onApply,
  onStartOver,
}: {
  run: RunStatus | null;
  devices: DeviceView[];
  loading: boolean;
  selected: string;
  launching: boolean;
  onSelect: (path: string) => void;
  onRefresh: () => void;
  onLaunch: () => void;
  onApply: () => void;
  onStartOver: () => void;
}) {
  const state = tileState(run);
  if (state === 'active') return <WorkerProgress run={run!} onStartOver={onStartOver} />;
  if (state === 'apply-done') return <ApplyDone run={run!} onStartOver={onStartOver} />;
  if (state === 'plan-ready')
    return <PlanReady run={run!} applying={launching} onApply={onApply} onStartOver={onStartOver} />;
  return (
    <DevicePicker
      devices={devices}
      loading={loading}
      selected={selected}
      launching={launching}
      onSelect={onSelect}
      onRefresh={onRefresh}
      onLaunch={onLaunch}
    />
  );
}

/** Live worker progress (compact status.json) + a link out to the worker app's
 *  lazy review tree. */
function WorkerProgress({ run, onStartOver }: { run: RunStatus; onStartOver: () => void }) {
  const s = run.status;
  return (
    <div className="space-y-3 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <p className="text-sm text-gray-800 dark:text-gray-200 flex items-center gap-2">
        <Loader2 size={16} className="animate-spin text-blue-600" />
        {s ? s.step : 'Starting the import worker…'}
      </p>
      {s && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          <div className="flex justify-between"><dt>Scanned</dt><dd>{s.scanned}</dd></div>
          <div className="flex justify-between"><dt>Planned</dt><dd>{s.planned}</dd></div>
        </dl>
      )}
      <a
        href={WORKER_APP_PATH}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg"
      >
        <ExternalLink size={14} /> Open import app to review &amp; confirm
      </a>
      <button
        onClick={onStartOver}
        className="block text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 inline-flex items-center gap-1"
      >
        <RefreshCw size={12} /> Stop and start over
      </button>
    </div>
  );
}

/** Scan/plan complete — review out in the worker app, then APPLY on the host. */
function PlanReady({
  run,
  applying,
  onApply,
  onStartOver,
}: {
  run: RunStatus;
  applying: boolean;
  onApply: () => void;
  onStartOver: () => void;
}) {
  const s = run.status!;
  return (
    <div className="space-y-3 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <p className="text-sm text-gray-800 dark:text-gray-200">
        Scan complete — {s.planned} file(s) planned{s.conflicts ? `, ${s.conflicts} conflict(s)` : ''}.
      </p>
      <a
        href={WORKER_APP_PATH}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 text-sm text-blue-600 hover:underline"
      >
        <ExternalLink size={14} /> Review the plan
      </a>
      <div>
        <button
          onClick={onApply}
          disabled={applying}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
        >
          {applying && <Loader2 size={14} className="animate-spin" />} <Download size={14} /> Import now
        </button>
      </div>
      <button
        onClick={onStartOver}
        className="block text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 inline-flex items-center gap-1"
      >
        <RefreshCw size={12} /> Start over
      </button>
    </div>
  );
}

/** Apply finished — terminal "imported" state (#1981). Shows the count copied and
 *  a "Start over" to run another import (which aborts the now-stale run). */
function ApplyDone({ run, onStartOver }: { run: RunStatus; onStartOver: () => void }) {
  const s = run.status!;
  return (
    <div className="space-y-3 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <p className="text-sm text-gray-800 dark:text-gray-200">
        {s.applied} file(s) imported. Start over to run another import.
      </p>
      <button
        onClick={onStartOver}
        className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg"
      >
        <RefreshCw size={14} /> Start over
      </button>
    </div>
  );
}

function NoDisks({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="text-sm text-gray-500 space-y-2">
      <p className="flex items-center gap-2"><HardDrive size={16} /> No USB disk detected. Plug one in and refresh.</p>
      <button onClick={onRefresh} className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1">
        <RefreshCw size={12} /> Refresh
      </button>
    </div>
  );
}

function DevicePicker({
  devices,
  loading,
  selected,
  launching,
  onSelect,
  onRefresh,
  onLaunch,
}: {
  devices: DeviceView[];
  loading: boolean;
  selected: string;
  launching: boolean;
  onSelect: (path: string) => void;
  onRefresh: () => void;
  onLaunch: () => void;
}) {
  if (loading) {
    return (
      <div className="text-sm text-gray-500 flex items-center gap-2">
        <Loader2 className="animate-spin" size={16} /> Looking for disks…
      </div>
    );
  }
  if (devices.length === 0) return <NoDisks onRefresh={onRefresh} />;
  return (
    <div className="space-y-3 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="space-y-1">
        {devices.map(d => (
          <label key={d.path} className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200 cursor-pointer">
            <input type="radio" name="disk-import-device" value={d.path} checked={selected === d.path} onChange={() => onSelect(d.path)} />
            <HardDrive size={14} /> {d.display}
          </label>
        ))}
      </div>
      <button
        onClick={onLaunch}
        disabled={launching || !selected}
        className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
      >
        {launching && <Loader2 size={14} className="animate-spin" />} Scan disk
      </button>
    </div>
  );
}

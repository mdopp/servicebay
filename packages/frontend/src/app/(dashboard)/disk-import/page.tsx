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
import { Loader2, HardDrive, RefreshCw, Download } from 'lucide-react';
import { RoutingTree } from './_lib/RoutingTree';
import type { ReviewTree, Rule } from './_lib/types';

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
    /** Per-category rollup the worker writes when planning completes — drives the
     *  in-page review (counts of copy / skip-duplicate / conflict per category). */
    categories?: CategoryRollup[];
    totalBytes?: number;
    error: string | null;
  } | null;
}

interface CategoryRollup {
  category: string;
  files: number;
  bytes: number;
  copy: number;
  skipDupe: number;
  conflict: number;
}

/** Human-readable size (e.g. "457 GB") for the review table. */
function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** i;
  return `${val >= 100 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

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
  // scanned/planned. POST kicks off the privileged host apply; when routing rules
  // are passed (#2000) servicebay re-plans with them (re-route + re-dedup per
  // owner) BEFORE applying. The status poll reflects `applying` → `done`.
  const apply = (rules?: Record<string, Rule>, rootDefault?: Rule) =>
    runAction('/api/system/disk-import/apply', rules ? { rules, rootDefault } : undefined);

  return { run, launching, error, launch, startOver, apply };
}

/** Fetch + edit the per-folder routing tree (#2000). Holds the explicit rule map
 *  and re-fetches the tree (host-side re-resolution) on each edit so resolved
 *  rules + the live target preview stay current. */
function useRoutingTree(active: boolean) {
  const [data, setData] = useState<ReviewTree | null>(null);
  const [rules, setRules] = useState<Record<string, Rule>>({});

  const fetchTree = useCallback(async (currentRules: Record<string, Rule>) => {
    const hasEdits = Object.keys(currentRules).length > 0;
    const res = await fetch('/api/system/disk-import/tree', {
      method: hasEdits ? 'POST' : 'GET',
      ...(hasEdits
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: currentRules }) }
        : {}),
    });
    return res.ok ? ((await res.json()) as ReviewTree) : null;
  }, []);

  // Load the tree when the plan becomes ready. The setState is in the async
  // callback (post-await), guarded by a cancellation flag — never synchronous.
  useEffect(() => {
    if (!active) return;
    let live = true;
    void fetchTree({}).then(t => {
      if (live && t) setData(t);
    });
    return () => {
      live = false;
    };
  }, [active, fetchTree]);

  // Set one folder's axis (or clear it when re-picking the inherited value is not
  // needed — we keep explicit picks; the engine treats absent axes as inherited).
  const setRule = useCallback(
    (dir: string, patch: Rule) => {
      setRules(prev => {
        const next = { ...prev, [dir]: { ...prev[dir], ...patch } };
        void fetchTree(next).then(t => {
          if (t) setData(t);
        });
        return next;
      });
    },
    [fetchTree],
  );

  return { data, rules, setRule };
}

export default function DiskImportPage() {
  const { devices, loading, refresh } = useDevices();
  const [selected, setSelected] = useState('');
  const { run, launching, error, launch, startOver, apply } = useDiskImportRun(selected, () => {
    setSelected('');
    refresh();
  });
  // The routing tree is only meaningful once a scan has produced a plan to review.
  const planReady = tileState(run) === 'plan-ready';
  const { data: tree, rules, setRule } = useRoutingTree(planReady);

  return (
    <div className="p-6 max-w-3xl space-y-4 overflow-auto">
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
        tree={tree}
        rules={rules}
        onSetRule={setRule}
        onSelect={setSelected}
        onRefresh={refresh}
        onLaunch={() => void launch()}
        onApply={() => void apply(Object.keys(rules).length ? rules : undefined)}
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
  // No status doc yet → the worker was just launched and is starting up: show
  // progress while it's live, otherwise nothing is going on.
  if (!s) return run?.running ? 'active' : 'pick';
  // Drive the state off the PHASE, never off `run.running`: the #2000 routing-tree
  // worker STAYS running after a dry-run (serve mode serves the review tree +
  // replan), so liveness is always true here — gating on it kept the tile stuck on
  // progress and never showed the plan/tree.
  if (s.phase === 'done') {
    // Apply finished (host pass) — terminal imported state, not the plan again (#1981).
    if (s.mode === 'apply') return 'apply-done';
    // Dry-run scan finished with a plan to review/apply (#1972/#2000).
    if (s.mode === 'dry-run' && (s.planned ?? 0) > 0) return 'plan-ready';
    return 'pick';
  }
  if (s.phase === 'error') return 'pick';
  // scanning / planning / applying → in flight.
  return 'active';
}

/** Picks the right tile state from the run status. Kept out of the page so the
 *  page stays a thin shell and the phase-selection complexity lives here. */
function TileBody({
  run,
  devices,
  loading,
  selected,
  launching,
  tree,
  rules,
  onSetRule,
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
  tree: ReviewTree | null;
  rules: Record<string, Rule>;
  onSetRule: (dir: string, patch: Rule) => void;
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
    return (
      <PlanReady
        run={run!}
        applying={launching}
        tree={tree}
        rules={rules}
        onSetRule={onSetRule}
        onApply={onApply}
        onStartOver={onStartOver}
      />
    );
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
/** Sum a list of category rollups into a single totals row. */
function sumCategories(cats: CategoryRollup[]): Omit<CategoryRollup, 'category'> {
  return cats.reduce(
    (t, c) => ({
      files: t.files + c.files,
      bytes: t.bytes + c.bytes,
      copy: t.copy + c.copy,
      skipDupe: t.skipDupe + c.skipDupe,
      conflict: t.conflict + c.conflict,
    }),
    { files: 0, bytes: 0, copy: 0, skipDupe: 0, conflict: 0 },
  );
}

/** In-page review of the planned import — per-category copy / skip-duplicate /
 *  conflict rollup with totals. Replaces the old (dead) out-link to the worker
 *  app: the data is already in the worker's status.json, so render it here. */
function PlanReview({ status }: { status: NonNullable<RunStatus['status']> }) {
  const cats = (status.categories ?? []).filter(c => c.files > 0);
  const totals = sumCategories(cats);
  const amber = 'text-amber-600 dark:text-amber-400';
  return (
    <>
      <div>
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
          Review — {status.planned.toLocaleString()} file{status.planned === 1 ? '' : 's'} planned
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          <span className="font-medium text-blue-600 dark:text-blue-400">{totals.copy.toLocaleString()}</span> to import
          {' · '}{totals.skipDupe.toLocaleString()} duplicate{totals.skipDupe === 1 ? '' : 's'} skipped
          {totals.conflict > 0 && (
            <> {' · '}<span className={`font-medium ${amber}`}>{totals.conflict.toLocaleString()} conflict{totals.conflict === 1 ? '' : 's'}</span></>
          )}
        </p>
      </div>

      {cats.length > 0 ? (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-xs">
            <thead className="text-gray-500 dark:text-gray-400">
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <th className="py-1.5 pr-3 text-left font-medium">Category</th>
                <th className="py-1.5 px-2 text-right font-medium">Files</th>
                <th className="py-1.5 px-2 text-right font-medium">Size</th>
                <th className="py-1.5 px-2 text-right font-medium">Import</th>
                <th className="py-1.5 px-2 text-right font-medium">Dupes</th>
                <th className="py-1.5 pl-2 text-right font-medium">Conflicts</th>
              </tr>
            </thead>
            <tbody className="text-gray-700 dark:text-gray-300">
              {cats.map(c => (
                <tr key={c.category} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="py-1.5 pr-3 capitalize">{c.category}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{c.files.toLocaleString()}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{formatBytes(c.bytes)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-blue-600 dark:text-blue-400">{c.copy.toLocaleString()}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{c.skipDupe.toLocaleString()}</td>
                  <td className={`py-1.5 pl-2 text-right tabular-nums ${c.conflict ? `font-medium ${amber}` : ''}`}>
                    {c.conflict.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="font-semibold text-gray-900 dark:text-gray-100">
              <tr>
                <td className="py-1.5 pr-3">Total</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{totals.files.toLocaleString()}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{formatBytes(totals.bytes)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-blue-600 dark:text-blue-400">{totals.copy.toLocaleString()}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{totals.skipDupe.toLocaleString()}</td>
                <td className={`py-1.5 pl-2 text-right tabular-nums ${totals.conflict ? amber : ''}`}>
                  {totals.conflict.toLocaleString()}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <p className="text-xs text-gray-500 dark:text-gray-400">No category breakdown available for this run.</p>
      )}

      {totals.conflict > 0 && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          {totals.conflict.toLocaleString()} file{totals.conflict === 1 ? '' : 's'} clash with a different file headed to the same name/folder.
          These are <strong>not imported</strong> in this pass — the others import normally; nothing is overwritten.
        </p>
      )}
    </>
  );
}

/** Scan/plan complete — show the per-category summary + the per-folder routing
 *  tree (owner + target pickers), then APPLY on the host (#2000). The apply
 *  re-plans with the operator's picks first (re-route + re-dedup per owner). */
function PlanReady({
  run,
  applying,
  tree,
  rules,
  onSetRule,
  onApply,
  onStartOver,
}: {
  run: RunStatus;
  applying: boolean;
  tree: ReviewTree | null;
  rules: Record<string, Rule>;
  onSetRule: (dir: string, patch: Rule) => void;
  onApply: () => void;
  onStartOver: () => void;
}) {
  const edited = Object.keys(rules).length > 0;
  return (
    <div className="space-y-4 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <PlanReview status={run.status!} />

      <div className="space-y-2">
        <div>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Where each folder goes</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Pick an owner and a target per folder — sub-folders inherit unless you change them.
            Assigning each person their own folders splits duplicate clashes and files land in that
            person&apos;s area + their Immich.
          </p>
        </div>
        {tree ? (
          <RoutingTree data={tree} rules={rules} onSetRule={onSetRule} />
        ) : (
          <p className="text-xs text-gray-500 flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" /> Loading folders…
          </p>
        )}
      </div>

      <div>
        <button
          onClick={onApply}
          disabled={applying}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
        >
          {applying && <Loader2 size={14} className="animate-spin" />} <Download size={14} />{' '}
          {edited ? 'Re-plan & import' : 'Import now'}
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

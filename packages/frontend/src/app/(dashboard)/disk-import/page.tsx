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
import { Loader2, HardDrive, RefreshCw, Download, Save, Trash2 } from 'lucide-react';
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
  /** Files imported under a disambiguated name (a subset of `copy`, #2006). */
  renamed?: number;
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
  // True from an apply CLICK until the (now async, #2009) re-plan + host-apply reach
  // a terminal phase. Bridges the brief window where status.json still shows the
  // prior `plan-ready` before the detached re-plan/apply flips it in-flight, so the
  // tile shows progress instead of re-offering the Import button (no double-submit).
  const [flowActive, setFlowActive] = useState(false);
  const [error, setError] = useState('');

  // Re-attach to an already-running worker on open + poll while one is active.
  useEffect(() => {
    let active = true;
    const poll = async () => {
      const r = await fetch('/api/system/disk-import/status');
      if (!active) return;
      const next = r.ok ? ((await r.json()) as RunStatus) : null;
      setRun(next);
      // Clear the client flow flag (and surface a background error) once the async
      // apply flow reaches a terminal phase — the work runs detached now (#2009).
      const s = next?.status;
      if (!s) setFlowActive(false);
      else if (s.phase === 'error') {
        setFlowActive(false);
        setError(s.error || 'Import failed');
      } else if (s.phase === 'done' && s.mode === 'apply') setFlowActive(false);
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
    setFlowActive(false);
    onAfterAbort();
  };

  // APPLY runs on the HOST in servicebay (#1972) — the sandboxed worker only
  // scanned/planned. POST RETURNS PROMPTLY now (#2009): when routing rules are
  // passed (#2000) servicebay launches the detached re-plan first, then the apply
  // runs in the background. The status poll reflects `planning` → `applying` →
  // `done`; `flowActive` keeps the tile on progress for the whole flow.
  const apply = async (rules?: Record<string, Rule>, rootDefault?: Rule) => {
    setError('');
    setFlowActive(true);
    const err = await postAction('/api/system/disk-import/apply', rules ? { rules, rootDefault } : undefined);
    if (err) {
      setError(err);
      setFlowActive(false);
    }
  };

  return { run, launching, flowActive, error, launch, startOver, apply };
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

  // Replace the whole rule map at once (loading a saved preset, #2007) and
  // re-resolve the tree against it.
  const loadRules = useCallback(
    (next: Record<string, Rule>) => {
      setRules(next);
      void fetchTree(next).then(t => {
        if (t) setData(t);
      });
    },
    [fetchTree],
  );

  return { data, rules, setRule, loadRules };
}

/** A saved routing selection (#2007) — mirrors the backend `RoutingProfile`. */
interface RoutingProfile {
  name: string;
  rules: Record<string, Rule>;
  savedAt: number;
}

/** List/save/delete named routing presets (#2007). */
function useRoutingProfiles() {
  const [profiles, setProfiles] = useState<RoutingProfile[]>([]);
  const reload = useCallback(() => {
    fetch('/api/system/disk-import/profiles')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { profiles?: RoutingProfile[] } | null) => setProfiles(d?.profiles ?? []))
      .catch(() => {});
  }, []);
  useEffect(reload, [reload]);

  const save = useCallback(
    async (name: string, rules: Record<string, Rule>) => {
      await fetch('/api/system/disk-import/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, rules }),
      }).catch(() => {});
      reload();
    },
    [reload],
  );

  const remove = useCallback(
    async (name: string) => {
      await fetch(`/api/system/disk-import/profiles?name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }).catch(() => {});
      reload();
    },
    [reload],
  );

  return { profiles, save, remove };
}

export default function DiskImportPage() {
  const { devices, loading, refresh } = useDevices();
  const [selected, setSelected] = useState('');
  const { run, launching, flowActive, error, launch, startOver, apply } = useDiskImportRun(selected, () => {
    setSelected('');
    refresh();
  });
  // The routing tree is only meaningful once a scan has produced a plan to review.
  const planReady = tileState(run) === 'plan-ready';
  const { data: tree, rules, setRule, loadRules } = useRoutingTree(planReady);
  const { profiles, save: savePreset, remove: deletePreset } = useRoutingProfiles();

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
        flowActive={flowActive}
        devices={devices}
        loading={loading}
        selected={selected}
        launching={launching}
        tree={tree}
        rules={rules}
        profiles={profiles}
        onSetRule={setRule}
        onLoadPreset={loadRules}
        onSavePreset={name => void savePreset(name, rules)}
        onDeletePreset={name => void deletePreset(name)}
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
  flowActive,
  devices,
  loading,
  selected,
  launching,
  tree,
  rules,
  profiles,
  onSetRule,
  onLoadPreset,
  onSavePreset,
  onDeletePreset,
  onSelect,
  onRefresh,
  onLaunch,
  onApply,
  onStartOver,
}: {
  run: RunStatus | null;
  flowActive: boolean;
  devices: DeviceView[];
  loading: boolean;
  selected: string;
  launching: boolean;
  tree: ReviewTree | null;
  rules: Record<string, Rule>;
  profiles: RoutingProfile[];
  onSetRule: (dir: string, patch: Rule) => void;
  onLoadPreset: (rules: Record<string, Rule>) => void;
  onSavePreset: (name: string) => void;
  onDeletePreset: (name: string) => void;
  onSelect: (path: string) => void;
  onRefresh: () => void;
  onLaunch: () => void;
  onApply: () => void;
  onStartOver: () => void;
}) {
  // While an apply flow is in flight (#2009), force the progress view — even if
  // status.json momentarily still reads `plan-ready` before the detached re-plan/
  // apply flips it — so the Import button isn't briefly re-offered (no double-submit).
  const base = tileState(run);
  const state = flowActive && base !== 'apply-done' ? 'active' : base;
  if (state === 'active') return <WorkerProgress run={run!} onStartOver={onStartOver} />;
  if (state === 'apply-done') return <ApplyDone run={run!} onStartOver={onStartOver} />;
  if (state === 'plan-ready')
    return (
      <PlanReady
        run={run!}
        applying={launching}
        tree={tree}
        rules={rules}
        profiles={profiles}
        onSetRule={onSetRule}
        onLoadPreset={onLoadPreset}
        onSavePreset={onSavePreset}
        onDeletePreset={onDeletePreset}
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
function sumCategories(cats: CategoryRollup[]): Omit<CategoryRollup, 'category' | 'renamed'> & { renamed: number } {
  return cats.reduce(
    (t, c) => ({
      files: t.files + c.files,
      bytes: t.bytes + c.bytes,
      copy: t.copy + c.copy,
      skipDupe: t.skipDupe + c.skipDupe,
      conflict: t.conflict + c.conflict,
      renamed: t.renamed + (c.renamed ?? 0),
    }),
    { files: 0, bytes: 0, copy: 0, skipDupe: 0, conflict: 0, renamed: 0 },
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
          {totals.renamed > 0 && (
            <> {' ('}{totals.renamed.toLocaleString()} renamed to avoid clashes{')'}</>
          )}
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
                <th className="py-1.5 px-2 text-right font-medium">Renamed</th>
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
                  <td className="py-1.5 px-2 text-right tabular-nums">{(c.renamed ?? 0).toLocaleString()}</td>
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
                <td className="py-1.5 px-2 text-right tabular-nums">{totals.renamed.toLocaleString()}</td>
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

      {totals.renamed > 0 && (
        <p className="rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
          {totals.renamed.toLocaleString()} file{totals.renamed === 1 ? '' : 's'} shared a name with a <strong>different</strong> file headed to the same folder
          (e.g. two cameras both naming a photo <code>IMG_0001.jpg</code>). Each is imported under a disambiguated
          name like <code>IMG_0001 (2).jpg</code> — <strong>nothing is dropped and nothing is overwritten</strong>.
        </p>
      )}

      {totals.conflict > 0 && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          {totals.conflict.toLocaleString()} file{totals.conflict === 1 ? '' : 's'} match a previously imported target with different
          content — the earlier copy is preserved under <code>_superseded/</code> and the newer one imported. Nothing is lost.
        </p>
      )}
    </>
  );
}

/** Save / load named routing presets (#2007). Loading a preset replaces the whole
 *  rule map; Save persists the current picks under a name (disabled until something
 *  is picked + a name typed). Lets the operator re-run a 30+-folder selection on a
 *  fresh scan with zero re-entry. */
function RoutingPresets({
  profiles,
  edited,
  onLoad,
  onSave,
  onDelete,
}: {
  profiles: RoutingProfile[];
  edited: boolean;
  onLoad: (rules: Record<string, Rule>) => void;
  onSave: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs rounded-lg bg-gray-50 dark:bg-gray-800/40 px-2.5 py-2">
      <span className="text-gray-500 dark:text-gray-400">Saved selections:</span>
      <select
        value={selected}
        onChange={e => {
          const picked = e.target.value;
          setSelected(picked);
          const p = profiles.find(x => x.name === picked);
          if (p) onLoad(p.rules);
        }}
        className="rounded border px-1.5 py-1 bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-200"
      >
        <option value="">{profiles.length ? 'Load a preset…' : 'No saved presets'}</option>
        {profiles.map(p => (
          <option key={p.name} value={p.name}>{p.name}</option>
        ))}
      </select>
      {selected && (
        <button
          onClick={() => {
            onDelete(selected);
            setSelected('');
          }}
          className="inline-flex items-center gap-1 text-red-600 hover:text-red-700 dark:text-red-400"
          title={`Delete preset “${selected}”`}
        >
          <Trash2 size={12} /> Delete
        </button>
      )}
      <span className="mx-1 text-gray-300 dark:text-gray-600">|</span>
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Name this selection"
        className="rounded border px-2 py-1 bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-200"
      />
      <button
        onClick={() => {
          onSave(name.trim());
          setName('');
        }}
        disabled={!edited || !name.trim()}
        className="inline-flex items-center gap-1 rounded bg-gray-200 dark:bg-gray-700 px-2 py-1 font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50"
        title={edited ? 'Save the current owner/target picks as a named preset' : 'Pick owners/targets first'}
      >
        <Save size={12} /> Save selection
      </button>
    </div>
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
  profiles,
  onSetRule,
  onLoadPreset,
  onSavePreset,
  onDeletePreset,
  onApply,
  onStartOver,
}: {
  run: RunStatus;
  applying: boolean;
  tree: ReviewTree | null;
  rules: Record<string, Rule>;
  profiles: RoutingProfile[];
  onSetRule: (dir: string, patch: Rule) => void;
  onLoadPreset: (rules: Record<string, Rule>) => void;
  onSavePreset: (name: string) => void;
  onDeletePreset: (name: string) => void;
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
        <RoutingPresets
          profiles={profiles}
          edited={edited}
          onLoad={onLoadPreset}
          onSave={onSavePreset}
          onDelete={onDeletePreset}
        />
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

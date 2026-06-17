'use client';

// Settings → "Import data" card (issue #1697).
//
// Wraps the disk-import engine in the family-facing flow: pick a USB device →
// run a scan → review the plan → CONFIRM → apply with progress. The flow is the
// product feature for families migrating off the cloud.
//
// UX (memory `feedback_ux_philosophy`): the deterministic engine self-sorts
// silently; the only thing the card asks the user is (a) which device and (b)
// the explicit CONFIRM of the reviewed plan before any host write. Unavoidable
// ambiguity (folders the classifier couldn't place, target conflicts) surfaces
// as Diagnose-style `actions[]` — advisory follow-ups that DON'T block the apply
// (the plan has a safe default for each).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, HardDrive, AlertCircle, CheckCircle2, RefreshCw, Download, Folder } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import { useImportJob, type JobProgress, type JobStatus } from '../useImportJob';
import {
  DISPOSITION_OPTIONS,
  effectiveRule,
  isInherited,
  targetPreview,
  type Disposition,
  type FolderNode,
  type Owner,
  type Rule,
} from '../routingTree';

interface DeviceView {
  path: string;
  display: string;
}

interface CategorySummary {
  category: string;
  files: number;
  bytes: number;
  copy: number;
  skipDupe: number;
  conflict: number;
}

interface ImportActionItem {
  id: string;
  kind: 'ambiguous-folder' | 'conflict';
  label: string;
  subject: string;
  defaultOutcome: string;
}

export interface ScanReview {
  sessionId: string;
  device: string;
  totalFiles: number;
  totalBytes: number;
  categories: CategorySummary[];
  actions: ImportActionItem[];
  /** The per-folder routing tree (#1915). */
  tree?: FolderNode[];
  /** Box users driving the Owner picker (#1915). */
  boxUsers?: string[];
  /** The disk-default owner seeding the root (#1915). */
  defaultOwner?: Owner;
}

type Phase = 'pick' | 'scanning' | 'review' | 'applying' | 'done';

/** POST a JSON body to a disk-import route, returning `{ jobId?, error? }`. */
async function postJob(
  url: string,
  body: Record<string, unknown>,
): Promise<{ jobId?: string; error?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
  if (!res.ok) return { error: data.error || `HTTP ${res.status}` };
  return data;
}

/**
 * Set (or clear, when `value === undefined`) one axis of a folder's explicit rule
 * (#1915). Clearing the last axis drops the dir from the map so it reverts to pure
 * inheritance. Returns a new map (immutable update).
 */
function applyRuleEdit(
  prev: Record<string, Rule>,
  dir: string,
  axis: keyof Rule,
  value: Rule[keyof Rule] | undefined,
): Record<string, Rule> {
  const next = { ...prev };
  const node: Rule = { ...next[dir] };
  if (value === undefined) delete node[axis];
  else (node[axis] as Rule[keyof Rule]) = value;
  if (Object.keys(node).length === 0) delete next[dir];
  else next[dir] = node;
  return next;
}

/**
 * Seed the review-edit map from a landed review (#1915): each node's own explicit
 * rule (e.g. an exact-match auto-assigned owner) becomes the initial edit, plus
 * the disk-default owner. Auto-assignments show pre-selected AND stay overridable.
 */
function seedRules(r: ScanReview): { rules: Record<string, Rule>; defaultOwner: Owner } {
  const rules: Record<string, Rule> = {};
  for (const node of r.tree ?? []) {
    if (node.explicit && Object.keys(node.explicit).length > 0) rules[node.dir] = { ...node.explicit };
  }
  return { rules, defaultOwner: r.defaultOwner ?? 'shared' };
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Per-category sizing table. */
function CategoryTable({ categories }: { categories: CategorySummary[] }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-gray-500 dark:text-gray-400">
          <th className="py-1">Category</th>
          <th className="py-1 text-right">Files</th>
          <th className="py-1 text-right">Size</th>
          <th className="py-1 text-right">New</th>
          <th className="py-1 text-right">Duplicate</th>
        </tr>
      </thead>
      <tbody>
        {categories.map(c => (
          <tr key={c.category} className="border-t border-gray-100 dark:border-gray-800">
            <td className="py-1 capitalize text-gray-800 dark:text-gray-200">{c.category}</td>
            <td className="py-1 text-right">{c.files}</td>
            <td className="py-1 text-right">{formatBytes(c.bytes)}</td>
            <td className="py-1 text-right">{c.copy}</td>
            <td className="py-1 text-right">{c.skipDupe}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The non-blocking, advisory actions[] list (ambiguous folders / conflicts). */
function ReviewActions({ actions }: { actions: ImportActionItem[] }) {
  if (actions.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="disk-import-actions">
      <h5 className="text-xs font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1">
        <AlertCircle size={12} /> {actions.length} item(s) to double-check (optional)
      </h5>
      <ul className="space-y-1">
        {actions.map(a => (
          <li
            key={a.id}
            className="text-[11px] text-gray-600 dark:text-gray-400 rounded-md border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 px-2 py-1"
          >
            <span className="font-medium text-gray-800 dark:text-gray-200">{a.label}</span> — {a.defaultOutcome}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-gray-400">
        These don&apos;t block the import — everything else is sorted and ready.
      </p>
    </div>
  );
}

/** Owner picker — `shared` + every box user. Reflects inherited vs explicit. */
function OwnerPicker({
  value,
  inherited,
  boxUsers,
  onChange,
}: {
  value: Owner;
  inherited: boolean;
  boxUsers: string[];
  onChange: (owner: Owner | undefined) => void;
}) {
  return (
    <select
      aria-label="Owner"
      className={`text-[11px] rounded border px-1 py-0.5 bg-white dark:bg-gray-900 ${
        inherited
          ? 'border-dashed border-gray-300 dark:border-gray-600 text-gray-500 italic'
          : 'border-gray-400 dark:border-gray-500 text-gray-900 dark:text-gray-100'
      }`}
      value={inherited ? '__inherit__' : value}
      onChange={e => onChange(e.target.value === '__inherit__' ? undefined : e.target.value)}
    >
      <option value="__inherit__">Inherited ({value})</option>
      <option value="shared">Shared</option>
      {boxUsers.map(u => (
        <option key={u} value={u}>
          {u}
        </option>
      ))}
    </select>
  );
}

/** Disposition picker — the full v1 set. Reflects inherited vs explicit. */
function DispositionPicker({
  value,
  inherited,
  onChange,
}: {
  value: Disposition;
  inherited: boolean;
  onChange: (disposition: Disposition | undefined) => void;
}) {
  const label = (d: Disposition) => DISPOSITION_OPTIONS.find(o => o.value === d)?.label ?? d;
  return (
    <select
      aria-label="Disposition"
      className={`text-[11px] rounded border px-1 py-0.5 bg-white dark:bg-gray-900 ${
        inherited
          ? 'border-dashed border-gray-300 dark:border-gray-600 text-gray-500 italic'
          : 'border-gray-400 dark:border-gray-500 text-gray-900 dark:text-gray-100'
      }`}
      value={inherited ? '__inherit__' : value}
      onChange={e =>
        onChange(e.target.value === '__inherit__' ? undefined : (e.target.value as Disposition))
      }
    >
      <option value="__inherit__">Inherited ({label(value)})</option>
      {DISPOSITION_OPTIONS.map(o => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Display label for a relative dir (`(disk root)` for the empty root). */
function dirLabel(dir: string): string {
  if (dir === '') return '(disk root)';
  const segs = dir.split('/');
  return segs[segs.length - 1];
}

/** One folder row in the routing tree: pickers + resolved-target preview (#1915). */
function TreeRow({
  node,
  explicit,
  defaultOwner,
  boxUsers,
  onChange,
}: {
  node: FolderNode;
  explicit: Map<string, Rule>;
  defaultOwner: Owner;
  boxUsers: string[];
  onChange: (dir: string, axis: keyof Rule, value: Rule[keyof Rule] | undefined) => void;
}) {
  const depth = node.dir === '' ? 0 : node.dir.split('/').length;
  const resolved = effectiveRule(node.dir, explicit, defaultOwner);
  return (
    <div
      data-testid={`tree-node-${node.dir || 'root'}`}
      className="flex flex-wrap items-center gap-2 rounded px-1 py-1 text-xs hover:bg-gray-50 dark:hover:bg-gray-800/50"
      style={{ paddingLeft: `${depth * 14 + 4}px` }}
    >
      <span className="inline-flex items-center gap-1 min-w-0 text-gray-800 dark:text-gray-200">
        <Folder size={12} className="shrink-0 text-gray-400" />
        <span className="truncate font-medium">{dirLabel(node.dir)}</span>
        {node.files > 0 && <span className="text-gray-400">({node.files})</span>}
      </span>
      <DispositionPicker
        value={resolved.disposition}
        inherited={isInherited(node.dir, 'disposition', explicit)}
        onChange={v => onChange(node.dir, 'disposition', v)}
      />
      <OwnerPicker
        value={resolved.owner}
        inherited={isInherited(node.dir, 'owner', explicit)}
        boxUsers={boxUsers}
        onChange={v => onChange(node.dir, 'owner', v)}
      />
      <span
        className="text-[11px] text-gray-500 dark:text-gray-400 font-mono"
        data-testid={`tree-target-${node.dir || 'root'}`}
      >
        → {targetPreview(resolved, node.categories)}
      </span>
    </div>
  );
}

/**
 * The per-folder routing tree (#1915): one row per directory, indented by depth,
 * with a disposition + owner picker, a resolved `data/<owner>/<category>/…`
 * target preview, and inherited-vs-explicit styling (inherited values render
 * dashed/italic; explicit picks render solid). Editing a node updates the
 * `rules` map (cleared back to inherit when the user re-picks "Inherited").
 */
export function DiskImportTree({
  nodes,
  rules,
  defaultOwner,
  boxUsers,
  onChange,
}: {
  nodes: FolderNode[];
  rules: Record<string, Rule>;
  defaultOwner: Owner;
  boxUsers: string[];
  onChange: (dir: string, axis: keyof Rule, value: Rule[keyof Rule] | undefined) => void;
}) {
  const explicit = useMemo(() => new Map<string, Rule>(Object.entries(rules)), [rules]);
  if (nodes.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="disk-import-tree">
      <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-300">Per-folder routing</h5>
      <p className="text-[11px] text-gray-400">
        Each folder inherits from its parent. Override a folder to change where it (and its subfolders)
        lands.
      </p>
      <div className="space-y-0.5">
        {nodes.map(node => (
          <TreeRow
            key={node.dir || '__root__'}
            node={node}
            explicit={explicit}
            defaultOwner={defaultOwner}
            boxUsers={boxUsers}
            onChange={onChange}
          />
        ))}
      </div>
    </div>
  );
}

/** "Whose disk is this?" — the disk-default owner seeding the tree root (#1915). */
function DefaultOwnerPicker({
  value,
  boxUsers,
  onChange,
}: {
  value: Owner;
  boxUsers: string[];
  onChange: (owner: Owner) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
      Whose disk is this?
      <select
        aria-label="Disk default owner"
        className="text-[11px] rounded border border-gray-400 dark:border-gray-500 px-1 py-0.5 bg-white dark:bg-gray-900"
        value={value}
        onChange={e => onChange(e.target.value)}
      >
        <option value="shared">Shared (everyone)</option>
        {boxUsers.map(u => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Presentational review: per-category sizing + the non-blocking actions[]. */
/**
 * Non-blocking duplicate-check line under the review header (#1937). Review-first:
 * the tree is fully usable the moment the scan reviews; this just tells the user
 * the duplicate preview is still filling in (or is done) — it never gates the
 * tree or the Confirm button. `done` shows nothing (no noise); `pending`/`running`
 * shows a "checking duplicates… N / M" note; `partial` notes some files couldn't
 * be checked (they're imported un-deduped — apply re-dedups, so it's safe).
 */
function DedupNote({
  dedup,
}: {
  dedup?: { state: 'pending' | 'running' | 'done' | 'partial'; hashed: number; total: number };
}) {
  if (!dedup || dedup.state === 'done') return null;
  if (dedup.state === 'partial') {
    return (
      <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="disk-import-dedup">
        Some files couldn&apos;t be checked for duplicates — they&apos;ll be imported as-is (de-duplicated
        on copy).
      </p>
    );
  }
  const count = dedup.total > 0 ? ` ${dedup.hashed} / ${dedup.total}` : '';
  return (
    <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="disk-import-dedup">
      Checking for duplicates in the background…{count} You can review and import now.
    </p>
  );
}

export function DiskImportReview({
  review,
  rules,
  defaultOwner,
  onRuleChange,
  onDefaultOwnerChange,
  onConfirm,
  onCancel,
  busy,
  dedup,
}: {
  review: ScanReview;
  rules: Record<string, Rule>;
  defaultOwner: Owner;
  onRuleChange: (dir: string, axis: keyof Rule, value: Rule[keyof Rule] | undefined) => void;
  onDefaultOwnerChange: (owner: Owner) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  /** Non-blocking background-dedup status (#1937): the tree is fully reviewable
   *  while duplicate detection finishes in the background. Omit on a pre-#1937
   *  backend. */
  dedup?: { state: 'pending' | 'running' | 'done' | 'partial'; hashed: number; total: number };
}) {
  const boxUsers = review.boxUsers ?? [];
  return (
    <div className="space-y-4" data-testid="disk-import-review">
      <div>
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Review before importing</h4>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {review.totalFiles} files · {formatBytes(review.totalBytes)} from {review.device}. Nothing has
          been written yet.
        </p>
        <DedupNote dedup={dedup} />
      </div>

      {(review.tree?.length ?? 0) > 0 && (
        <DefaultOwnerPicker value={defaultOwner} boxUsers={boxUsers} onChange={onDefaultOwnerChange} />
      )}

      {review.tree && review.tree.length > 0 && (
        <DiskImportTree
          nodes={review.tree}
          rules={rules}
          defaultOwner={defaultOwner}
          boxUsers={boxUsers}
          onChange={onRuleChange}
        />
      )}

      <CategoryTable categories={review.categories} />
      <ReviewActions actions={review.actions} />

      <ConfirmBar onConfirm={onConfirm} onCancel={onCancel} busy={busy} />
    </div>
  );
}

/** The explicit confirm/cancel gate at the foot of the review (#1697). */
function ConfirmBar({
  onConfirm,
  onCancel,
  busy,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <button
        onClick={onConfirm}
        disabled={busy}
        className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
      >
        {busy && <Loader2 size={14} className="animate-spin" />} Confirm &amp; import
      </button>
      <button
        onClick={onCancel}
        disabled={busy}
        className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-800 dark:text-gray-200 text-sm font-medium rounded-lg disabled:opacity-50"
      >
        Cancel
      </button>
    </div>
  );
}

/** Card frame matching the other Sharing sections (e.g. FileShareSection). */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
          <Download size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-gray-900 dark:text-white">Import data</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">Sort a USB disk into your library</p>
        </div>
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

/** The device-picker body (presentational): list / empty / loading + scan. */
function DevicePicker({
  devices,
  selected,
  loading,
  scanning,
  onSelect,
  onRefresh,
  onScan,
}: {
  devices: DeviceView[];
  selected: string;
  loading: boolean;
  scanning: boolean;
  onSelect: (path: string) => void;
  onRefresh: () => void;
  onScan: () => void;
}) {
  if (loading) {
    return (
      <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2">
        <Loader2 className="animate-spin" size={16} /> Looking for disks…
      </div>
    );
  }
  if (devices.length === 0) {
    return (
      <div className="text-sm text-gray-500 dark:text-gray-400 space-y-2">
        <p className="flex items-center gap-2">
          <HardDrive size={16} /> No USB disk detected. Plug one in and refresh.
        </p>
        <button onClick={onRefresh} className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        {devices.map(d => (
          <label
            key={d.path}
            className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200 cursor-pointer"
          >
            <input
              type="radio"
              name="disk-import-device"
              value={d.path}
              checked={selected === d.path}
              onChange={() => onSelect(d.path)}
            />
            <HardDrive size={14} /> {d.display}
          </label>
        ))}
      </div>
      <button
        onClick={onScan}
        disabled={scanning || !selected}
        className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
      >
        {scanning && <Loader2 size={14} className="animate-spin" />} Scan disk
      </button>
    </div>
  );
}

/** The "done" body (presentational). */
function ImportDone({ applied, onReset }: { applied: number; onReset: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-800 dark:text-gray-200 flex items-center gap-2">
        <CheckCircle2 size={16} className="text-green-600" /> Imported {applied} file(s) into your library.
      </p>
      <button
        onClick={onReset}
        className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-800 dark:text-gray-200 text-sm font-medium rounded-lg"
      >
        <RefreshCw size={14} /> Import another disk
      </button>
    </div>
  );
}

const STEP_LABEL: Record<JobProgress['step'], string> = {
  mount: 'Mounting the disk…',
  walk: 'Listing files…',
  hash: 'Checking for duplicates…',
  plan: 'Planning the import…',
  copy: 'Copying files…',
  done: 'Finishing up…',
};

/** Live phase + counts while a scan or apply runs in the background (#1897). */
export function JobProgressView({ status }: { status: JobStatus | null }) {
  const p = status?.progress;
  const isApply = status?.phase === 'applying';
  return (
    <div className="space-y-3" data-testid="disk-import-progress">
      <p className="text-sm text-gray-800 dark:text-gray-200 flex items-center gap-2">
        <Loader2 size={16} className="animate-spin text-blue-600" />
        {p ? STEP_LABEL[p.step] : 'Starting…'}
      </p>
      {p && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          {!isApply && (
            <>
              <div className="flex justify-between">
                <dt>Scanned</dt>
                <dd className="text-gray-800 dark:text-gray-200">{p.scanned}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Hashed</dt>
                <dd className="text-gray-800 dark:text-gray-200">
                  {p.total > 0 ? `${p.hashed} / ${p.total}` : p.hashed}
                </dd>
              </div>
            </>
          )}
          {isApply && (
            <>
              <div className="flex justify-between">
                <dt>Copied</dt>
                <dd className="text-gray-800 dark:text-gray-200">
                  {p.total > 0 ? `${p.copied} / ${p.total}` : p.copied}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt>Bytes</dt>
                <dd className="text-gray-800 dark:text-gray-200">{formatBytes(p.bytes)}</dd>
              </div>
            </>
          )}
        </dl>
      )}
      <p className="text-[11px] text-gray-400">
        This keeps running even if you close the page — reopen this card to check back.
      </p>
    </div>
  );
}

/**
 * The USB device list + selection (#1697). Polls `list-devices`, auto-selects a
 * lone device, and exposes a manual refresh. State is only set inside the async
 * callbacks (never synchronously in render) so it's effect-safe.
 */
function useDeviceList() {
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [loadingDevices, setLoadingDevices] = useState(true);

  const fetchDevices = useCallback(() => {
    fetch('/api/system/disk-import/list-devices')
      .then(r => (r.ok ? r.json() : null))
      .then((data: { devices?: DeviceView[] } | null) => {
        const list = data?.devices ?? [];
        setDevices(list);
        if (list.length === 1) setSelected(list[0].path);
      })
      .finally(() => setLoadingDevices(false));
  }, []);

  // Manual refresh: flip the spinner, then re-fetch (deferred so the click
  // handler — not an effect — owns the synchronous setState).
  const refreshDevices = useCallback(() => {
    setLoadingDevices(true);
    fetchDevices();
  }, [fetchDevices]);

  useEffect(fetchDevices, [fetchDevices]);

  return { devices, selected, setSelected, loadingDevices, refreshDevices };
}

/** Setters the import-job bindings drive on a terminal scan/apply transition. */
interface ImportJobSetters {
  setReview: (r: ScanReview | null) => void;
  setApplied: (n: number) => void;
  setPhase: (p: Phase) => void;
  seedFromReview: (r: ScanReview | null) => void;
  addToast: ReturnType<typeof useToast>['addToast'];
}

/**
 * Wire useImportJob's terminal transitions (#1897) into the card's phase/review/
 * applied state. Kept out of the host so the host stays a thin state container.
 */
function useImportJobBindings(s: ImportJobSetters) {
  return useImportJob({
    onReviewed: review => {
      s.setReview(review as ScanReview | null);
      s.seedFromReview(review as ScanReview | null);
      s.setPhase('review');
    },
    onApplied: count => {
      s.setApplied(count);
      s.setPhase('done');
      s.addToast('success', 'Import finished');
    },
    onError: (kind, message, review) => {
      const wasApply = kind === 'applying';
      s.addToast('error', wasApply ? 'Import failed' : 'Scan failed', message);
      s.setReview(review as ScanReview | null);
      if (wasApply && review) s.seedFromReview(review as ScanReview | null);
      s.setPhase(wasApply && review ? 'review' : 'pick');
    },
    onGone: () => s.setPhase('pick'),
  });
}

type Track = ReturnType<typeof useImportJob>['track'];
type Toast = ReturnType<typeof useToast>['addToast'];

/**
 * Kick off a background scan/apply job (#1897): POST the route, start polling on
 * the returned id, or toast + fall back to `failPhase` on any error.
 */
function makeStartJob(track: Track, addToast: Toast, setPhase: (p: Phase) => void) {
  return async (
    url: string,
    payload: Record<string, unknown>,
    label: string,
    runningPhase: 'scanning' | 'applying',
    failPhase: Phase,
  ): Promise<void> => {
    try {
      const data = await postJob(url, payload);
      if (!data.jobId) {
        addToast('error', label, data.error || 'no job id');
        setPhase(failPhase);
        return;
      }
      track(data.jobId, runningPhase);
    } catch {
      addToast('error', label);
      setPhase(failPhase);
    }
  };
}

/**
 * The scan / apply / reset action handlers (#1697). Kept out of the host so the
 * component is a thin state + render container. Each kicks off a background job
 * (#1897) and threads the review edits (#1915) into the apply call.
 */
function useImportActions(c: {
  job: ReturnType<typeof useImportJob>;
  selected: string;
  review: ScanReview | null;
  rules: Record<string, Rule>;
  defaultOwner: Owner;
  addToast: Toast;
  setPhase: (p: Phase) => void;
  setReview: (r: ScanReview | null) => void;
  setApplied: (n: number | null) => void;
  setSelected: (s: string) => void;
  setRules: (r: Record<string, Rule>) => void;
  setDefaultOwner: (o: Owner) => void;
  refreshDevices: () => void;
}) {
  const { job, addToast, setPhase } = c;
  const startJob = makeStartJob(job.track, addToast, setPhase);

  const runScan = async () => {
    if (!c.selected) return void addToast('error', 'Pick a USB device first');
    setPhase('scanning');
    await startJob('/api/system/disk-import/scan', { device: c.selected }, 'Scan failed', 'scanning', 'pick');
  };

  const applyPlan = async () => {
    if (!c.review) return;
    setPhase('applying');
    // Only send the routing tree when the user actually has edits (or a non-shared
    // default owner) — an unedited plan applies exactly as reviewed.
    const hasEdits = Object.keys(c.rules).length > 0 || c.defaultOwner !== 'shared';
    const payload = { sessionId: c.review.sessionId, confirmed: true, ...(hasEdits ? { rules: c.rules, defaultOwner: c.defaultOwner } : {}) };
    await startJob('/api/system/disk-import/apply', payload, 'Import failed', 'applying', 'review');
  };

  const reset = () => {
    c.setReview(null);
    c.setApplied(null);
    c.setSelected('');
    c.setRules({});
    c.setDefaultOwner('shared');
    job.clear();
    setPhase('pick');
    c.refreshDevices();
  };

  return { runScan, applyPlan, reset };
}

export default function DiskImportSection() {
  const { addToast } = useToast();
  const { devices, selected, setSelected, loadingDevices, refreshDevices } = useDeviceList();
  const [phase, setPhase] = useState<Phase>('pick');
  const [review, setReview] = useState<ScanReview | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  // The user's review-tree edits (#1915): per-dir explicit rules + the disk
  // default owner. Seeded from the scan's auto-assigned tree on review; threaded
  // to the apply call so owner/disposition edits move the resolved targets.
  const [rules, setRules] = useState<Record<string, Rule>>({});
  const [defaultOwner, setDefaultOwner] = useState<Owner>('shared');

  // Seed the edit state from a freshly-landed review (auto-assigned owners show
  // pre-selected AND remain overridable) via the module-level `seedRules` helper.
  const seedFromReview = useCallback((r: ScanReview | null) => {
    if (!r) return;
    const seeded = seedRules(r);
    setRules(seeded.rules);
    setDefaultOwner(seeded.defaultOwner);
  }, []);

  const job = useImportJobBindings({ setReview, setApplied, setPhase, seedFromReview, addToast });

  // Set (or clear, when value === undefined) one axis of a folder's explicit
  // rule via the module-level `applyRuleEdit` reducer. Functional update — never
  // reads stale `rules`.
  const onRuleChange = useCallback(
    (dir: string, axis: keyof Rule, value: Rule[keyof Rule] | undefined) => {
      setRules(prev => applyRuleEdit(prev, dir, axis, value));
    },
    [],
  );

  const { runScan, applyPlan, reset } = useImportActions({
    job, selected, review, rules, defaultOwner, addToast, setPhase,
    setReview, setApplied, setSelected, setRules, setDefaultOwner, refreshDevices,
  });

  // Surface the background-dedup status (#1937) so the review shows a non-blocking
  // "checking duplicates…" line while the tree is already fully usable.
  const dedup = review && job.status?.phase === 'reviewed'
    ? {
        state: job.status.dedup ?? 'done',
        hashed: job.status.dedupHashed ?? 0,
        total: job.status.dedupTotal ?? 0,
      }
    : undefined;

  const reviewProps = review && {
    review, rules, defaultOwner, onRuleChange,
    onDefaultOwnerChange: setDefaultOwner, onConfirm: applyPlan, onCancel: reset, busy: false,
    dedup,
  };

  return (
    <DiskImportBody
      phase={phase}
      jobActive={job.active}
      jobStatus={job.status}
      review={reviewProps}
      pick={{ devices, selected, loading: loadingDevices, scanning: false, onSelect: setSelected, onRefresh: refreshDevices, onScan: runScan }}
      done={{ applied: applied ?? 0, onReset: reset }}
    />
  );
}

/** Phase-driven render of the import card body (kept out of the stateful host). */
function DiskImportBody({
  phase,
  jobActive,
  jobStatus,
  review,
  pick,
  done,
}: {
  phase: Phase;
  jobActive: boolean;
  jobStatus: JobStatus | null;
  review: React.ComponentProps<typeof DiskImportReview> | null | false;
  pick: React.ComponentProps<typeof DevicePicker>;
  done: React.ComponentProps<typeof ImportDone>;
}) {
  if (phase === 'review' && review) {
    return (
      <Card>
        <DiskImportReview {...review} />
      </Card>
    );
  }

  // Background scan or apply in flight: live phase + counts from the poll
  // (#1897), not a bare spinner. Covers a fresh run, the gap before the first
  // poll lands, AND a cold re-attach after a reload/restart (a still-running job
  // is `active` from localStorage before the card's own phase has caught up).
  if (phase === 'scanning' || phase === 'applying' || jobActive) {
    return (
      <Card>
        <JobProgressView status={jobStatus} />
      </Card>
    );
  }

  if (phase === 'done') {
    return (
      <Card>
        <ImportDone {...done} />
      </Card>
    );
  }

  return (
    <Card>
      <div className="space-y-4">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Plug in a USB disk and we&apos;ll sort your photos, music and documents into the right place. You
          review the plan before anything is copied.
        </p>
        <DevicePicker {...pick} />
      </div>
    </Card>
  );
}

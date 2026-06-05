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

import { useCallback, useEffect, useState } from 'react';
import { Loader2, HardDrive, AlertCircle, CheckCircle2, RefreshCw, Download } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

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
}

type Phase = 'pick' | 'scanning' | 'review' | 'applying' | 'done';

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

/** Presentational review: per-category sizing + the non-blocking actions[]. */
export function DiskImportReview({
  review,
  onConfirm,
  onCancel,
  busy,
}: {
  review: ScanReview;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-4" data-testid="disk-import-review">
      <div>
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Review before importing</h4>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {review.totalFiles} files · {formatBytes(review.totalBytes)} from {review.device}. Nothing has
          been written yet.
        </p>
      </div>

      <CategoryTable categories={review.categories} />
      <ReviewActions actions={review.actions} />

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

export default function DiskImportSection() {
  const { addToast } = useToast();
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('pick');
  const [review, setReview] = useState<ScanReview | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  const [loadingDevices, setLoadingDevices] = useState(true);

  // Fetch the device list. Only sets state from inside the (async) promise
  // callbacks — never synchronously — so it's safe to call from an effect
  // without the "cascading renders" lint.
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

  const runScan = async () => {
    if (!selected) {
      addToast('error', 'Pick a USB device first');
      return;
    }
    setPhase('scanning');
    try {
      const res = await fetch('/api/system/disk-import/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: selected }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        addToast('error', 'Scan failed', data.error || `HTTP ${res.status}`);
        setPhase('pick');
        return;
      }
      setReview(data as ScanReview);
      setPhase('review');
    } catch {
      addToast('error', 'Scan failed');
      setPhase('pick');
    }
  };

  const applyPlan = async () => {
    if (!review) return;
    setPhase('applying');
    try {
      const res = await fetch('/api/system/disk-import/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: review.sessionId, confirmed: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        addToast('error', 'Import failed', data.error || `HTTP ${res.status}`);
        setPhase('review');
        return;
      }
      setApplied(typeof data.applied === 'number' ? data.applied : 0);
      setPhase('done');
      addToast('success', 'Import finished');
    } catch {
      addToast('error', 'Import failed');
      setPhase('review');
    }
  };

  const reset = () => {
    setReview(null);
    setApplied(null);
    setSelected('');
    setPhase('pick');
    refreshDevices();
  };

  if (phase === 'review' && review) {
    return (
      <Card>
        <DiskImportReview review={review} onConfirm={applyPlan} onCancel={reset} busy={false} />
      </Card>
    );
  }

  if (phase === 'applying' && review) {
    return (
      <Card>
        <DiskImportReview review={review} onConfirm={() => {}} onCancel={() => {}} busy />
      </Card>
    );
  }

  if (phase === 'done') {
    return (
      <Card>
        <ImportDone applied={applied ?? 0} onReset={reset} />
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
        <DevicePicker
          devices={devices}
          selected={selected}
          loading={loadingDevices}
          scanning={phase === 'scanning'}
          onSelect={setSelected}
          onRefresh={refreshDevices}
          onScan={runScan}
        />
      </div>
    </Card>
  );
}

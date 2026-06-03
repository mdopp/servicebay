'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, HardDrive, Usb, CheckCircle2 } from 'lucide-react';
import type { MountCandidate } from '@/lib/backup/mounts';

const REMOVABLE_FSTYPES = new Set(['vfat', 'exfat', 'ntfs']);

function rowClass(active: boolean, selectable: boolean): string {
  const base = 'w-full flex items-start gap-2 px-3 py-2 text-left rounded-lg border-2 transition-colors';
  if (active) return `${base} bg-blue-50 dark:bg-blue-900/20 border-blue-500 dark:border-blue-400`;
  if (selectable) return `${base} border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 hover:border-gray-300 dark:hover:border-gray-600`;
  return `${base} border-gray-200 dark:border-gray-700 opacity-60 cursor-not-allowed`;
}

/** The second line of a row — free space when mounted, hint when not. */
function MountDetail({ mount }: { mount: MountCandidate }) {
  if (mount.mounted && mount.mountpoint) {
    return (
      <div className="text-[11px] text-gray-500 dark:text-gray-400">
        <span className="font-mono">{mount.mountpoint}</span>
        {mount.fsAvail && <span> · {mount.fsAvail} free{mount.fsUsedPct ? ` (${mount.fsUsedPct} used)` : ''}</span>}
        {mount.fstype && <span> · {mount.fstype}</span>}
      </div>
    );
  }
  return (
    <div className="text-[11px] text-amber-600 dark:text-amber-400">
      Not mounted — mount a disk here first{mount.fstype ? ` (${mount.fstype})` : ''}
    </div>
  );
}

/** One row in the mount picker — a single block device / mountpoint. */
function MountRow({
  mount,
  active,
  onSelect,
}: {
  mount: MountCandidate;
  active: boolean;
  onSelect: () => void;
}) {
  const selectable = mount.mounted && !!mount.mountpoint;
  const Icon = REMOVABLE_FSTYPES.has(mount.fstype ?? '') ? Usb : HardDrive;
  return (
    <button type="button" disabled={!selectable} onClick={onSelect} aria-pressed={active} className={rowClass(active, selectable)}>
      <Icon size={16} className={`mt-0.5 flex-shrink-0 ${active ? 'text-blue-600 dark:text-blue-300' : 'text-gray-400'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`text-xs font-semibold ${active ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-200'}`}>
            {mount.label || mount.device}
          </span>
          <span className="text-[11px] font-mono text-gray-400">{mount.device}</span>
          {mount.size && <span className="text-[11px] text-gray-400">· {mount.size}</span>}
          {active && <CheckCircle2 size={12} className="text-blue-600 dark:text-blue-300" />}
        </div>
        <MountDetail mount={mount} />
      </div>
    </button>
  );
}

/** The scan results: a list of pickable disks, or an empty-state hint. */
function MountList({
  mounts,
  value,
  error,
  onChange,
}: {
  mounts: MountCandidate[];
  value: string;
  error: string | null;
  onChange: (path: string) => void;
}) {
  if (mounts.length === 0) {
    return (
      <p className="text-[11px] text-gray-500 dark:text-gray-400 py-1">
        {error
          ? `Couldn't list disks: ${error}. Enter a path manually below.`
          : 'No mounted disks detected. Mount a USB/external drive, then Rescan — or enter a path manually below.'}
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      {mounts.map(m => (
        <MountRow
          key={m.device}
          mount={m}
          active={m.mounted && m.mountpoint === value}
          onSelect={() => m.mountpoint && onChange(m.mountpoint)}
        />
      ))}
    </div>
  );
}

/** Free-text fallback path, revealed behind the "advanced" toggle. */
function AdvancedPath({ value, onChange }: { value: string; onChange: (path: string) => void }) {
  return (
    <div>
      <input
        type="text"
        className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="/mnt/backup"
      />
      <p className="text-[11px] text-gray-400 mt-1">
        Advanced: an explicit path. The disk must already be mounted here — Backup Sync refuses an unmounted target so it never writes to the OS disk.
      </p>
    </div>
  );
}

/**
 * Local / USB backup-target picker (#1613). Replaces the old free-text
 * `/mnt/backup` box: enumerates the host's real mounted block devices
 * (device, label, size, free space, mountpoint) so the user picks a disk
 * instead of typing a path blind and hitting ENOENT.
 *
 * Unmounted filesystems are shown disabled with a "not mounted" hint.
 * A free-text path remains available behind an "advanced" toggle as a
 * fallback for paths the enumeration can't see (or when the picker fails
 * to load at all).
 */
function useMounts() {
  const [mounts, setMounts] = useState<MountCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/backup-sync/mounts');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Unable to enumerate mounts (${res.status})`);
      }
      const data = await res.json();
      setMounts(Array.isArray(data.mounts) ? data.mounts : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load mounts');
      setMounts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { mounts, loading, error, load };
}

export default function LocalTargetPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (path: string) => void;
}) {
  const { mounts, loading, error, load } = useMounts();
  const [showAdvanced, setShowAdvanced] = useState(false);

  // If the configured path isn't one of the enumerated mountpoints, the
  // user is on a custom path — keep the advanced free-text box open so
  // their value stays visible and editable.
  const selectedIsKnownMount = !!mounts?.some(m => m.mounted && m.mountpoint === value);
  const advancedOpen = showAdvanced || (!!value && mounts !== null && !selectedIsKnownMount);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Target disk</label>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 disabled:opacity-50"
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} Rescan
        </button>
      </div>

      {loading && mounts === null ? (
        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 py-2">
          <Loader2 size={12} className="animate-spin" /> Scanning disks…
        </div>
      ) : (
        <>
          <MountList mounts={mounts ?? []} value={value} error={error} onChange={onChange} />

          <button
            type="button"
            onClick={() => setShowAdvanced(v => !v)}
            className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
          >
            {advancedOpen ? 'Hide advanced path' : 'Advanced: enter a path manually'}
          </button>

          {advancedOpen && <AdvancedPath value={value} onChange={onChange} />}
        </>
      )}
    </div>
  );
}

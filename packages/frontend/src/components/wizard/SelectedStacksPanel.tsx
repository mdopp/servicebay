'use client';

import { Check, Clock, Loader2, Package, AlertCircle } from 'lucide-react';

/**
 * Selected-stacks status card (#732). On a multi-stack install the
 * rolling log is the only signal — the operator can't tell at a glance
 * "11/12 done, currently on auth, 1 still queued" without parsing
 * lines. This panel surfaces per-item state in one row each.
 *
 * The four states cover the install lifecycle the wizard tracks:
 *   - `already`   — checkbox was satisfied before runInstall ran;
 *                   shown so the operator sees what was preserved.
 *   - `done`      — the runner reports the item under
 *                   `progress.deployedNames`.
 *   - `installing` — name matches `progress.currentItem`.
 *   - `queued`    — checked but not yet processed.
 *   - `failed`    — top-level install error; the in-flight item is
 *                   marked failed (everything after it is queued).
 *
 * Data is derived from `installingNow`, `deployedNames` and the
 * checked `items[]` — no new state, no new endpoints.
 */

interface SelectedStacksPanelItem {
  /** Stack name (matches `JobInputItem.name` / `currentItem`). */
  name: string;
  /** Whether the operator selected this stack for install. */
  checked: boolean;
  /**
   * The wizard's pre-install flag for "this stack was already on the
   * node when the picker loaded" — surfaced as a separate state so the
   * operator sees what was preserved.
   */
  alreadyInstalled?: boolean;
}

type Status = 'already' | 'done' | 'installing' | 'queued' | 'failed' | 'skipped';

interface StatusRowProps {
  name: string;
  status: Status;
}

const ROW_STYLES: Record<Status, { icon: typeof Check; label: string; classes: string }> = {
  already: {
    icon: Check,
    label: 'Already installed',
    classes: 'text-gray-400',
  },
  done: {
    icon: Check,
    label: 'Done',
    classes: 'text-emerald-500',
  },
  installing: {
    icon: Loader2,
    label: 'Installing',
    classes: 'text-blue-500',
  },
  queued: {
    icon: Clock,
    label: 'Queued',
    classes: 'text-gray-400',
  },
  failed: {
    icon: AlertCircle,
    label: 'Failed',
    classes: 'text-red-500',
  },
  skipped: {
    icon: Check,
    label: 'Skipped',
    classes: 'text-gray-400',
  },
};

function StatusRow({ name, status }: StatusRowProps) {
  const { icon: Icon, label, classes } = ROW_STYLES[status];
  const animate = status === 'installing' ? 'animate-spin' : '';
  return (
    <li className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="flex items-center gap-2 min-w-0 truncate">
        <Icon className={`shrink-0 ${classes} ${animate}`} size={14} aria-hidden="true" />
        <span className="text-gray-700 dark:text-gray-200 truncate">{name}</span>
      </span>
      <span className={`text-[10px] font-bold uppercase tracking-wider ${classes}`}>{label}</span>
    </li>
  );
}

export interface SelectedStacksPanelProps {
  items: SelectedStacksPanelItem[];
  /** Name from `progress.currentItem`, or null. */
  installingNow: string | null;
  /** Names from `progress.deployedNames`. */
  deployedNames: readonly string[];
  /** Top-level install phase — `error`/`aborted`/`crashed` flips the
   *  in-flight item to `failed`. */
  phase: 'idle' | 'configure' | 'installing' | 'done' | 'error' | 'aborted' | 'crashed' | 'needs_credentials';
}

export default function SelectedStacksPanel({
  items,
  installingNow,
  deployedNames,
  phase,
}: SelectedStacksPanelProps) {
  const deployedSet = new Set(deployedNames);
  const failedPhase = phase === 'error' || phase === 'aborted' || phase === 'crashed';
  const reachedInstallingNow = (idx: number) => {
    if (!installingNow) return false;
    const installingIdx = items.findIndex(i => i.name === installingNow);
    return installingIdx >= 0 && idx > installingIdx;
  };

  const rows = items.map((item, idx) => {
    let status: Status;
    if (!item.checked) {
      status = 'skipped';
    } else if (item.alreadyInstalled && !deployedSet.has(item.name)) {
      status = 'already';
    } else if (deployedSet.has(item.name)) {
      status = 'done';
    } else if (installingNow === item.name) {
      // The currently-installing item flips to `failed` when the
      // pipeline errors out mid-step — everything past it stays queued.
      status = failedPhase ? 'failed' : 'installing';
    } else {
      // For items past the failure point we still render `queued` (no
      // useful action) but the panel's heading shows the failure.
      status = reachedInstallingNow(idx) ? 'queued' : 'queued';
    }
    return { name: item.name, status } as const;
  });

  const summary = (() => {
    const counts = rows.reduce<Record<Status, number>>(
      (acc, r) => {
        acc[r.status] += 1;
        return acc;
      },
      { already: 0, done: 0, installing: 0, queued: 0, failed: 0, skipped: 0 },
    );
    const ready = counts.done + counts.already;
    const total = rows.length - counts.skipped;
    if (failedPhase) return `${ready}/${total} done · install failed`;
    if (counts.installing > 0) {
      return `${ready}/${total} done · ${installingNow ?? 'installing'} in flight`;
    }
    if (counts.queued > 0) return `${ready}/${total} done · ${counts.queued} queued`;
    return `${ready}/${total} done`;
  })();

  if (rows.length === 0) return null;

  return (
    <section
      aria-label="Selected stacks status"
      className="rounded-2xl border border-white/5 bg-white/[0.02] p-4"
    >
      <header className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-gray-400">
          <Package size={12} />
          Selected stacks
        </div>
        <div className="text-[11px] font-mono text-gray-400">{summary}</div>
      </header>
      <ul role="list" className="divide-y divide-white/5">
        {rows.map(r => (
          <StatusRow key={r.name} name={r.name} status={r.status} />
        ))}
      </ul>
    </section>
  );
}

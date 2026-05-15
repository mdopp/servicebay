'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Info, X } from 'lucide-react';

interface UpgradeSummary {
  name: string;
  installedVersion: number;
  currentVersion: number;
  hasBreakingChange: boolean;
  sectionHeaders: string[];
}

interface PendingResponse {
  pending: UpgradeSummary[];
  hasBreakingChange: boolean;
}

const DISMISS_STORAGE_KEY = 'sb_template_upgrades_dismissed';

/**
 * Surface a single banner on the Services page when one or more
 * deployed templates have a newer schema-version available in the
 * registry. Counterpart to the gap noted in #510 — the per-template
 * `TemplateUpgradeBanner` only renders inside the InstallerModal, so
 * an operator who never opens the re-deploy flow would miss SSO /
 * security tightenings indefinitely.
 *
 * Local state only:
 *  - Dismissal lives in localStorage, keyed by the
 *    `<template>@<version>` pair. A bump beyond the dismissed
 *    version re-surfaces the banner so the operator isn't
 *    permanently silenced after one dismissal.
 *
 * The badge-on-each-card variant + the email path stay as follow-ups
 * tracked in #510 — the visible banner is enough to close the
 * "silent rollout" hole on its own.
 */
function loadDismissed(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(DISMISS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    // localStorage unavailable / corrupted; banner just re-appears.
    return new Set();
  }
}

export default function TemplateUpgradesPendingBanner() {
  const [data, setData] = useState<PendingResponse | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);

  useEffect(() => {
    fetch('/api/system/templates/upgrades-pending')
      .then(r => (r.ok ? r.json() : null))
      .then((res: PendingResponse | null) => res && setData(res))
      .catch(() => undefined);
  }, []);

  const visible = (data?.pending ?? []).filter(p => !dismissed.has(`${p.name}@${p.currentVersion}`));
  if (visible.length === 0) return null;

  const dismissAll = () => {
    const next = new Set(dismissed);
    for (const p of visible) next.add(`${p.name}@${p.currentVersion}`);
    setDismissed(next);
    try {
      localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // ignore — banner just re-appears next session.
    }
  };

  const breaking = visible.some(p => p.hasBreakingChange);
  const Icon = breaking ? AlertTriangle : Info;

  return (
    <div
      className={`mb-4 rounded-lg border ${
        breaking
          ? 'border-amber-300 dark:border-amber-700 bg-amber-50/70 dark:bg-amber-900/20'
          : 'border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-900/20'
      }`}
    >
      <div className="p-4 flex items-start gap-3">
        <div
          className={`shrink-0 p-1.5 rounded ${
            breaking
              ? 'bg-amber-100 dark:bg-amber-800/30 text-amber-700 dark:text-amber-300'
              : 'bg-blue-100 dark:bg-blue-800/30 text-blue-700 dark:text-blue-300'
          }`}
        >
          <Icon size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm text-gray-900 dark:text-white">
            {visible.length} template upgrade{visible.length === 1 ? '' : 's'} available
            {breaking ? ' — includes breaking changes' : ''}
          </div>
          <ul className="mt-2 space-y-1 text-xs text-gray-700 dark:text-gray-300">
            {visible.map(p => (
              <li key={p.name} className="flex items-center gap-2 flex-wrap">
                <span className="font-mono font-medium">{p.name}</span>
                <span className="text-gray-500 dark:text-gray-400">
                  v{p.installedVersion} → v{p.currentVersion}
                </span>
                {p.sectionHeaders.length > 0 && (
                  <span className="text-gray-500 dark:text-gray-400">
                    ({p.sectionHeaders.join(', ')})
                  </span>
                )}
                {p.hasBreakingChange && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-amber-200 dark:bg-amber-700/50 text-amber-900 dark:text-amber-100">
                    breaking
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
            Click <span className="font-medium">Re-deploy</span> on each service below to review the changelog and apply.
          </p>
        </div>
        <button
          onClick={dismissAll}
          className="shrink-0 p-1 rounded hover:bg-gray-200/50 dark:hover:bg-gray-700/50 text-gray-500 dark:text-gray-400"
          title="Dismiss until the next version bump"
          type="button"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

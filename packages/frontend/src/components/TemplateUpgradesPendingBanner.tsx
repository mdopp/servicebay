'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Info, Loader2, RefreshCw, X } from 'lucide-react';
import { fetchTemplates, fetchReadme } from '@/app/actions';
import type { Template } from '@servicebay/api-client';
import InstallerModal from './InstallerModal';
import { useToast } from '@/providers/ToastProvider';

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
 * Each row has an *Update & restart* button that opens the
 * InstallerModal pre-targeted at that template — same flow as
 * "find the service → click → click Re-deploy", just one click
 * away from the banner. The modal still owns the breaking-change
 * acknowledgement gate, so the safety surface is unchanged.
 *
 * Local state only:
 *  - Dismissal lives in localStorage, keyed by the
 *    `<template>@<version>` pair. A bump beyond the dismissed
 *    version re-surfaces the banner so the operator isn't
 *    permanently silenced after one dismissal.
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
  const { addToast } = useToast();
  const [data, setData] = useState<PendingResponse | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);
  const [loadingName, setLoadingName] = useState<string | null>(null);
  const [modalState, setModalState] = useState<{ template: Template; readme: string } | null>(null);

  useEffect(() => {
    fetch('/api/system/templates/upgrades-pending')
      .then(r => (r.ok ? r.json() : null))
      .then((res: PendingResponse | null) => res && setData(res))
      .catch(() => undefined);
  }, []);

  const visible = (data?.pending ?? []).filter(p => !dismissed.has(`${p.name}@${p.currentVersion}`));
  if (visible.length === 0 && !modalState) return null;

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

  const openInstaller = async (name: string) => {
    setLoadingName(name);
    try {
      const templates = await fetchTemplates();
      const template = templates.find(t => t.name === name && t.type === 'template');
      if (!template) {
        addToast('error', 'Template not found', `No template registered as "${name}". Try re-syncing registries from Settings.`);
        return;
      }
      const readme = await fetchReadme(template.name, 'template', template.source);
      setModalState({ template, readme: readme ?? '' });
    } catch (e) {
      addToast('error', 'Could not open re-deploy', e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingName(null);
    }
  };

  const closeInstaller = () => {
    setModalState(null);
    // Refresh the pending list — a successful re-deploy bumps the
    // installed schema version, so that row should drop off.
    fetch('/api/system/templates/upgrades-pending')
      .then(r => (r.ok ? r.json() : null))
      .then((res: PendingResponse | null) => res && setData(res))
      .catch(() => undefined);
  };

  const breaking = visible.some(p => p.hasBreakingChange);
  const Icon = breaking ? AlertTriangle : Info;

  return (
    <>
      {visible.length > 0 && (
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
              <ul className="mt-2 space-y-1.5 text-xs text-gray-700 dark:text-gray-300">
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
                    <button
                      onClick={() => openInstaller(p.name)}
                      disabled={loadingName === p.name}
                      className={`ml-auto inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-white disabled:opacity-50 ${
                        p.hasBreakingChange
                          ? 'bg-amber-600 hover:bg-amber-700'
                          : 'bg-blue-600 hover:bg-blue-700'
                      }`}
                      type="button"
                      title={p.hasBreakingChange ? 'Review changelog + acknowledge breaking changes, then re-deploy' : 'Re-deploy this service'}
                    >
                      {loadingName === p.name ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      {p.hasBreakingChange ? 'Review & update' : 'Update & restart'}
                    </button>
                  </li>
                ))}
              </ul>
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
      )}

      {modalState && (
        <InstallerModal
          template={modalState.template}
          readme={modalState.readme}
          isOpen={true}
          onClose={closeInstaller}
        />
      )}
    </>
  );
}

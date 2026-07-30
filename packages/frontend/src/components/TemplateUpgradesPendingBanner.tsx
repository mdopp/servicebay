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
              ? 'border-status-warn bg-status-warn/10'
              : 'border-status-info bg-status-info/10'
          }`}
        >
          <div className="p-4 flex items-start gap-3">
            <div
              className={`shrink-0 p-1.5 rounded ${
                breaking
                  ? 'bg-status-warn/20 text-status-warn'
                  : 'bg-status-info/20 text-status-info'
              }`}
            >
              <Icon size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm text-text">
                {visible.length} template upgrade{visible.length === 1 ? '' : 's'} available
                {breaking ? ' — includes breaking changes' : ''}
              </div>
              <ul className="mt-2 space-y-1.5 text-xs text-text-muted">
                {visible.map(p => (
                  <li key={p.name} className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-medium">{p.name}</span>
                    <span className="text-text-subtle">
                      v{p.installedVersion} → v{p.currentVersion}
                    </span>
                    {p.sectionHeaders.length > 0 && (
                      <span className="text-text-subtle">
                        ({p.sectionHeaders.join(', ')})
                      </span>
                    )}
                    {p.hasBreakingChange && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-status-warn/20 text-status-warn">
                        breaking
                      </span>
                    )}
                    <button
                      onClick={() => openInstaller(p.name)}
                      disabled={loadingName === p.name}
                      className={`ml-auto inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-on-accent disabled:opacity-50 ${
                        p.hasBreakingChange
                          ? 'bg-status-warn hover:bg-status-warn/80'
                          : 'bg-status-info hover:bg-status-info/80'
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
              className="shrink-0 p-1 rounded hover:bg-surface-2 text-text-subtle hover:text-text-muted"
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

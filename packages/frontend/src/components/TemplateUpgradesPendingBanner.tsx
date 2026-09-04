'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Info, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui';
import { fetchTemplates, fetchReadme } from '@/app/actions';
import {
  fetchPendingTemplateUpgrades,
  type Template,
  type TemplateUpgradeSummary,
  type PendingTemplateUpgradesResponse,
} from '@servicebay/api-client';
import InstallerModal from './InstallerModal';
import UpdatesNotice from './UpdatesNotice';
import { useToast } from '@/providers/ToastProvider';

const COLLAPSE_STORAGE_KEY = 'sb_template_upgrades_dismissed';

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
 *  - The banner **collapses**, it never dismisses (#2604). The old
 *    `×` removed the notice outright, so an operator who clicked it
 *    lost sight of a real pending upgrade until the *next* version
 *    bump. Now the summary line ("N template upgrades available")
 *    always stays on screen and only the per-template rows fold
 *    away; the collapsed choice is remembered in localStorage keyed
 *    by the `<template>@<version>` pair, so a bump beyond it
 *    re-expands the rows on its own.
 */
function loadCollapsed(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    // localStorage unavailable / corrupted; the rows just re-expand.
    return new Set();
  }
}

export default function TemplateUpgradesPendingBanner() {
  const { addToast } = useToast();
  const [data, setData] = useState<PendingTemplateUpgradesResponse | null>(null);
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(loadCollapsed);
  const [loadingName, setLoadingName] = useState<string | null>(null);
  const [modalState, setModalState] = useState<{ template: Template; readme: string } | null>(null);

  useEffect(() => {
    fetchPendingTemplateUpgrades()
      .then(res => setData(res))
      .catch(() => undefined);
  }, []);

  const pending = data?.pending ?? [];
  if (pending.length === 0 && !modalState) return null;

  const upgradeKey = (p: TemplateUpgradeSummary) => `${p.name}@${p.currentVersion}`;
  // Only a stack the operator has already folded away *in full* starts
  // collapsed — a newly-published upgrade re-expands the rows by itself.
  const startCollapsed = pending.length > 0 && pending.every(p => collapsedKeys.has(upgradeKey(p)));

  const rememberCollapsed = (open: boolean) => {
    const next = new Set(collapsedKeys);
    for (const p of pending) {
      if (open) next.delete(upgradeKey(p));
      else next.add(upgradeKey(p));
    }
    setCollapsedKeys(next);
    try {
      localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // ignore — the rows just re-expand next session.
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
    fetchPendingTemplateUpgrades()
      .then(res => setData(res))
      .catch(() => undefined);
  };

  const breaking = pending.some(p => p.hasBreakingChange);
  const Icon = breaking ? AlertTriangle : Info;

  return (
    <>
      {pending.length > 0 && (
        <UpdatesNotice
          data-testid="template-upgrades-notice"
          className={
            breaking
              ? 'border-status-warn bg-status-warn/10'
              : 'border-status-info bg-status-info/10'
          }
          defaultCollapsed={startCollapsed}
          onToggle={rememberCollapsed}
          icon={
            <span
              className={`block p-1.5 rounded ${
                breaking
                  ? 'bg-status-warn/20 text-status-warn'
                  : 'bg-status-info/20 text-status-info'
              }`}
            >
              <Icon size={16} />
            </span>
          }
          title={
            <>
              {pending.length} template upgrade{pending.length === 1 ? '' : 's'} available
              {breaking ? ' — includes breaking changes' : ''}
            </>
          }
        >
          <ul className="space-y-1.5 text-xs text-text-muted">
            {pending.map(p => (
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
                <Button
                  size="sm"
                  onClick={() => openInstaller(p.name)}
                  disabled={loadingName === p.name}
                  className={`h-auto ml-auto inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-on-accent disabled:opacity-50 ${
                    p.hasBreakingChange
                      ? 'bg-status-warn hover:bg-status-warn/80'
                      : 'bg-status-info hover:bg-status-info/80'
                  }`}
                  title={p.hasBreakingChange ? 'Review changelog + acknowledge breaking changes, then re-deploy' : 'Re-deploy this service'}
                >
                  {loadingName === p.name ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  {p.hasBreakingChange ? 'Review & update' : 'Update & restart'}
                </Button>
              </li>
            ))}
          </ul>
        </UpdatesNotice>
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

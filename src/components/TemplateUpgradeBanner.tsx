'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Info, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface UpgradeSection {
  version: number;
  breaking: boolean;
  body: string;
}

interface UpgradePreview {
  installedVersion: number | null;
  currentVersion: number;
  hasUpgrade: boolean;
  hasBreakingChange: boolean;
  sections: UpgradeSection[];
}

interface Props {
  templateName: string;
  source?: string;
  /**
   * Called whenever the operator's "I understand" acknowledgement
   * state changes. Parent (InstallerModal / OnboardingWizard) uses
   * this to gate the Install button — disabled until the operator
   * acknowledges any breaking-change banner.
   *
   * Convention: undefined → no preview loaded yet (treat as
   * "not ready, disable"); true → preview loaded, no acknowledgement
   * required OR operator has acknowledged; false → acknowledgement
   * required and not yet given.
   */
  onReadyToInstall?: (ready: boolean | undefined) => void;
}

/**
 * Re-deploy / install banner that surfaces a template's CHANGELOG
 * entries between the operator's installed schema version and the
 * version on disk. See #353 / #354 / #352 (template upgrade system).
 *
 * Renders nothing when:
 *   - the API errors out (still report ready=true so the existing
 *     install flow keeps working)
 *   - the template has no upgrade pending (fresh install OR same
 *     version)
 *   - the operator's currently-installed version is >= current
 *
 * When a non-breaking upgrade is pending: shows a small info banner
 * with the new sections, no acknowledgement required.
 *
 * When a breaking upgrade is pending: shows an amber acknowledgement
 * banner with a checkbox. Until checked, `onReadyToInstall(false)`
 * is reported.
 */
export default function TemplateUpgradeBanner({ templateName, source, onReadyToInstall }: Props) {
  const [preview, setPreview] = useState<UpgradePreview | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams();
    if (source) params.set('source', source);
    fetch(`/api/system/templates/${encodeURIComponent(templateName)}/upgrade-preview?${params}`)
      .then(r => (r.ok ? r.json() : null))
      .then((data: UpgradePreview | null) => {
        if (data) {
          setPreview(data);
        } else {
          setLoadFailed(true);
        }
      })
      .catch(() => setLoadFailed(true));
  }, [templateName, source]);

  // Report ready state to parent. The contract: undefined while
  // loading, true when preview is loaded and either no acknowledgement
  // needed OR the operator has clicked the checkbox, false otherwise.
  useEffect(() => {
    if (!onReadyToInstall) return;
    if (loadFailed) {
      onReadyToInstall(true);  // fail open — don't block install on a UI fetch glitch
      return;
    }
    if (!preview) {
      onReadyToInstall(undefined);
      return;
    }
    if (!preview.hasUpgrade || !preview.hasBreakingChange) {
      onReadyToInstall(true);
      return;
    }
    onReadyToInstall(acknowledged);
  }, [preview, loadFailed, acknowledged, onReadyToInstall]);

  if (loadFailed) return null;
  if (!preview) {
    return (
      <div className="mb-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Checking for template changes…
      </div>
    );
  }
  if (!preview.hasUpgrade || preview.sections.length === 0) return null;

  const breaking = preview.hasBreakingChange;

  return (
    <div
      className={`mb-4 rounded-lg border overflow-hidden ${
        breaking
          ? 'border-amber-300 dark:border-amber-700 bg-amber-50/70 dark:bg-amber-900/20'
          : 'border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-900/20'
      }`}
    >
      <div className="p-4 flex items-start gap-3">
        <div
          className={`shrink-0 p-1.5 rounded ${
            breaking
              ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-200'
              : 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-200'
          }`}
        >
          {breaking ? <AlertTriangle size={18} /> : <Info size={18} />}
        </div>
        <div className="flex-1 min-w-0">
          <h4 className={`text-sm font-semibold ${breaking ? 'text-amber-900 dark:text-amber-100' : 'text-blue-900 dark:text-blue-100'}`}>
            {breaking ? 'Breaking template change' : 'Template updated'} — v{preview.installedVersion ?? 1} → v{preview.currentVersion}
          </h4>
          <p className="text-xs text-gray-600 dark:text-gray-300 mt-0.5">
            Review the changes before deploying. {breaking
              ? 'Some of them require action on your side.'
              : 'No action required, just FYI.'}
          </p>
        </div>
      </div>

      <div className="px-4 pb-4 space-y-3">
        {preview.sections.map(section => (
          <div
            key={section.version}
            className={`rounded p-3 text-sm ${
              section.breaking
                ? 'bg-amber-100/60 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800'
                : 'bg-white/70 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-700'
            }`}
          >
            <div className="font-mono text-xs font-semibold text-gray-700 dark:text-gray-200 mb-1">
              v{section.version}{section.breaking ? ' (breaking)' : ''}
            </div>
            <div className="prose prose-sm dark:prose-invert max-w-none text-gray-700 dark:text-gray-300 prose-p:my-1 prose-ul:my-1">
              <ReactMarkdown>{section.body}</ReactMarkdown>
            </div>
          </div>
        ))}
      </div>

      {breaking && (
        <div className="px-4 pb-4">
          <label className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-100 cursor-pointer">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={e => setAcknowledged(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I understand these changes and want to deploy v{preview.currentVersion} now.
            </span>
          </label>
        </div>
      )}
    </div>
  );
}

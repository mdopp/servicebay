'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Info, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Input } from '@/components/ui';
import { fetchTemplateUpgradePreview, type TemplateUpgradePreview } from '@servicebay/api-client';

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
  const [preview, setPreview] = useState<TemplateUpgradePreview | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    fetchTemplateUpgradePreview(templateName, source)
      .then(data => setPreview(data))
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
      <div className="mb-4 p-3 rounded-lg bg-surface-2 text-xs text-text-muted flex items-center gap-2">
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
          ? 'border-status-warn bg-status-warn/5'
          : 'border-status-info bg-status-info/5'
      }`}
    >
      <div className="p-4 flex items-start gap-3">
        <div
          className={`shrink-0 p-1.5 rounded ${
            breaking
              ? 'bg-status-warn/10 text-status-warn'
              : 'bg-status-info/10 text-status-info'
          }`}
        >
          {breaking ? <AlertTriangle size={18} /> : <Info size={18} />}
        </div>
        <div className="flex-1 min-w-0">
          <h4 className={`text-sm font-semibold ${breaking ? 'text-status-warn' : 'text-status-info'}`}>
            {breaking ? 'Breaking template change' : 'Template updated'} — v{preview.installedVersion ?? 1} → v{preview.currentVersion}
          </h4>
          <p className="text-xs text-text-muted mt-0.5">
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
                ? 'bg-status-warn/10 border border-status-warn/30'
                : 'bg-surface border border-border'
            }`}
          >
            <div className="font-mono text-xs font-semibold text-text-muted mb-1">
              v{section.version}{section.breaking ? ' (breaking)' : ''}
            </div>
            <div className="prose prose-sm dark:prose-invert max-w-none text-text prose-p:my-1 prose-ul:my-1">
              <ReactMarkdown>{section.body}</ReactMarkdown>
            </div>
          </div>
        ))}
      </div>

      {breaking && (
        <div className="px-4 pb-4">
          <label className="flex items-start gap-2 text-sm text-status-warn cursor-pointer">
            <Input
              type="checkbox"
              checked={acknowledged}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAcknowledged(e.target.checked)}
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

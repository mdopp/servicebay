'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

/**
 * Factory Reset card (#623). The migration entry point for moving an
 * existing box to the post-Phase-1 architecture: wipes every service
 * AND clears `installedSecrets`, `installManifest`, and the legacy
 * `lldap` / `adguard` / `reverseProxy.npm` config fields so the next
 * wizard run starts from genuine zero.
 *
 * Factory reset is the only system-wide wipe. A reinstall never wipes —
 * it redeploys over the data on disk (#1520). This is the nuclear option
 * for "I want zero baseline".
 *
 * The confirmation token is FACTORY-RESET (not RESET) so an operator
 * can't accidentally type the wrong thing into the wrong dialog.
 */
const REQUIRED_CONFIRM = 'FACTORY-RESET';

export default function FactoryResetSection() {
  const { addToast } = useToast();
  const [confirmText, setConfirmText] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{
    deleted: number;
    cleared: string[];
    wipeSteps: string[];
  } | null>(null);

  const matches = confirmText === REQUIRED_CONFIRM;

  const handleFactoryReset = async () => {
    if (!matches || running) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch('/api/system/factory-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: REQUIRED_CONFIRM }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
      setResult({
        deleted: data.reset?.deleted?.length ?? 0,
        cleared: data.config?.cleared ?? [],
        wipeSteps: data.reset?.wipeStepsRun ?? [],
      });
      setConfirmText('');
      addToast('success', 'Factory reset complete', 'Open the install wizard to set up from a clean baseline.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      addToast('error', 'Factory reset failed', msg);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-red-200 dark:border-red-900/50 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-red-50 dark:bg-red-950/30 flex items-center gap-3">
        <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-lg text-red-600 dark:text-red-400">
          <AlertTriangle size={20} />
        </div>
        <div>
          <h3 className="font-bold text-gray-900 dark:text-white">Factory Reset</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">Wipe every service + clear saved credentials. Start from zero.</p>
        </div>
      </div>

      <div className="p-6 space-y-4">
        <div className="text-sm text-gray-700 dark:text-gray-300 space-y-2">
          <p>This deletes every installed service (photos, vault, identity, proxy, all of it) and clears the saved credentials in ServiceBay&apos;s config. The next wizard run goes through the full first-install flow with no pre-filled values.</p>
          <p className="font-medium text-red-700 dark:text-red-400">
            Not what you want for a normal re-install. To rebuild from a USB stick, pick a Factory-fresh option in the build form instead — &quot;wipe-configs&quot; keeps your app data on disk; this button does not.
          </p>
          <p className="text-xs text-gray-700 dark:text-gray-300">
            Each service&apos;s config (Home Assistant&apos;s automations + <span className="font-mono">.storage</span>, the Z-Wave network keys, AdGuard / Authelia / nginx settings) is <span className="font-semibold">not</span> pulled back automatically — restore it from a System Backup (select Service Config) afterwards, or services come up with default settings. Bulk data (the Immich photo library, recorder history, the Z-Wave mesh DB) is not in the snapshot; it is wiped by a Factory Reset.
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Family members will need to re-create their LLDAP accounts. NPM&apos;s Let&apos;s Encrypt certs are wiped (LE has a rate limit on re-issuance, so don&apos;t do this repeatedly).
          </p>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Type <span className="font-mono font-bold text-red-600 dark:text-red-400">{REQUIRED_CONFIRM}</span> to confirm:
          </label>
          <input
            type="text"
            value={confirmText}
            onChange={e => setConfirmText(e.target.value)}
            disabled={running}
            placeholder={REQUIRED_CONFIRM}
            autoComplete="off"
            spellCheck={false}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-50"
          />
        </div>

        <button
          onClick={handleFactoryReset}
          disabled={!matches || running}
          className="w-full sm:w-auto px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors shadow-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
        >
          {running ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
          {running ? 'Resetting…' : 'Factory reset this server'}
        </button>

        {result && (
          <div className="mt-4 p-4 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900/50 rounded-lg text-sm text-gray-700 dark:text-gray-300 space-y-1">
            <p className="font-medium text-green-700 dark:text-green-400">Reset complete.</p>
            <p>Removed {result.deleted} service{result.deleted === 1 ? '' : 's'}; wiped {result.wipeSteps.length} data group{result.wipeSteps.length === 1 ? '' : 's'}.</p>
            {result.cleared.length > 0 && (
              <p>Config fields cleared: <span className="font-mono text-xs">{result.cleared.join(', ')}</span>.</p>
            )}
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">Open the install wizard to set up the server from scratch.</p>
          </div>
        )}
      </div>
    </div>
  );
}

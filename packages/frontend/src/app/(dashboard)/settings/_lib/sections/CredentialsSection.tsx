'use client';

import { useEffect, useState } from 'react';
import { Download, Eye, EyeOff, Key, Loader2, Trash2 } from 'lucide-react';
import { buildBitwardenCsv, type Credential } from '@servicebay/api-client';
import { useToast } from '@/providers/ToastProvider';

interface Manifest {
  savedAt: string;
  credentials: Credential[];
}

/**
 * Settings section that surfaces the encrypted credentials manifest
 * the install wizard persisted (#19 / A1). Encrypted at rest in
 * `config.json`; decrypted by the same admin session that's loading
 * this page.
 *
 * Two affordances:
 *   - Per-row password reveal (default hidden) so the page doesn't
 *     leak secrets at a glance to anyone shoulder-surfing.
 *   - "Wipe from server" button that clears the manifest after the
 *     operator has stored credentials in their password manager —
 *     narrows the window during which plaintext-decryptable secrets
 *     sit in config.json.
 */
export default function CredentialsSection() {
  const { addToast } = useToast();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [busy, setBusy] = useState<'load' | 'wipe' | null>('load');
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});

  useEffect(() => {
    fetch('/api/system/credentials')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data) setManifest(data.manifest ?? null);
      })
      .finally(() => setBusy(null));
  }, []);

  const onWipe = async () => {
    if (!window.confirm(
      'Wipe credentials from the server?\n\n' +
      'Make sure you\'ve already saved them in your password manager — once wiped, you\'ll need to dig them out of running services manually (or reinstall) to recover.\n\n' +
      'The credentials themselves remain in the running services; this only clears ServiceBay\'s saved copy.',
    )) return;
    setBusy('wipe');
    try {
      const res = await fetch('/api/system/credentials', { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        addToast('error', 'Could not wipe credentials', data.error || `HTTP ${res.status}`);
        return;
      }
      setManifest(null);
      addToast('success', 'Credentials wiped from server', 'The saved manifest is gone. Services keep running with the same passwords — they just aren\'t in ServiceBay\'s config anymore.');
    } finally {
      setBusy(null);
    }
  };

  const downloadCsv = () => {
    if (!manifest || manifest.credentials.length === 0) return;
    const blob = new Blob([buildBitwardenCsv(manifest.credentials)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `servicebay-credentials-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    addToast('success', 'Credentials CSV downloaded', 'Re-import it into Bitwarden/Vaultwarden, then consider wiping the server copy.');
  };

  if (busy === 'load') {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading credentials…
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg text-blue-600 dark:text-blue-400">
          <Key size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-gray-900 dark:text-white">Saved credentials</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {manifest
              ? `Persisted at ${new Date(manifest.savedAt).toLocaleString()} — encrypted at rest, visible to logged-in admins.`
              : 'No credentials saved. Install a service via the wizard to populate this list.'}
          </p>
        </div>
        {manifest && manifest.credentials.length > 0 && (
          <div className="shrink-0 flex items-center gap-2">
            <button
              onClick={downloadCsv}
              className="inline-flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg"
              title="Download the saved credentials as a Bitwarden/Vaultwarden-importable CSV."
            >
              <Download size={14} />
              Download CSV
            </button>
            <button
              onClick={onWipe}
              disabled={busy === 'wipe'}
              className="inline-flex items-center gap-2 px-3 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
              title="Remove the saved credentials from the server. Useful once you've stored them safely in your password manager."
            >
              {busy === 'wipe' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              Wipe from server
            </button>
          </div>
        )}
      </div>

      <div className="p-6">
        {!manifest || manifest.credentials.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            Nothing saved yet. The install wizard writes here at the end of every successful run.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <tr>
                  <th className="text-left py-2 pr-3">Service</th>
                  <th className="text-left py-2 pr-3">URL</th>
                  <th className="text-left py-2 pr-3">Username</th>
                  <th className="text-left py-2 pr-3">Password</th>
                  <th className="text-left py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {manifest.credentials.map((c, i) => {
                  const isRevealed = !!revealed[i];
                  const rowClass = c.importance === 'critical'
                    ? 'border-b border-gray-100 dark:border-gray-800'
                    : 'border-b border-gray-100 dark:border-gray-800 opacity-80';
                  return (
                    <tr key={i} className={rowClass}>
                      <td className="py-2 pr-3 font-medium text-gray-900 dark:text-white">
                        {c.service}
                        {c.importance === 'system' && (
                          <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">system</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-gray-700 dark:text-gray-300 font-mono text-xs">{c.url}</td>
                      <td className="py-2 pr-3 text-gray-700 dark:text-gray-300 font-mono text-xs">{c.username}</td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          <code className="font-mono text-xs">{isRevealed ? c.password : '••••••••••'}</code>
                          <button
                            onClick={() => setRevealed(s => ({ ...s, [i]: !s[i] }))}
                            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                            title={isRevealed ? 'Hide password' : 'Reveal password'}
                          >
                            {isRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
                          </button>
                          {isRevealed && (
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(c.password).then(
                                  () => addToast('success', 'Copied to clipboard', `${c.service} password`),
                                  () => addToast('error', 'Copy failed', 'Browser refused clipboard access.'),
                                );
                              }}
                              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-[10px] uppercase tracking-wide"
                            >
                              copy
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="py-2 text-xs text-gray-500 dark:text-gray-400">{c.notes ?? ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

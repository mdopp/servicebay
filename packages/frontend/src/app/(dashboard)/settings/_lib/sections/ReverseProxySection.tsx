'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, KeyRound, Loader2, Shield, XCircle } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

/**
 * Settings → Networking → Reverse Proxy (NPM) (#1530 — derive, don't ask).
 *
 * No free-text admin email/password field: ServiceBay owns the NPM admin
 * credential through the verified re-key path. This section shows the
 * DB-derived admin identity as read-only with a live auth check, and a
 * one-click re-key when the stored credential is stale/diverged. That
 * kills the two-diverging-emails footgun (#1530).
 */
type CredStatus = 'ok' | 'rejected' | 'no-creds' | 'unknown';

interface CredState {
  configured: boolean;
  email: string;
  status: CredStatus;
}

export default function ReverseProxySection() {
  const { addToast } = useToast();
  const [state, setState] = useState<CredState | null>(null);
  const [busy, setBusy] = useState<'load' | 'rekey' | 'forget' | null>('load');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/system/nginx/credentials');
      if (res.ok) setState(await res.json());
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleRekey = async () => {
    setBusy('rekey');
    try {
      const res = await fetch('/api/system/nginx/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        addToast('error', 'Re-key failed', data.message || `HTTP ${res.status}`);
      } else {
        addToast('success', 'NPM admin re-keyed', data.message || 'A fresh admin password was written into NPM and saved — proxy routes preserved.');
        await load();
      }
    } finally {
      setBusy(null);
    }
  };

  const handleForget = async () => {
    setBusy('forget');
    try {
      const res = await fetch('/api/system/nginx/credentials', { method: 'DELETE' });
      if (res.ok) {
        addToast('success', 'NPM credentials removed');
        await load();
      }
    } finally {
      setBusy(null);
    }
  };

  const status = state?.status ?? 'unknown';
  const verified = status === 'ok';
  const diverged = status === 'rejected' || status === 'no-creds';

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 bg-emerald-100 dark:bg-emerald-900/30 rounded-lg text-emerald-600 dark:text-emerald-400">
          <Shield size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-gray-900 dark:text-white">Reverse Proxy (NPM)</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            ServiceBay owns the Nginx Proxy Manager admin credential automatically — it&apos;s read from NPM&apos;s own database, never typed in, so it can&apos;t silently drift out of sync.
          </p>
        </div>
        <div className="shrink-0">
          {busy === 'load' ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
              <Loader2 size={12} className="animate-spin" /> Checking
            </span>
          ) : verified ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/40 px-2 py-1 rounded">
              <CheckCircle2 size={12} /> Verified
            </span>
          ) : diverged ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/40 px-2 py-1 rounded">
              <AlertTriangle size={12} /> {status === 'no-creds' ? 'Not set' : 'Out of sync'}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
              <XCircle size={12} /> Unknown
            </span>
          )}
        </div>
      </div>

      <div className="p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Admin identity (from NPM database)</label>
          <div className="flex items-center gap-2 w-full p-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 text-gray-900 dark:text-white font-mono text-sm">
            <KeyRound size={14} className="text-gray-400 shrink-0" />
            <span className="truncate">
              {state?.email || (status === 'unknown' ? 'NPM not detected on this node' : 'No credential stored yet')}
            </span>
          </div>
        </div>

        {status === 'unknown' && (
          <div className="flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
            <HelpCircle size={14} className="shrink-0 mt-0.5" />
            <p>Nginx Proxy Manager isn&apos;t deployed or reachable on this node, so the admin credential can&apos;t be checked. Install NPM, then re-key.</p>
          </div>
        )}
        {status === 'ok' && (
          <p className="text-xs text-emerald-700 dark:text-emerald-300">
            ServiceBay can manage NPM — the stored credential authenticates against NPM&apos;s admin API.
          </p>
        )}
        {status === 'rejected' && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            NPM is rejecting the stored credential (it diverged — common after a reinstall over preserved data). Re-key to write a fresh admin password straight into NPM, keeping every proxy route.
          </p>
        )}
        {status === 'no-creds' && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            NPM is up but ServiceBay has no admin credential stored. Re-key to generate and verify one — no proxy routes are touched.
          </p>
        )}

        <div className="flex items-center gap-2 pt-2">
          <button
            onClick={handleRekey}
            disabled={busy !== null || status === 'unknown'}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors text-sm font-medium inline-flex items-center gap-2"
          >
            {busy === 'rekey' ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
            {verified ? 'Re-key admin' : 'Re-key NPM admin'}
          </button>
          {state?.configured && (
            <button
              onClick={handleForget}
              disabled={busy !== null}
              className="px-4 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors disabled:opacity-50"
            >
              {busy === 'forget' && <Loader2 className="w-4 h-4 animate-spin inline mr-1" />}
              Forget credential
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

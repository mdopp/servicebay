'use client';

import { useEffect, useState } from 'react';
import { Globe, Home, Loader2 } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

interface ModeInfo {
  mode: 'lan' | 'public';
  activeDomain: string;
  publicDomain: string | null;
  lanDomain: string | null;
}

/**
 * Settings section for the LAN ↔ public-domain mode classification
 * (#249, D19-PR3). Shows the current mode and lets the user switch
 * from LAN-only to public-domain — entering a domain triggers the
 * upgrade flow.
 *
 * The actual migration (NPM proxy host dual-server_name, AdGuard
 * double-rewrite, Authelia issuer swap, OIDC client re-registration,
 * Let's Encrypt cert request) is the scope of D19-PR8 (#265). This
 * section currently surfaces the form + a stubbed `Apply` that
 * persists `reverseProxy.publicDomain` into config — once PR-8 lands,
 * the backend migration kicks in and the page becomes a fully-
 * functional upgrade button.
 */
export default function PublicDomainSection() {
  const { addToast } = useToast();
  const [info, setInfo] = useState<ModeInfo | null>(null);
  const [busy, setBusy] = useState<'load' | 'save' | null>('load');
  const [pendingDomain, setPendingDomain] = useState('');

  useEffect(() => {
    fetch('/api/system/mode')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data) {
          setInfo(data as ModeInfo);
          setPendingDomain(data.publicDomain || '');
        }
      })
      .finally(() => setBusy(null));
  }, []);

  const onApply = async () => {
    const trimmed = pendingDomain.trim();
    setBusy('save');
    try {
      const res = await fetch('/api/system/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicDomain: trimmed || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        addToast('error', 'Could not save domain', data.error || `HTTP ${res.status}`);
        return;
      }
      addToast(
        'success',
        trimmed ? `Public domain set to ${trimmed}` : 'Switched to LAN-only mode',
        trimmed
          ? 'Migration to public domain will run in the background once D19-PR8 lands. For now, the domain is recorded.'
          : 'Services keep working on home.arpa.',
      );
      setInfo(prev => prev ? { ...prev, mode: trimmed ? 'public' : 'lan', publicDomain: trimmed || null, activeDomain: trimmed || prev.activeDomain } : prev);
    } finally {
      setBusy(null);
    }
  };

  if (busy === 'load' || !info) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading mode…
      </div>
    );
  }

  const isLan = info.mode === 'lan';
  const Icon = isLan ? Home : Globe;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className={`p-2 rounded-lg ${isLan ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'}`}>
          <Icon size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-gray-900 dark:text-white">
            {isLan ? 'Internal-only mode' : 'Public-domain mode'}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {isLan
              ? `Services live on <sub>.${info.activeDomain} via AdGuard DNS rewrites. No HTTPS, no external access.`
              : `Services reachable as <sub>.${info.publicDomain} with Let's Encrypt SSL + external access.`}
          </p>
        </div>
      </div>
      <div className="p-6 space-y-4">
        {isLan ? (
          <>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              Add a public domain to enable HTTPS, external access, and SSO over a real hostname.
              Existing internal URLs (<span className="font-mono">vault.{info.activeDomain}</span>, …) will keep working as a fallback for LAN devices.
            </p>
            <ul className="text-xs text-gray-500 dark:text-gray-400 space-y-1 list-disc list-inside">
              <li>You&apos;ll need a domain you control (e.g. via DDNS or a static A record).</li>
              <li>ServiceBay will request Let&apos;s Encrypt certificates and configure the FritzBox port forward (where supported).</li>
              <li>Mid-flight URL change: links to the old <span className="font-mono">.{info.activeDomain}</span> URLs auto-redirect to the new domain.</li>
            </ul>
          </>
        ) : (
          <p className="text-sm text-gray-700 dark:text-gray-300">
            Replace or remove the public domain below. Removing it switches the install back to LAN-only mode (services stay reachable via AdGuard DNS).
          </p>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={pendingDomain}
            onChange={(e) => setPendingDomain(e.target.value)}
            placeholder="example.com"
            className="flex-1 p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 rounded text-sm"
            autoComplete="off"
          />
          <button
            onClick={onApply}
            disabled={busy === 'save' || pendingDomain.trim() === (info.publicDomain ?? '')}
            className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded disabled:opacity-50"
          >
            {busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : null}
            {pendingDomain.trim() === '' && info.publicDomain ? 'Switch to LAN-only' : 'Apply'}
          </button>
        </div>
        <p className="text-[11px] text-gray-500 dark:text-gray-400 italic">
          Note: backend migration (NPM proxy hosts, AdGuard rewrites, Authelia issuer rotation, Let&apos;s Encrypt certs) ships in #265. For now, the domain is recorded but services aren&apos;t automatically reconfigured.
        </p>
      </div>
    </div>
  );
}

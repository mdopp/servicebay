'use client';

import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

interface GatewayState {
  configured: boolean;
  type: string | null;
  host: string;
  username: string;
  hasPassword: boolean;
  ssl: boolean;
}

/**
 * Settings → Gateway (#333). FritzBox host/username/password edit.
 *
 * The install-fedora-coreos.sh writes config.gateway at install time;
 * before this section, the only way to update it was a full re-install
 * or hand-editing config.json on the box. The "Edit Gateway" button
 * on the Internet-Gateway card also linked here-but-wrongly to
 * /registry?selected=gateway — that link is fixed in this same PR.
 */
export default function GatewaySection() {
  const { addToast } = useToast();
  const [state, setState] = useState<GatewayState | null>(null);
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | null>('load');
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  // Empty string means "no change". The placeholder reflects whether a
  // password is currently stored so the operator knows whether to type.
  const [password, setPassword] = useState('');
  const [ssl, setSsl] = useState(false);

  useEffect(() => {
    fetch('/api/settings/gateway')
      .then(r => (r.ok ? r.json() : null))
      .then((data: GatewayState | null) => {
        if (data) {
          setState(data);
          setHost(data.host);
          setUsername(data.username);
          setSsl(data.ssl);
        }
      })
      .finally(() => setBusy(null));
  }, []);

  const submit = async (test: boolean) => {
    if (!host.trim()) {
      addToast('error', 'Host is required');
      return;
    }
    setBusy(test ? 'test' : 'save');
    try {
      const res = await fetch('/api/settings/gateway', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: host.trim(),
          username: username.trim(),
          password,
          ssl,
          test,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        addToast(
          'error',
          test ? 'Connection test failed' : 'Could not save gateway',
          data.message || data.error || `HTTP ${res.status}`,
        );
        return;
      }
      addToast(
        'success',
        test ? 'Connected — credentials saved' : 'Gateway saved',
      );
      // Refresh to reset the password placeholder + reflect new hasPassword
      const refreshed = await fetch('/api/settings/gateway').then(r => r.ok ? r.json() : null);
      if (refreshed) setState(refreshed);
      setPassword('');
    } finally {
      setBusy(null);
    }
  };

  if (busy === 'load' || !state) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading gateway settings…
      </p>
    );
  }

  return (
    <>
        <div className="flex justify-end">
          {state.configured ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 size={14} /> Configured
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300">
              <AlertCircle size={14} /> Not configured
            </span>
          )}
        </div>

      <div className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Host</span>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="fritz.box or 192.168.178.1"
              className="p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 rounded text-sm font-mono"
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Username</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="fritz4554"
              className="p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 rounded text-sm font-mono"
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={state.hasPassword ? '•••••••• (leave blank to keep current)' : '(set a password)'}
              className="p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 rounded text-sm font-mono"
              autoComplete="new-password"
            />
          </label>
        </div>

        <label className="inline-flex items-center gap-2 cursor-pointer text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={ssl}
            onChange={(e) => setSsl(e.target.checked)}
            className="w-4 h-4"
          />
          Use HTTPS for TR-064 (uncommon — most FritzBoxes use unencrypted port 49000)
        </label>

        <div className="flex gap-2 pt-2">
          <button
            onClick={() => submit(true)}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded disabled:opacity-50"
          >
            {busy === 'test' && <Loader2 size={14} className="animate-spin" />}
            Test connection &amp; save
          </button>
          <button
            onClick={() => submit(false)}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-800 dark:text-gray-200 text-sm font-medium rounded disabled:opacity-50"
            title="Save without testing — useful when the FritzBox is currently unreachable"
          >
            {busy === 'save' && <Loader2 size={14} className="animate-spin" />}
            Save without test
          </button>
        </div>

        <p className="text-[11px] text-gray-500 dark:text-gray-400 italic">
          The TR-064 user needs the &quot;Smart Home&quot; permission in the FritzBox UI (System → FRITZ!Box-Benutzer). The password is stored encrypted at rest in <span className="font-mono">config.gateway.password</span>.
        </p>
      </div>
    </>
  );
}

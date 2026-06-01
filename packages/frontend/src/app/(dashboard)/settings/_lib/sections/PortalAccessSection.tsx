'use client';

import { useEffect, useState } from 'react';
import { Loader2, Save, Users } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

/**
 * Settings section for the family-portal access limits (#1456):
 *   - maxUsers      — cap on approved LLDAP users + pending requests.
 *                     New /portal access requests are rejected once hit.
 *   - portalLanOnly — serve /portal to LAN clients only (app gate).
 *
 * Sits next to the Access requests section since both govern who can
 * get onto the home server via the portal. Reads/writes config via
 * /api/system/portal-settings; both knobs survive restart.
 */
export default function PortalAccessSection() {
  const { addToast } = useToast();
  const [maxUsers, setMaxUsers] = useState(20);
  const [lanOnly, setLanOnly] = useState(false);
  const [busy, setBusy] = useState<'load' | 'save' | null>('load');

  useEffect(() => {
    let alive = true;
    fetch('/api/system/portal-settings')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (!alive || !data) return;
        if (typeof data.maxUsers === 'number') setMaxUsers(data.maxUsers);
        if (typeof data.portalLanOnly === 'boolean') setLanOnly(data.portalLanOnly);
      })
      .catch(() => {})
      .finally(() => { if (alive) setBusy(null); });
    return () => { alive = false; };
  }, []);

  const save = async (next: { maxUsers: number; portalLanOnly: boolean }) => {
    setBusy('save');
    try {
      const res = await fetch('/api/system/portal-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (res.ok) {
        addToast('success', 'Saved', 'Portal access settings updated.');
      } else {
        const data = await res.json().catch(() => ({}));
        addToast('error', 'Could not save', typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
      }
    } finally {
      setBusy(null);
    }
  };

  const onToggleLanOnly = (value: boolean) => {
    setLanOnly(value);
    void save({ maxUsers, portalLanOnly: value });
  };

  const onSaveMaxUsers = () => {
    if (!Number.isInteger(maxUsers) || maxUsers < 1) {
      addToast('error', 'Invalid limit', 'Enter a whole number of 1 or more.');
      return;
    }
    void save({ maxUsers, portalLanOnly: lanOnly });
  };

  if (busy === 'load') {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading portal settings…
      </div>
    );
  }

  return (
    <div id="portal-access" className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full scroll-mt-24">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg text-blue-600 dark:text-blue-400">
          <Users size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-gray-900 dark:text-white">Portal access</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Limits for the family portal at <span className="font-mono">/portal</span>.
          </p>
        </div>
      </div>

      <div className="p-6 space-y-6">
        <div>
          <label htmlFor="max-users" className="block text-sm font-medium text-gray-900 dark:text-white">
            Maximum users
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            New access requests are blocked once approved users plus pending requests reach this. Lower it for a small household (e.g. 5).
          </p>
          <div className="flex items-center gap-2">
            <input
              id="max-users"
              type="number"
              min={1}
              max={100000}
              value={maxUsers}
              onChange={e => setMaxUsers(Number(e.target.value))}
              disabled={busy === 'save'}
              className="w-28 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white disabled:opacity-50"
            />
            <button
              onClick={onSaveMaxUsers}
              disabled={busy === 'save'}
              className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
            >
              {busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </button>
          </div>
        </div>

        <div className="flex items-start justify-between gap-4 pt-2 border-t border-gray-100 dark:border-gray-700/50">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-white">LAN-only portal</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Serve <span className="font-mono">/portal</span> to home-network clients only. Visitors from the public internet see a short notice instead of the service grid.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={lanOnly}
            aria-label="LAN-only portal"
            onClick={() => onToggleLanOnly(!lanOnly)}
            disabled={busy === 'save'}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${lanOnly ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${lanOnly ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
      </div>
    </div>
  );
}

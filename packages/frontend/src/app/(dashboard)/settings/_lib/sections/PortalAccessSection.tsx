'use client';

import { useEffect, useState } from 'react';
import { Loader2, Save, Users } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import { Button, Card } from '@/components/ui';

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
      <Card className="w-full p-space-5 text-sm text-text-muted">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading portal settings…
      </Card>
    );
  }

  return (
    <Card id="portal-access" padding="none" className="w-full overflow-hidden scroll-mt-24">
      <div className="flex items-center gap-space-3 px-space-4 py-space-3 border-b border-border bg-surface-2">
        <div className="p-2 rounded-card bg-accent/10 text-accent">
          <Users size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-text">Portal access</h3>
          <p className="text-xs text-text-muted">
            Limits for the family portal at <span className="font-mono">/portal</span>.
          </p>
        </div>
      </div>

      <div className="p-space-5 space-y-6">
        <div>
          <label htmlFor="max-users" className="block text-sm font-medium text-text">
            Maximum users
          </label>
          <p className="text-xs text-text-muted mb-2">
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
              className="w-28 px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text focus:ring-2 focus:ring-accent outline-none disabled:opacity-50"
            />
            <Button
              onClick={onSaveMaxUsers}
              disabled={busy === 'save'}
              size="sm"
              className="h-10 px-space-3"
            >
              {busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </Button>
          </div>
        </div>

        <div className="flex items-start justify-between gap-4 pt-2 border-t border-border">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text">LAN-only portal</p>
            <p className="text-xs text-text-muted">
              Serve <span className="font-mono">/portal</span> to home-network clients only. Visitors from the public internet see a short notice instead of the service grid.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={lanOnly}
            aria-label="LAN-only portal"
            onClick={() => onToggleLanOnly(!lanOnly)}
            disabled={busy === 'save'}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-chip transition-colors disabled:opacity-50 ${lanOnly ? 'bg-accent' : 'bg-surface-muted border border-border'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-chip bg-white transition-transform ${lanOnly ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
      </div>
    </Card>
  );
}

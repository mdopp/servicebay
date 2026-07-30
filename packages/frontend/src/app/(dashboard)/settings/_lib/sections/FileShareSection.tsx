'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Loader2, RefreshCw } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

interface SambaUser {
  id: string;
  displayName?: string;
  email?: string;
  presentInSamba: boolean;
}

interface SyncResponse {
  ok: true;
  users: SambaUser[];
  added: string[];
  removed: string[];
}

/**
 * Per-LLDAP-user Samba password management (#494).
 *
 * The backend keeps the Samba `tdbsam` DB in step with LLDAP: every
 * GET to the sync endpoint adds missing users with a random initial
 * password and removes orphan entries. Operators then use this
 * section to flash the random password (for first-time mount) or
 * roll a new one whenever a family member needs a Samba reset.
 *
 * Samba can't speak OIDC, so this is the closest we get to the
 * single-source-of-truth model the rest of the stack enjoys —
 * docs/UX_PHILOSOPHY.md "single login flow" carves out SMB as a
 * deliberate exception.
 */
export default function FileShareSection() {
  const { addToast } = useToast();
  const [users, setUsers] = useState<SambaUser[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [flashed, setFlashed] = useState<{ id: string; password: string } | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/system/file-share/samba/users');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `HTTP ${res.status}`);
        setUsers(null);
        return;
      }
      const data = (await res.json()) as SyncResponse;
      setUsers(data.users);
      if (data.added.length > 0) {
        addToast('info', 'Samba sync', `${data.added.length} new user(s) added to the Samba directory.`);
      }
      if (data.removed.length > 0) {
        addToast('info', 'Samba sync', `${data.removed.length} stale user(s) removed.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async Samba-user load on mount
    void loadUsers();
  }, [loadUsers]);

  const setPassword = useCallback(async (id: string) => {
    setBusyUser(id);
    try {
      const res = await fetch(`/api/system/file-share/samba/users/${encodeURIComponent(id)}/set-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        addToast('error', 'Could not set password', data.error || `HTTP ${res.status}`);
        return;
      }
      setFlashed({ id, password: data.password });
      addToast('success', 'Samba password set', 'Copy the value below — it will not be shown again.');
    } catch (e) {
      addToast('error', 'Could not set password', e instanceof Error ? e.message : String(e));
    } finally {
      setBusyUser(null);
    }
  }, [addToast]);

  const copyPassword = useCallback((value: string) => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(value).then(() => {
      addToast('success', 'Copied', 'Samba password copied to clipboard.');
    });
  }, [addToast]);

  return (
    <>
        <div className="flex justify-end">
          <button
            onClick={loadUsers}
            disabled={loading}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-text-muted hover:bg-surface-2 rounded disabled:opacity-50"
            type="button"
            title="Re-run LLDAP → Samba sync"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Sync
          </button>
        </div>

      <div className="space-y-3">
        {error && (
          <div className="p-3 rounded-lg text-sm bg-surface text-status-fail border border-status-fail">
            {error}
          </div>
        )}

        {loading && !users && (
          <div className="flex items-center gap-2 text-sm text-text-subtle">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading LLDAP users…
          </div>
        )}

        {users && users.length === 0 && (
          <p className="text-sm text-text-subtle">No LLDAP users yet — create one in LLDAP first.</p>
        )}

        {users && users.length > 0 && (
          <ul className="divide-y divide-border">
            {users.map(u => (
              <li key={u.id} className="py-2 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text truncate">
                    {u.displayName || u.id}
                    <span className="ml-2 text-xs font-normal text-text-subtle">
                      ({u.id})
                    </span>
                  </div>
                  <div className="text-xs text-text-subtle">
                    {u.presentInSamba ? 'Samba account ready' : 'Samba account missing — click Set password to provision'}
                  </div>
                  {flashed?.id === u.id && (
                    <div className="mt-2 p-2 rounded bg-surface border border-status-warn text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-mono break-all">{flashed.password}</span>
                        <button
                          onClick={() => copyPassword(flashed.password)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-status-warn hover:bg-surface-2 rounded"
                          type="button"
                        >
                          <Copy size={12} /> Copy
                        </button>
                      </div>
                      <div className="mt-1 text-status-warn">
                        This is the only time the password is shown — copy it now.
                      </div>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setPassword(u.id)}
                  disabled={busyUser === u.id}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-status-ok hover:bg-accent-strong text-on-accent rounded disabled:opacity-50"
                  type="button"
                >
                  {busyUser === u.id ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
                  {u.presentInSamba ? 'Reset password' : 'Set password'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

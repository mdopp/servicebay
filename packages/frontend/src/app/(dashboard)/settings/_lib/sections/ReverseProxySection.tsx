'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, KeyRound, Loader2, Shield, XCircle } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import { Badge, Button, Card } from '@/components/ui';

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
    <Card padding="none" className="w-full overflow-hidden">
      <div className="flex items-center gap-space-3 px-space-4 py-space-3 border-b border-border bg-surface-2">
        <div className="p-2 rounded-card bg-status-ok/10 text-status-ok">
          <Shield size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-text">Reverse Proxy (NPM)</h3>
          <p className="text-xs text-text-muted">
            ServiceBay owns the Nginx Proxy Manager admin credential automatically — it&apos;s read from NPM&apos;s own database, never typed in, so it can&apos;t silently drift out of sync.
          </p>
        </div>
        <div className="shrink-0">
          {busy === 'load' ? (
            <Badge variant="neutral"><Loader2 size={12} className="animate-spin" /> Checking</Badge>
          ) : verified ? (
            <Badge variant="ok"><CheckCircle2 size={12} /> Verified</Badge>
          ) : diverged ? (
            <Badge variant="warn"><AlertTriangle size={12} /> {status === 'no-creds' ? 'Not set' : 'Out of sync'}</Badge>
          ) : (
            <Badge variant="neutral"><XCircle size={12} /> Unknown</Badge>
          )}
        </div>
      </div>

      <div className="p-space-5 space-y-4">
        <div>
          <label className="block text-sm font-medium text-text-muted mb-1">Admin identity (from NPM database)</label>
          <div className="flex items-center gap-2 w-full p-2 rounded-card border border-border bg-surface-2 text-text font-mono text-sm">
            <KeyRound size={14} className="text-text-subtle shrink-0" />
            <span className="truncate">
              {state?.email || (status === 'unknown' ? 'NPM not detected on this node' : 'No credential stored yet')}
            </span>
          </div>
        </div>

        {status === 'unknown' && (
          <div className="flex items-start gap-2 text-xs text-text-muted">
            <HelpCircle size={14} className="shrink-0 mt-0.5" />
            <p>Nginx Proxy Manager isn&apos;t deployed or reachable on this node, so the admin credential can&apos;t be checked. Install NPM, then re-key.</p>
          </div>
        )}
        {status === 'ok' && (
          <p className="text-xs text-status-ok">
            ServiceBay can manage NPM — the stored credential authenticates against NPM&apos;s admin API.
          </p>
        )}
        {status === 'rejected' && (
          <p className="text-xs text-status-warn">
            NPM is rejecting the stored credential (it diverged — common after a reinstall over preserved data). Re-key to write a fresh admin password straight into NPM, keeping every proxy route.
          </p>
        )}
        {status === 'no-creds' && (
          <p className="text-xs text-status-warn">
            NPM is up but ServiceBay has no admin credential stored. Re-key to generate and verify one — no proxy routes are touched.
          </p>
        )}

        <div className="flex items-center gap-2 pt-2">
          <Button
            onClick={handleRekey}
            disabled={busy !== null || status === 'unknown'}
          >
            {busy === 'rekey' ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
            {verified ? 'Re-key admin' : 'Re-key NPM admin'}
          </Button>
          {state?.configured && (
            <Button
              variant="danger"
              onClick={handleForget}
              disabled={busy !== null}
            >
              {busy === 'forget' && <Loader2 className="w-4 h-4 animate-spin" />}
              Forget credential
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { Bot, Check, ExternalLink, Globe, Loader2, Mail, Send, Trash2, UserCheck } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import { Badge, Button, Card, SectionHeading, StatusDot } from '@/components/ui';

interface AccessRequest {
  id: string;
  requestedAt: string;
  name: string;
  email: string;
  message?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  // `approved`/`denied` since #1824; `resolved` is the legacy value
  // (always meant approved) still present on older entries.
  status: 'pending' | 'approved' | 'denied' | 'resolved';
  resolvedAt?: string;
  /** Category for MCP-filed requests (e.g. "resident"); absent for portal submissions. */
  kind?: string;
  /** Agent/token identity that filed the request over SB-MCP; absent for portal submissions. */
  requestedBy?: string;
}

/**
 * Settings section for the family-portal access-request flow
 * (#242 follow-up). Shows pending + resolved requests with two
 * actions per row:
 *
 *   - Mark resolved: flips status. Use after creating the LLDAP
 *     user. Resolved entries stay around so admin can see history.
 *   - Delete: drops the request entirely. Use for spam.
 *
 * Plus a top-level link to LLDAP (when known) so the admin can jump
 * to the user-creation UI without hunting for the URL.
 *
 * #2086 — rebuilt on the #2073 design-system primitives (Card / Button /
 * Badge / StatusDot / SectionHeading) + semantic tokens, replacing the
 * ad-hoc rounded-xl/gray-800 card, raw blue/amber/emerald button chains
 * and the mixed labelled-button + bare-icon action cluster with one
 * consistent rhythm. Dark-mode-correct by construction.
 */
export default function AccessRequestsSection() {
  const { addToast } = useToast();
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [busy, setBusy] = useState<'load' | 'action' | null>('load');
  const [lldapUrl, setLldapUrl] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch('/api/system/access-requests');
      if (res.ok) {
        const data = await res.json();
        setRequests(Array.isArray(data.requests) ? data.requests : []);
      }
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    load();
    fetch('/api/auth/lldap-url')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.url) setLldapUrl(data.url); })
      .catch(() => {});
  }, []);

  const onResolve = async (id: string) => {
    setBusy('action');
    try {
      const res = await fetch(`/api/system/access-requests/${id}`, { method: 'PATCH' });
      if (res.ok) {
        await load();
      } else {
        addToast('error', 'Could not resolve', `HTTP ${res.status}`);
      }
    } finally {
      setBusy(null);
    }
  };

  const onApprove = async (id: string) => {
    setBusy('action');
    try {
      const res = await fetch(`/api/system/access-requests/${id}/approve`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        addToast('success', 'User created in LLDAP', 'Assign groups in the LLDAP tab that just opened.');
        if (typeof data.lldapUrl === 'string') {
          window.open(data.lldapUrl, '_blank', 'noopener,noreferrer');
        }
        await load();
      } else {
        const message = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
        addToast('error', 'Could not approve', message);
      }
    } finally {
      setBusy(null);
    }
  };

  const onResendWelcome = async (id: string) => {
    setBusy('action');
    try {
      const res = await fetch(`/api/system/access-requests/${id}/welcome`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        addToast('success', 'Welcome email sent', 'The family member should see it shortly.');
      } else {
        const message = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
        addToast('error', 'Could not send welcome email', message);
      }
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('Delete this access request? Use for spam — there\'s no undo.')) return;
    setBusy('action');
    try {
      const res = await fetch(`/api/system/access-requests/${id}`, { method: 'DELETE' });
      if (res.ok) {
        await load();
      } else {
        addToast('error', 'Could not delete', `HTTP ${res.status}`);
      }
    } finally {
      setBusy(null);
    }
  };

  const pending = requests.filter(r => r.status === 'pending');
  const resolved = requests.filter(r => r.status !== 'pending').sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));

  if (busy === 'load') {
    return (
      <p className="text-sm text-text-muted">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading access requests…
      </p>
    );
  }

  return (
    <>
        {(pending.length > 0 || lldapUrl) && (
          <div className="flex items-center justify-between gap-space-3">
            {pending.length > 0 ? (
              <Badge variant="warn" aria-label={`${pending.length} pending`}>{pending.length} pending</Badge>
            ) : <span />}
            {lldapUrl && (
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                onClick={() => window.open(lldapUrl, '_blank', 'noopener,noreferrer')}
              >
                Open LLDAP <ExternalLink size={14} />
              </Button>
            )}
          </div>
        )}
        {requests.length === 0 ? (
          <p className="text-sm text-text-muted italic">
            No access requests yet. They appear here when a family member fills the form on the portal.
          </p>
        ) : (
          <>
            {pending.length > 0 && (
              <div className="space-y-space-3">
                <SectionHeading as="h4">Pending</SectionHeading>
                <div className="space-y-2">
                  {pending.map(r => (
                    <RequestRow
                      key={r.id}
                      r={r}
                      onApprove={() => onApprove(r.id)}
                      onResolve={() => onResolve(r.id)}
                      onResendWelcome={() => onResendWelcome(r.id)}
                      onDelete={() => onDelete(r.id)}
                      busy={busy === 'action'}
                    />
                  ))}
                </div>
              </div>
            )}
            {resolved.length > 0 && (
              <div className="space-y-space-3">
                <SectionHeading as="h4" tone="muted">Resolved</SectionHeading>
                <div className="space-y-2">
                  {resolved.map(r => (
                    <RequestRow
                      key={r.id}
                      r={r}
                      onApprove={() => onApprove(r.id)}
                      onResolve={() => onResolve(r.id)}
                      onResendWelcome={() => onResendWelcome(r.id)}
                      onDelete={() => onDelete(r.id)}
                      busy={busy === 'action'}
                      muted
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
    </>
  );
}

/** Map an access-request status to a StatusDot state + accessible label. */
function statusDotState(status: AccessRequest['status']): { state: 'ok' | 'warn' | 'fail'; label: string } {
  switch (status) {
    case 'pending':
      return { state: 'warn', label: 'Pending' };
    case 'denied':
      return { state: 'fail', label: 'Denied' };
    default:
      return { state: 'ok', label: 'Approved' };
  }
}

/**
 * Source-of-origin badge: "Via agent" (with the filer id in the tooltip)
 * for MCP-filed requests (#1818/#1821), "Via portal" for anonymous portal
 * submissions. Lets the admin tell programmatic requests apart at a glance.
 */
function ProvenanceBadge({ requestedBy }: { requestedBy?: string }) {
  if (requestedBy) {
    return (
      <Badge variant="info" title={`Filed via agent: ${requestedBy}`}>
        <Bot size={11} /> Via agent
      </Badge>
    );
  }
  return (
    <Badge variant="neutral" title="Submitted from the family portal">
      <Globe size={11} /> Via portal
    </Badge>
  );
}

function RequestRow({
  r,
  onApprove,
  onResolve,
  onResendWelcome,
  onDelete,
  busy,
  muted,
}: {
  r: AccessRequest;
  onApprove: () => void;
  onResolve: () => void;
  onResendWelcome: () => void;
  onDelete: () => void;
  busy: boolean;
  muted?: boolean;
}) {
  const canAutoApprove = Boolean(r.username);
  const canResendWelcome = Boolean(r.username);
  const dot = statusDotState(r.status);
  return (
    <Card padding="sm" className={muted ? 'bg-surface-2 opacity-70' : 'bg-surface-2'}>
      <div className="flex items-start gap-space-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-space-2 text-sm flex-wrap">
            <StatusDot state={dot.state} label={dot.label} />
            <span className="font-medium text-text">{r.name}</span>
            {r.username && (
              <Badge variant="neutral" className="font-mono">{r.username}</Badge>
            )}
            {r.kind && (
              <Badge variant="accent" className="capitalize">{r.kind}</Badge>
            )}
            <ProvenanceBadge requestedBy={r.requestedBy} />
            {r.email && (
              <a href={`mailto:${r.email}`} className="inline-flex items-center gap-1 text-accent hover:underline text-xs">
                <Mail size={12} /> {r.email}
              </a>
            )}
          </div>
          <div className="text-[11px] text-text-subtle">
            Submitted {new Date(r.requestedAt).toLocaleString()}
            {r.requestedBy && ` · by ${r.requestedBy}`}
            {r.resolvedAt && ` · resolved ${new Date(r.resolvedAt).toLocaleString()}`}
          </div>
          {r.message && (
            <p className="mt-1 text-xs text-text-muted italic">&ldquo;{r.message}&rdquo;</p>
          )}
        </div>
        <div className="flex items-center gap-space-1 shrink-0">
          {r.status === 'pending' && canAutoApprove && (
            <Button
              variant="primary"
              size="sm"
              onClick={onApprove}
              disabled={busy}
              title="Provision the user in LLDAP and open the group assignment page"
            >
              <UserCheck size={14} /> Approve
            </Button>
          )}
          {r.status === 'pending' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onResolve}
              disabled={busy}
              aria-label="Mark resolved"
              title={canAutoApprove ? 'Mark resolved without creating the LLDAP user' : 'Mark resolved (after creating the LLDAP user)'}
            >
              <Check size={16} />
            </Button>
          )}
          {r.status !== 'pending' && r.status !== 'denied' && canResendWelcome && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onResendWelcome}
              disabled={busy}
              aria-label="Resend welcome email"
              title="Resend the welcome email to this family member"
            >
              <Send size={16} />
            </Button>
          )}
          <Button
            variant="danger"
            size="sm"
            onClick={onDelete}
            disabled={busy}
            aria-label="Delete request"
            title="Delete this request"
          >
            <Trash2 size={16} />
          </Button>
        </div>
      </div>
    </Card>
  );
}

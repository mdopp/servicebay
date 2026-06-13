'use client';

import { useEffect, useState } from 'react';
import { Bot, Check, ExternalLink, Globe, Loader2, Mail, Send, Trash2, UserCheck, UserPlus } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

interface AccessRequest {
  id: string;
  requestedAt: string;
  name: string;
  email: string;
  message?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  status: 'pending' | 'resolved';
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
  const resolved = requests.filter(r => r.status === 'resolved').sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));

  if (busy === 'load') {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading access requests…
      </div>
    );
  }

  return (
    <div id="access-requests" className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full scroll-mt-24">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg text-blue-600 dark:text-blue-400">
          <UserPlus size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-gray-900 dark:text-white">
            Access requests
            {pending.length > 0 && (
              <span className="ml-2 inline-flex items-center justify-center px-2 py-0.5 text-xs font-bold text-white bg-amber-500 rounded-full">
                {pending.length}
              </span>
            )}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Family members on the LAN can submit a request from the portal at <span className="font-mono">/portal</span>. Click <span className="font-medium">Approve</span> to provision the user in LLDAP and open their group-assignment page.
          </p>
        </div>
        {lldapUrl && (
          <a
            href={lldapUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 inline-flex items-center gap-2 px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg"
          >
            Open LLDAP <ExternalLink size={14} />
          </a>
        )}
      </div>

      <div className="p-6 space-y-6">
        {requests.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            No access requests yet. They appear here when a family member fills the form on the portal.
          </p>
        ) : (
          <>
            {pending.length > 0 && (
              <div>
                <h4 className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Pending</h4>
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
              <div>
                <h4 className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Resolved</h4>
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
      </div>
    </div>
  );
}

/**
 * Source-of-origin badge: "Via agent" (with the filer id in the tooltip)
 * for MCP-filed requests (#1818/#1821), "Via portal" for anonymous portal
 * submissions. Lets the admin tell programmatic requests apart at a glance.
 */
function ProvenanceBadge({ requestedBy }: { requestedBy?: string }) {
  if (requestedBy) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium rounded bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300"
        title={`Filed via agent: ${requestedBy}`}
      >
        <Bot size={11} /> Via agent
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
      title="Submitted from the family portal"
    >
      <Globe size={11} /> Via portal
    </span>
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
  return (
    <div className={`p-3 rounded-lg border border-gray-200 dark:border-gray-700 ${muted ? 'opacity-60' : 'bg-white dark:bg-gray-900'}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-sm flex-wrap">
            <span className="font-medium text-gray-900 dark:text-white">{r.name}</span>
            {r.username && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-mono bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded">
                {r.username}
              </span>
            )}
            {r.kind && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-medium bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded capitalize">
                {r.kind}
              </span>
            )}
            <ProvenanceBadge requestedBy={r.requestedBy} />
            {r.email && (
              <a href={`mailto:${r.email}`} className="inline-flex items-center gap-1 text-blue-700 dark:text-blue-300 hover:underline text-xs">
                <Mail size={12} /> {r.email}
              </a>
            )}
          </div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400">
            Submitted {new Date(r.requestedAt).toLocaleString()}
            {r.requestedBy && ` · by ${r.requestedBy}`}
            {r.resolvedAt && ` · resolved ${new Date(r.resolvedAt).toLocaleString()}`}
          </div>
          {r.message && (
            <p className="mt-1 text-xs text-gray-600 dark:text-gray-400 italic">&ldquo;{r.message}&rdquo;</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {r.status === 'pending' && canAutoApprove && (
            <button
              onClick={onApprove}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded disabled:opacity-50"
              title="Provision the user in LLDAP and open the group assignment page"
            >
              <UserCheck size={14} /> Approve
            </button>
          )}
          {r.status === 'pending' && (
            <button
              onClick={onResolve}
              disabled={busy}
              className="p-1.5 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded disabled:opacity-50"
              title={canAutoApprove ? 'Mark resolved without creating the LLDAP user' : 'Mark resolved (after creating the LLDAP user)'}
            >
              <Check size={16} />
            </button>
          )}
          {r.status === 'resolved' && canResendWelcome && (
            <button
              onClick={onResendWelcome}
              disabled={busy}
              className="p-1.5 text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded disabled:opacity-50"
              title="Resend the welcome email to this family member"
            >
              <Send size={16} />
            </button>
          )}
          <button
            onClick={onDelete}
            disabled={busy}
            className="p-1.5 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded disabled:opacity-50"
            title="Delete this request"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

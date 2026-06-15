'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, ShieldAlert, X } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

/** Mirrors the backend `ApprovalRequest` shape (see lib/approvals, #1843).
 *  Only the reviewer-facing fields are needed here. */
interface ApprovalRequest {
  id: string;
  service: string;
  title: string;
  description: string | null;
  payload: Record<string, unknown>;
  node: string;
  created_at: string;
  status: 'pending' | 'approved' | 'rejected';
}

function useApprovals() {
  const { addToast } = useToast();
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [busy, setBusy] = useState<'load' | 'action' | null>('load');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/approvals');
      if (res.ok) {
        const data = await res.json();
        setRequests(Array.isArray(data.approvals) ? data.approvals : []);
      } else {
        addToast('error', 'Could not load approval requests', `HTTP ${res.status}`);
      }
    } catch (e) {
      addToast('error', 'Could not load approval requests', e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(null);
    }
  }, [addToast]);

  const resolveRequest = useCallback(async (id: string, decision: 'approve' | 'reject', title: string) => {
    setBusy('action');
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(id)}/${decision}`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const verb = decision === 'approve' ? 'Approved' : 'Rejected';
        if (data.restarted === false) {
          addToast('warning', `${verb}, but a restart failed`, data.restartError ?? 'Restart the affected service manually.');
        } else {
          addToast('success', `${verb}: ${title}`, undefined);
        }
        await load();
      } else {
        addToast('error', `Could not ${decision}`, data.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      addToast('error', `Could not ${decision}`, e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(null);
    }
  }, [addToast, load]);

  return { requests, busy, load, resolveRequest };
}

interface ApprovalCardProps {
  request: ApprovalRequest;
  busy: 'load' | 'action' | null;
  onApprove: (id: string, title: string) => void;
  onReject: (id: string, title: string) => void;
}

function ApprovalCardHeader({ request }: { request: ApprovalRequest }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-gray-900 dark:text-white">{request.title}</span>
        <span className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-mono bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded">
          {request.service}
        </span>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          · {new Date(request.created_at).toLocaleString()}
        </span>
      </div>
      {request.description && (
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{request.description}</p>
      )}
    </div>
  );
}

function ApprovalCard({ request, busy, onApprove, onReject }: ApprovalCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const hasPayload = Object.keys(request.payload).length > 0;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 transition-colors">
      <div className="p-3 flex items-start gap-3">
        <button
          onClick={() => setIsOpen(!isOpen)}
          disabled={!hasPayload}
          className="p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors disabled:opacity-30 disabled:cursor-default"
          title={hasPayload ? (isOpen ? 'Collapse details' : 'Show details') : 'No additional details'}
        >
          {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <ApprovalCardHeader request={request} />
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => onApprove(request.id, request.title)}
            disabled={busy === 'action'}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg disabled:opacity-50 transition-colors"
            title="Approve this request"
          >
            <Check size={14} /> Approve
          </button>
          <button
            onClick={() => onReject(request.id, request.title)}
            disabled={busy === 'action'}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg disabled:opacity-50 transition-colors"
            title="Reject this request"
          >
            <X size={14} /> Reject
          </button>
        </div>
      </div>

      {hasPayload && isOpen && (
        <div className="border-t border-gray-200 dark:border-gray-700 p-4 bg-gray-50 dark:bg-gray-950/80 max-h-[420px] overflow-y-auto">
          <pre className="text-[11px] font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words">
            {JSON.stringify(request.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * Generic admin approval gate (#1844, epic #1842).
 *
 * Lists pending approval requests submitted by any service over the
 * generic `/api/approvals` API (#1843). Each request carries a title,
 * description, and a free-form payload the admin can inspect; approving
 * or rejecting runs the side effect the requesting service declared,
 * with no service-domain coupling in this component.
 */
export default function ApprovalsSection() {
  const { requests, busy, load, resolveRequest } = useApprovals();

  useEffect(() => {
    load();
  }, [load]);

  const pending = requests.filter(r => r.status === 'pending');

  if (busy === 'load') return <ApprovalsLoadingState />;

  return (
    <div id="approvals" className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full scroll-mt-24">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 bg-amber-100 dark:bg-amber-900/30 rounded-lg text-amber-600 dark:text-amber-400">
          <ShieldAlert size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-gray-900 dark:text-white">
            Approvals
            {pending.length > 0 && (
              <span className="ml-2 inline-flex items-center justify-center px-2 py-0.5 text-xs font-bold text-white bg-amber-500 rounded-full">
                {pending.length}
              </span>
            )}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Requests that need your review before a service runs them. Inspect the details, then <span className="font-medium">Approve</span> to run the requested action or <span className="font-medium">Reject</span> to discard it.
          </p>
        </div>
      </div>

      <div className="p-6">
        {pending.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            No pending approvals. Requests will appear here when a service needs your sign-off.
          </p>
        ) : (
          <div className="space-y-2">
            {pending.map(request => (
              <ApprovalCard
                key={request.id}
                request={request}
                busy={busy}
                onApprove={(id, title) => void resolveRequest(id, 'approve', title)}
                onReject={(id, title) => void resolveRequest(id, 'reject', title)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ApprovalsLoadingState() {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6 text-sm text-gray-500 dark:text-gray-400">
      <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
      Loading approvals…
    </div>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, ShieldAlert, X } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import { Badge, Button, Card } from '@/components/ui';

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
        <span className="text-sm font-medium text-text">{request.title}</span>
        <Badge variant="neutral" className="font-mono">{request.service}</Badge>
        <span className="text-[11px] text-text-subtle">
          · {new Date(request.created_at).toLocaleString()}
        </span>
      </div>
      {request.description && (
        <p className="mt-1 text-xs text-text-muted">{request.description}</p>
      )}
    </div>
  );
}

function ApprovalCard({ request, busy, onApprove, onReject }: ApprovalCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const hasPayload = Object.keys(request.payload).length > 0;

  return (
    <Card padding="none" className="transition-colors">
      <div className="p-3 flex items-start gap-3">
        <button
          onClick={() => setIsOpen(!isOpen)}
          disabled={!hasPayload}
          className="p-1 text-text-subtle hover:bg-surface-2 rounded-card transition-colors disabled:opacity-30 disabled:cursor-default"
          title={hasPayload ? (isOpen ? 'Collapse details' : 'Show details') : 'No additional details'}
        >
          {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <ApprovalCardHeader request={request} />
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="primary"
            size="sm"
            onClick={() => onApprove(request.id, request.title)}
            disabled={busy === 'action'}
            title="Approve this request"
          >
            <Check size={14} /> Approve
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => onReject(request.id, request.title)}
            disabled={busy === 'action'}
            title="Reject this request"
          >
            <X size={14} /> Reject
          </Button>
        </div>
      </div>

      {hasPayload && isOpen && (
        <div className="border-t border-border p-4 bg-surface-muted max-h-[420px] overflow-y-auto">
          <pre className="text-[11px] font-mono text-text-muted whitespace-pre-wrap break-words">
            {JSON.stringify(request.payload, null, 2)}
          </pre>
        </div>
      )}
    </Card>
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
    <Card id="approvals" padding="none" className="w-full overflow-hidden scroll-mt-24">
      <div className="flex items-center gap-space-3 px-space-4 py-space-3 border-b border-border bg-surface-2">
        <div className="p-2 rounded-card bg-status-warn/10 text-status-warn">
          <ShieldAlert size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="flex items-center gap-space-2 font-semibold text-text">
            Approvals
            {pending.length > 0 && (
              <Badge variant="warn" aria-label={`${pending.length} pending`}>{pending.length}</Badge>
            )}
          </h3>
          <p className="text-xs text-text-muted">
            Requests that need your review before a service runs them. Inspect the details, then <span className="font-medium">Approve</span> to run the requested action or <span className="font-medium">Reject</span> to discard it.
          </p>
        </div>
      </div>

      <div className="p-space-5">
        {pending.length === 0 ? (
          <p className="text-sm text-text-muted italic">
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
    </Card>
  );
}

function ApprovalsLoadingState() {
  return (
    <Card className="w-full p-space-5 text-sm text-text-muted">
      <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
      Loading approvals…
    </Card>
  );
}

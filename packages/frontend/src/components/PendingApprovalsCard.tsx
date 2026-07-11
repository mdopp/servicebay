'use client';

import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button, Card } from '@/components/ui';

/**
 * Pending MCP destructive-tool approvals, surfaced on Home (#2203-followup).
 *
 * A token-authenticated MCP agent can only *propose* a destructive tool call;
 * it parks as a pending approval that a human (session cookie) must confirm.
 * These live in-memory with a short (~5 min) TTL, so if the operator isn't
 * looking they expire unseen — which is exactly what happened when a route
 * deletion was proposed and the Settings-only approval list stayed empty.
 *
 * This card puts the same list on Home so a pending approval is visible where
 * the operator already looks ("is my box OK?"). It renders nothing when there's
 * nothing to approve, polls on a short interval to stay fresh against the TTL,
 * and drives the same `/api/system/mcp/approve` endpoints as the Settings list.
 */

export interface PendingApproval {
  pendingId: string;
  toolName: string;
  args: Record<string, unknown>;
  caller?: string;
  expiresAt: number;
}

/** Poll cadence — well under the ~5 min approval TTL so the list stays fresh. */
const POLL_MS = 15_000;

export function usePendingApprovals() {
  const [pending, setPending] = useState<PendingApproval[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/system/mcp/approve')
      .then(r => (r.ok ? r.json() : { pending: [] }))
      .then((data: { pending?: PendingApproval[] }) => setPending(data.pending ?? []))
      .catch(() => setPending([]));
  }, []);

  const approve = useCallback(async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/system/mcp/approve/${id}`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return { pending, busyId, error, approve };
}

function ApprovalRow({ entry, busy, onApprove }: { entry: PendingApproval; busy: boolean; onApprove: (id: string) => void }) {
  // Absolute expiry time (not a Date.now()-derived countdown) so render stays
  // pure; the poll drops expired entries off the list anyway.
  const expiresAtLabel = new Date(entry.expiresAt).toLocaleTimeString();
  return (
    <li className="text-xs rounded-card border border-status-warn/40 bg-status-warn/10 p-2">
      <div className="flex items-center gap-2">
        <span className="font-mono font-semibold text-status-warn">{entry.toolName}</span>
        {entry.caller && <span className="text-text-subtle">from {entry.caller}</span>}
        <span className="text-text-subtle ml-auto">expires {expiresAtLabel}</span>
      </div>
      <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-text-muted font-mono">{JSON.stringify(entry.args, null, 2)}</pre>
      <div className="mt-1.5 flex justify-end">
        <Button type="button" size="sm" disabled={busy} onClick={() => onApprove(entry.pendingId)}>
          <ShieldCheck size={12} />
          {busy ? 'Approving…' : 'Approve & run'}
        </Button>
      </div>
    </li>
  );
}

/**
 * Renders nothing when there are no pending approvals, so it's safe to drop at
 * the top of Home unconditionally.
 */
export default function PendingApprovalsCard() {
  const { pending, busyId, error, approve } = usePendingApprovals();
  if (!pending || pending.length === 0) return null;

  return (
    <Card padding="lg" className="border-status-warn/50 bg-status-warn/5">
      <div className="flex items-center gap-1.5 mb-2">
        <ShieldAlert size={16} className="text-status-warn shrink-0" />
        <h2 className="text-sm font-semibold text-text">Pending approvals</h2>
        <span className="text-xs font-normal text-text-subtle">({pending.length})</span>
      </div>
      <p className="text-xs text-text-muted mb-2">
        An MCP agent proposed these destructive actions. They run only after you approve —
        the agent cannot approve its own request. Approvals expire after a few minutes.
      </p>
      {error && <p className="text-xs text-status-fail mb-2">{error}</p>}
      <ul className="space-y-2">
        {pending.map(p => (
          <ApprovalRow key={p.pendingId} entry={p} busy={busyId === p.pendingId} onApprove={approve} />
        ))}
      </ul>
    </Card>
  );
}

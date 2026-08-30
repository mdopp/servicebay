'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
 * the operator already looks ("is my box OK?"). It renders nothing when the
 * queue is *confirmed* empty — but a failed poll is a third state, not an empty
 * one, so it says so instead (#2691). It polls on a short interval to stay
 * fresh, and drives the same `/api/system/mcp/approve` endpoints as the
 * Settings list.
 */

export interface PendingApproval {
  pendingId: string;
  toolName: string;
  args: Record<string, unknown>;
  caller?: string;
  // Durable approvals (#2234) never expire, so this is null; a legacy numeric
  // expiry is still rendered if present.
  expiresAt: number | null;
}

/** Poll cadence — keeps the list fresh against approve/reject from other tabs. */
const POLL_MS = 15_000;

/**
 * Consecutive failed polls before the card says so (#2691).
 *
 * A failed poll and an empty queue used to render identically — both as
 * nothing — so an expired session cookie looked exactly like "all clear" while
 * a destructive action sat unapproved. But the opposite failure is just as
 * real: a banner on every 15s network blip is a banner operators learn to
 * ignore. So one miss is absorbed silently and the *second* consecutive one
 * speaks up — roughly 30s of genuinely not being able to see the queue, which
 * is a real outage rather than a hiccup. Any success resets the count.
 */
const FAILURES_BEFORE_ALERT = 2;

export function usePendingApprovals() {
  const [pending, setPending] = useState<PendingApproval[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const failures = useRef(0);

  const load = useCallback(() => {
    fetch('/api/system/mcp/approve')
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { pending?: PendingApproval[] };
      })
      .then(data => {
        failures.current = 0;
        setPollError(null);
        setPending(data.pending ?? []);
      })
      .catch((e: unknown) => {
        // Deliberately do NOT touch `pending`: a failed poll must never
        // overwrite a known-pending queue with an empty one, and must never
        // turn "we never got a look" into a confirmed-empty [].
        failures.current += 1;
        if (failures.current >= FAILURES_BEFORE_ALERT) {
          setPollError(e instanceof Error ? e.message : String(e));
        }
      });
  }, []);

  const resolve = useCallback(async (id: string, method: 'POST' | 'DELETE') => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/system/mcp/approve/${id}`, { method });
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

  const approve = useCallback((id: string) => resolve(id, 'POST'), [resolve]);
  const reject = useCallback((id: string) => resolve(id, 'DELETE'), [resolve]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return { pending, busyId, error, pollError, approve, reject };
}

function ApprovalRow({ entry, busy, onApprove, onReject }: { entry: PendingApproval; busy: boolean; onApprove: (id: string) => void; onReject: (id: string) => void }) {
  const expiresAtLabel = entry.expiresAt != null ? new Date(entry.expiresAt).toLocaleTimeString() : null;
  return (
    <li className="text-xs rounded-card border border-status-warn/40 bg-status-warn/10 p-2">
      <div className="flex items-center gap-2">
        <span className="font-mono font-semibold text-status-warn">{entry.toolName}</span>
        {entry.caller && <span className="text-text-subtle">from {entry.caller}</span>}
        <span className="text-text-subtle ml-auto">{expiresAtLabel ? `expires ${expiresAtLabel}` : 'awaiting approval'}</span>
      </div>
      <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-text-muted font-mono">{JSON.stringify(entry.args, null, 2)}</pre>
      <div className="mt-1.5 flex justify-end gap-1">
        <Button type="button" variant="danger" size="sm" disabled={busy} onClick={() => onReject(entry.pendingId)}>
          Reject
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => onApprove(entry.pendingId)}>
          <ShieldCheck size={12} />
          {busy ? 'Approving…' : 'Approve & run'}
        </Button>
      </div>
    </li>
  );
}

/**
 * Renders nothing when the queue is *confirmed* empty, so it's safe to drop at
 * the top of Home unconditionally — but renders a warning when the check itself
 * is failing, because silence there would claim "nothing to approve" on the
 * strength of an answer we never got (#2691).
 */
export default function PendingApprovalsCard() {
  const { pending, busyId, error, pollError, approve, reject } = usePendingApprovals();
  const entries = pending ?? [];
  const hasPending = entries.length > 0;
  if (!hasPending && !pollError) return null;

  return (
    <Card padding="lg" className="border-status-warn/50 bg-status-warn/5">
      <div className="flex items-center gap-1.5 mb-2">
        <ShieldAlert size={16} className="text-status-warn shrink-0" />
        <h2 className="text-sm font-semibold text-text">Pending approvals</h2>
        {hasPending && <span className="text-xs font-normal text-text-subtle">({entries.length})</span>}
      </div>
      {pollError && (
        <p className="text-xs text-status-fail mb-2">
          {hasPending
            ? `Couldn't refresh the approval list (${pollError}) — the requests below are the last ones seen and may be out of date.`
            : `Couldn't check for pending approvals (${pollError}). This is not the same as an empty queue — a destructive request may be waiting unseen. Retrying.`}
        </p>
      )}
      {hasPending && (
        <>
          <p className="text-xs text-text-muted mb-2">
            An MCP agent proposed these destructive actions. They run only after you approve —
            the agent cannot approve its own request. Requests persist until you approve or reject them.
          </p>
          {error && <p className="text-xs text-status-fail mb-2">{error}</p>}
          <ul className="space-y-2">
            {entries.map(p => (
              <ApprovalRow key={p.pendingId} entry={p} busy={busyId === p.pendingId} onApprove={approve} onReject={reject} />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

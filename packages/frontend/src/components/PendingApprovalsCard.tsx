'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button, Card } from '@/components/ui';

/**
 * Pending MCP destructive-tool approvals, surfaced on Home (#2203-followup).
 *
 * A token-authenticated MCP agent can only *propose* a destructive tool call;
 * it parks as a pending approval that a human (session cookie) must confirm.
 * If the operator isn't looking they sit unseen — which is exactly what
 * happened when a route deletion was proposed and the Settings-only approval
 * list stayed empty.
 *
 * This card puts the same list on Home so a pending approval is visible where
 * the operator already looks ("is my box OK?"). It renders nothing when the
 * queue is *confirmed* empty — but a failed poll is a third state, not an empty
 * one, so it says so instead (#2691).
 *
 * **One list, one route (#2735).** The hook, the row and the list below are the
 * single implementation shared by Home and Settings → MCP, and they read the
 * durable approvals store through the generic `/api/approvals` route — the same
 * records the operator's Approvals section shows. The old third view
 * (`lib/mcp/approveRoute.ts` behind `/api/system/mcp/approve`) reshaped those
 * records and hard-coded `expiresAt: null`; it is gone.
 */

/**
 * Mirrors the backend `ApprovalRequest` (see `lib/approvals`, #1843) — only the
 * fields these two surfaces read. An approval is an *MCP* approval when it
 * carries an `on_approve.mcp` action, i.e. approving it re-dispatches the tool.
 */
export interface ApprovalRecord {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  payload?: Record<string, unknown> | null;
  on_approve?: { mcp?: { toolName: string; args: Record<string, unknown> } } | null;
}

export interface PendingApproval {
  pendingId: string;
  toolName: string;
  args: Record<string, unknown>;
  caller?: string;
  /** Expiry in epoch ms when the record carries one, else null (durable
   *  approvals do not expire and render a stable label instead). */
  expiresAt: number | null;
}

/** Poll cadence — keeps the list fresh against approve/reject from other tabs. */
const POLL_MS = 15_000;

/**
 * Consecutive failed polls before the surface says so (#2691).
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

/**
 * Read an expiry off the durable record. The removed third view hard-coded
 * `null` here, so an approval that *did* carry a deadline still rendered as
 * "awaiting approval" — the operator could not tell a request that will lapse
 * from one that waits forever. Accepts epoch ms or an ISO timestamp; anything
 * unparseable degrades to `null` rather than "Invalid Date".
 */
function readExpiresAt(payload: Record<string, unknown> | null | undefined): number | null {
  const raw = payload?.expiresAt ?? payload?.expires_at;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** Project the durable approvals feed onto the MCP-kind rows these views show. */
function toPendingMcpApprovals(records: ApprovalRecord[]): PendingApproval[] {
  return records
    .filter(r => r.status === 'pending' && r.on_approve?.mcp)
    .map(r => {
      const mcp = r.on_approve!.mcp!;
      const caller = typeof r.payload?.caller === 'string' ? (r.payload.caller as string) : undefined;
      return {
        pendingId: r.id,
        toolName: mcp.toolName,
        args: mcp.args,
        caller,
        expiresAt: readExpiresAt(r.payload),
      };
    });
}

/**
 * The one pending-MCP-approvals hook (#2735). Home's card and Settings → MCP
 * both mount this; neither runs a poll of its own.
 *
 * `refresh()` is the explicit-user-action variant: it reports a failure on the
 * first miss, with no grace period, because a Refresh button that silently does
 * nothing is the same "reported success, did nothing" defect in miniature.
 */
export function usePendingApprovals() {
  const [pending, setPending] = useState<PendingApproval[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const failures = useRef(0);

  const load = useCallback((reportNow = false) => {
    fetch('/api/approvals')
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { approvals?: ApprovalRecord[] };
      })
      .then(data => {
        failures.current = 0;
        setPollError(null);
        setPending(toPendingMcpApprovals(data.approvals ?? []));
      })
      .catch((e: unknown) => {
        // Deliberately do NOT touch `pending`: a failed poll must never
        // overwrite a known-pending queue with an empty one, and must never
        // turn "we never got a look" into a confirmed-empty [].
        failures.current += 1;
        if (reportNow || failures.current >= FAILURES_BEFORE_ALERT) {
          setPollError(e instanceof Error ? e.message : String(e));
        }
      });
  }, []);

  const resolve = useCallback(async (id: string, decision: 'approve' | 'reject') => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(id)}/${decision}`, { method: 'POST' });
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

  const approve = useCallback((id: string) => resolve(id, 'approve'), [resolve]);
  const reject = useCallback((id: string) => resolve(id, 'reject'), [resolve]);
  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    load();
    const t = setInterval(() => load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return { pending, busyId, error, pollError, approve, reject, refresh };
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

/** The shared row list — Home's card and Settings → MCP render the same rows. */
export function PendingApprovalList({ entries, busyId, onApprove, onReject }: {
  entries: PendingApproval[];
  busyId: string | null;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <ul className="space-y-2">
      {entries.map(p => (
        <ApprovalRow key={p.pendingId} entry={p} busy={busyId === p.pendingId} onApprove={onApprove} onReject={onReject} />
      ))}
    </ul>
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
          <PendingApprovalList entries={entries} busyId={busyId} onApprove={approve} onReject={reject} />
        </>
      )}
    </Card>
  );
}

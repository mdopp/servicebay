'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, ShieldAlert, History, RefreshCw, ShieldCheck } from 'lucide-react';
import SectionHelp from '@/components/SectionHelp';
import { Button, Input } from '@/components/ui';
import { copyToClipboard } from '../clipboard';

interface AuditEntry {
  ts: string;
  tool: string;
  outcome: 'ok' | 'error' | 'blocked';
  durationMs: number;
  args?: Record<string, unknown>;
  errorMessage?: string;
}

function AuditEntryRow({ entry }: { entry: AuditEntry }) {
  const outcomeStyle = entry.outcome === 'ok'
    ? 'text-status-ok'
    : entry.outcome === 'blocked'
      ? 'text-status-warn'
      : 'text-status-fail';
  const outcomeIcon = entry.outcome === 'ok' ? '✓' : entry.outcome === 'blocked' ? '⛔' : '✗';
  return (
    <li className="text-xs border-l-2 border-border pl-2 py-0.5">
      <div className="flex items-center gap-2">
        <span className={`font-mono ${outcomeStyle}`}>{outcomeIcon}</span>
        <span className="font-mono text-text">{entry.tool}</span>
        <span className="text-text-subtle">{entry.durationMs}ms</span>
        <span className="text-text-subtle ml-auto">{new Date(entry.ts).toLocaleTimeString()}</span>
      </div>
      {entry.errorMessage && (
        <div className={`pl-4 mt-0.5 ${outcomeStyle} opacity-80 break-words`}>{entry.errorMessage}</div>
      )}
    </li>
  );
}

function ToggleSwitch({ on, disabled, onColor, ariaChecked, onClick }: { on: boolean | null; disabled: boolean; onColor: string; ariaChecked: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`shrink-0 mt-1 relative inline-flex h-6 w-11 items-center rounded-chip transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${on ? onColor : 'bg-surface-muted border border-border'}`}
      role="switch"
      aria-checked={ariaChecked}
    >
      <span className={`inline-block h-4 w-4 transform rounded-chip bg-white transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

interface SafetyTogglesProps {
  allowMutations: boolean | null;
  allowDangerousExec: boolean | null;
  saving: boolean;
  saveError: string | null;
  onToggleMutations: () => void;
  onToggleDangerous: () => void;
}

function McpSafetyToggles(props: SafetyTogglesProps) {
  const { allowMutations, allowDangerousExec, saving, saveError } = props;
  return (
    <div className="mt-5 pt-4 border-t border-border space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text">Allow MCP clients to mutate state</p>
          <p className="text-xs text-text-muted mt-0.5">
            When off, MCP can <span className="font-medium">read</span> services, logs, health, and config but cannot <span className="font-medium">start/stop/deploy/delete/exec</span>. Recommended baseline; flip on only for trusted clients.
          </p>
        </div>
        <ToggleSwitch
          on={allowMutations}
          disabled={saving || allowMutations === null}
          onColor="bg-accent"
          ariaChecked={allowMutations === true}
          onClick={props.onToggleMutations}
        />
      </div>

      <div className={`flex items-start justify-between gap-4 ${!allowMutations ? 'opacity-50' : ''}`}>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text flex items-center gap-1.5">
            <ShieldAlert size={14} className="text-status-warn shrink-0" />
            Allow dangerous <span className="font-mono">exec_command</span> patterns
          </p>
          <p className="text-xs text-text-muted mt-0.5">
            Advisory tripwire — <span className="font-mono">exec_command</span> refuses cliché-class foot-guns (<span className="font-mono">rm -rf /</span>, <span className="font-mono">mkfs</span>, <span className="font-mono">dd of=/dev/sd*</span>, fork bombs, …) to catch typo-class mistakes. Not a security boundary; trivial quoting bypasses it. The real boundaries are the mutations switch above, per-tool token scopes, the pre-exec snapshot, and the audit log.
          </p>
        </div>
        <ToggleSwitch
          on={allowDangerousExec}
          disabled={saving || !allowMutations || allowDangerousExec === null}
          onColor="bg-status-warn"
          ariaChecked={allowDangerousExec === true}
          onClick={props.onToggleDangerous}
        />
      </div>

      {saveError && (
        <p className="text-xs text-status-fail">Save failed: {saveError}</p>
      )}

      <p className="text-[11px] text-text-subtle italic">
        When mutations are enabled, every destructive call (delete/update/exec/restore) takes a labelled system-config snapshot first. Find them in <span className="font-mono">Settings → Backups</span> with a <span className="font-mono">pre-mutation</span> timestamp.
      </p>
    </div>
  );
}

interface PendingApproval {
  pendingId: string;
  toolName: string;
  args: Record<string, unknown>;
  caller?: string;
  // Durable approvals (#2234) never expire, so this is null; a legacy numeric
  // expiry is still rendered if present.
  expiresAt: number | null;
}

function PendingApprovalRow({ entry, busy, onApprove, onReject }: { entry: PendingApproval; busy: boolean; onApprove: (id: string) => void; onReject: (id: string) => void }) {
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
        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={busy}
          onClick={() => onReject(entry.pendingId)}
        >
          Reject
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => onApprove(entry.pendingId)}
        >
          <ShieldCheck size={12} />
          {busy ? 'Approving…' : 'Approve & run'}
        </Button>
      </div>
    </li>
  );
}

function McpPendingApprovals({ pending, busyId, error, pollError, onRefresh, onApprove, onReject }: {
  pending: PendingApproval[] | null;
  busyId: string | null;
  error: string | null;
  /** Set when the approvals poll itself is failing — a third state, distinct from an empty queue (#2691). */
  pollError: string | null;
  onRefresh: () => void;
  onReject: (id: string) => void;
  onApprove: (id: string) => void;
}) {
  const entries = pending ?? [];
  const hasPending = entries.length > 0;
  // A confirmed-empty queue still renders nothing. A queue we could not read
  // does not — collapsing those two into the same silence is what let a
  // proposed destructive action sit unseen behind an expired session (#2691).
  if (!hasPending && !pollError) return null;
  return (
    <div className="mt-5 pt-4 border-t border-border">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-medium text-text flex items-center gap-1.5">
          <ShieldAlert size={14} className="text-status-warn shrink-0" />
          Pending destructive approvals
          {hasPending && <span className="text-xs font-normal text-text-subtle">({entries.length})</span>}
        </p>
        <Button type="button" variant="secondary" size="sm" onClick={onRefresh}>
          <RefreshCw size={12} /> Refresh
        </Button>
      </div>
      {pollError && (
        <p className="text-xs text-status-fail mb-2">
          {hasPending
            ? `Couldn't refresh the approval list (${pollError}) — the requests below are the last ones seen and may be out of date.`
            : `Couldn't check for pending approvals (${pollError}). This is not the same as an empty queue — a destructive request may be waiting unseen.`}
        </p>
      )}
      {hasPending && (
        <>
          <p className="text-xs text-text-muted mb-2">
            An MCP agent proposed these destructive tool calls. They run only after you approve them here — the agent cannot approve its own request.
          </p>
          {error && <p className="text-xs text-status-fail mb-2">{error}</p>}
          <ul className="space-y-2">
            {entries.map(p => (
              <PendingApprovalRow key={p.pendingId} entry={p} busy={busyId === p.pendingId} onApprove={onApprove} onReject={onReject} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function McpAuditFeed({ entries, loading, onRefresh }: { entries: AuditEntry[] | null; loading: boolean; onRefresh: () => void }) {
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center justify-between text-xs text-text-muted">
        <span>Newest first. Older entries roll over after 5 MB; full log persists in <span className="font-mono">DATA_DIR/mcp-audit.log</span>.</span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>
      {entries && entries.length === 0 && (
        <p className="text-xs text-text-subtle italic">No MCP activity recorded yet.</p>
      )}
      {entries && entries.length > 0 && (
        <ul className="space-y-1.5 max-h-64 overflow-y-auto">
          {entries.map((e, i) => <AuditEntryRow key={`${e.ts}-${i}`} entry={e} />)}
        </ul>
      )}
    </div>
  );
}

/**
 * Endpoint an MCP client that runs **on this box** must use (ADR 0007,
 * amendment 2026-08-17). The card's main field shows `window.location.origin`,
 * which is the browser's view — a public hostname served by nginx-proxy-manager
 * on :443. A container on the box cannot use that: the proxy routes by vhost and
 * this admin host carries a `deny all` LAN-only access list, so the attempt
 * fails as a TLS/404/301 trail that reads like three unrelated problems. The app
 * port has no vhost logic, so it needs no DNS, TLS or `Host` header.
 *
 * The port is the documented default, deliberately NOT derived from
 * `window.location.port`: that reads the port the *browser* reached, which
 * behind a reverse proxy on a non-standard port (`https://box:8443`) is the
 * proxy's port, not the app's — the field would then confidently show an
 * address nothing listens on. `PORT` is a backend env var no client can see, and
 * exposing it would mean a new API surface for one string. So the value is the
 * stock default and the copy says so, which is true for every default install
 * and honest about the one case where it isn't.
 */
const ON_BOX_HOST = 'host.containers.internal';
const DEFAULT_APP_PORT = '5888';

/** Consecutive failed approvals polls before the section says the check is broken (#2691). */
const PENDING_FAILURES_BEFORE_ALERT = 2;

export default function McpSection() {
  const [mcpUrl, setMcpUrl] = useState('');
  const [onBoxUrl, setOnBoxUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [copiedOnBox, setCopiedOnBox] = useState(false);
  const [allowMutations, setAllowMutations] = useState<boolean | null>(null);
  const [allowDangerousExec, setAllowDangerousExec] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [pending, setPending] = useState<PendingApproval[] | null>(null);
  const [approveBusyId, setApproveBusyId] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [pendingPollError, setPendingPollError] = useState<string | null>(null);
  const pendingFailures = useRef(0);

  /**
   * Poll the approvals queue. A failure is absorbed once and reported on the
   * second consecutive miss, so a transient blip on the 15s poll does not train
   * the operator to ignore the banner (#2691). `reportNow` skips that grace for
   * the explicit Refresh click — a button that silently does nothing is the
   * same defect in miniature. On failure `pending` is left untouched: a failed
   * poll must never overwrite a known-pending list with an empty one.
   */
  const loadPending = useCallback((reportNow = false) => {
    fetch('/api/system/mcp/approve')
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { pending?: PendingApproval[] };
      })
      .then(data => {
        pendingFailures.current = 0;
        setPendingPollError(null);
        setPending(data.pending ?? []);
      })
      .catch((e: unknown) => {
        pendingFailures.current += 1;
        if (reportNow || pendingFailures.current >= PENDING_FAILURES_BEFORE_ALERT) {
          setPendingPollError(e instanceof Error ? e.message : String(e));
        }
      });
  }, []);

  const resolvePending = useCallback(async (id: string, method: 'POST' | 'DELETE') => {
    setApproveBusyId(id);
    setApproveError(null);
    try {
      const res = await fetch(`/api/system/mcp/approve/${id}`, { method });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      loadPending();
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : String(e));
    } finally {
      setApproveBusyId(null);
    }
  }, [loadPending]);
  const approvePending = useCallback((id: string) => resolvePending(id, 'POST'), [resolvePending]);
  const rejectPending = useCallback((id: string) => resolvePending(id, 'DELETE'), [resolvePending]);

  const loadAudit = () => {
    setAuditLoading(true);
    fetch('/api/system/mcp-audit?limit=50')
      .then(r => r.ok ? r.json() : { entries: [] })
      .then(data => setAudit(data.entries ?? []))
      .catch(() => setAudit([]))
      .finally(() => setAuditLoading(false));
  };

  useEffect(() => {
    // Read window.location after mount to avoid SSR/hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async settings fetch, guarded by a cancelled flag
    setMcpUrl(`${window.location.origin}/mcp`);
    setOnBoxUrl(`http://${ON_BOX_HOST}:${DEFAULT_APP_PORT}/mcp`);
  }, []);

  // Poll for pending destructive-tool approvals (#1766). In-memory + short TTL,
  // so a light poll keeps the badge fresh without a socket channel.
  useEffect(() => {
    loadPending();
    const t = setInterval(() => loadPending(), 15000);
    return () => clearInterval(t);
  }, [loadPending]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings').then(r => r.ok ? r.json() : null).then((data: { mcp?: { allowMutations?: boolean; allowDangerousExec?: boolean } } | null) => {
      if (cancelled || !data) return;
      // Treat absent allowMutations as `true` for back-compat with installs
      // that predate the flag — same semantics the server uses.
      setAllowMutations(data.mcp?.allowMutations !== false);
      setAllowDangerousExec(data.mcp?.allowDangerousExec === true);
    }).catch(() => { /* leave nulls so spinner stays */ });
    return () => { cancelled = true; };
  }, []);

  const persistMcp = async (next: { allowMutations?: boolean; allowDangerousExec?: boolean }) => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcp: { allowMutations: allowMutations ?? true, allowDangerousExec: allowDangerousExec === true, ...next } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (next.allowMutations !== undefined) setAllowMutations(next.allowMutations);
      if (next.allowDangerousExec !== undefined) setAllowDangerousExec(next.allowDangerousExec);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!mcpUrl) return;
    if (await copyToClipboard(mcpUrl)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleCopyOnBox = async () => {
    if (!onBoxUrl) return;
    if (await copyToClipboard(onBoxUrl)) {
      setCopiedOnBox(true);
      setTimeout(() => setCopiedOnBox(false), 1500);
    }
  };

  return (
    <>
      <div className="flex justify-end">
        <SectionHelp
          helpId="mcp"
          title="Connecting an LLM via MCP"
          label="How to connect"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold uppercase tracking-wider text-text-muted mb-1">
          MCP endpoint
        </label>
        <div className="flex items-stretch gap-2">
          <input
            type="text"
            readOnly
            value={mcpUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="flex-1 font-mono text-sm px-3 py-2 rounded-card border border-border bg-surface-2 text-text"
          />
          <Button
            type="button"
            variant="secondary"
            onClick={handleCopy}
            title="Copy URL"
          >
            {copied ? <Check size={16} className="text-status-ok" /> : <Copy size={16} />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="text-xs text-text-muted mt-2">
          Authenticate with a scoped <span className="font-medium">API token</span> (see the API tokens section) or the same session cookie as this UI. Click <span className="font-medium">How to connect</span> for the full setup walk-through.
        </p>
      </div>

      {/* ADR 0007 amendment 2026-08-17: a client running on this box cannot use
          the endpoint above — that URL is served by nginx-proxy-manager, which
          routes by vhost, and this admin host is deliberately LAN-only. Showing
          the app-port URL here (rather than only in the help modal) is
          deliberate: the failure mode is a TLS/404/301 trail that reads like
          three unrelated problems, and the usual "fix" — an /etc/hosts entry —
          works just long enough to be believed. */}
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wider text-text-muted mb-1">
          From a container on this box
        </label>
        <div className="flex items-stretch gap-2">
          <Input
            type="text"
            readOnly
            value={onBoxUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="flex-1 font-mono text-sm px-3 py-2 rounded-card border border-border bg-surface-2 text-text-muted"
          />
          <Button
            type="button"
            variant="secondary"
            onClick={handleCopyOnBox}
            title="Copy on-box URL"
          >
            {copiedOnBox ? <Check size={16} className="text-status-ok" /> : <Copy size={16} />}
            {copiedOnBox ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="text-xs text-text-muted mt-2">
          For an assistant or CI runner that runs <span className="font-medium">on this machine</span>. It talks to the app port directly, so it needs no DNS, no TLS and no <span className="font-mono">/etc/hosts</span> entry — the endpoint above goes through the reverse proxy, which a container here cannot reach. Authentication is identical. Shows the default app port; if you set <span className="font-mono">PORT</span> on the ServiceBay service, use that instead.
        </p>
      </div>

      {/* Safety toggles. New installs default to read-only (allowMutations=false);
          the operator opts into mutations explicitly. allowDangerousExec is
          gated behind allowMutations and shows an extra warning. */}
      <McpSafetyToggles
        allowMutations={allowMutations}
        allowDangerousExec={allowDangerousExec}
        saving={saving}
        saveError={saveError}
        onToggleMutations={() => persistMcp({ allowMutations: !allowMutations, ...(allowMutations ? { allowDangerousExec: false } : {}) })}
        onToggleDangerous={() => persistMcp({ allowDangerousExec: !allowDangerousExec })}
      />

      {/* Pending destructive-tool approvals (#1766). An MCP token caller can
          propose a destroy-tier tool (delete/purge/restore/factory_reset/USB
          boot) but cannot execute it — it parks here for a logged-in human to
          approve. Renders when something is pending, or when the check for
          pending requests is itself failing (#2691). */}
      <McpPendingApprovals
        pending={pending}
        busyId={approveBusyId}
        error={approveError}
        pollError={pendingPollError}
        onRefresh={() => loadPending(true)}
        onApprove={approvePending}
        onReject={rejectPending}
      />

      {/* Recent MCP activity. Toggleable so the section stays compact for
          operators who don't care about the audit feed. Lazy-loads on
          open so a heavy log doesn't slow down the rest of Settings. */}
      <div className="mt-4 pt-4 border-t border-border">
        <button
          type="button"
          onClick={() => {
            const next = !auditOpen;
            setAuditOpen(next);
            if (next && audit === null) loadAudit();
          }}
          className="w-full flex items-center justify-between text-sm font-medium text-text hover:text-accent"
        >
          <span className="flex items-center gap-2">
            <History size={14} />
            Recent MCP activity
            {audit && (
              <span className="text-xs font-normal text-text-subtle">({audit.length} entr{audit.length === 1 ? 'y' : 'ies'})</span>
            )}
          </span>
          <span className="text-xs text-text-subtle">{auditOpen ? '▾' : '▸'}</span>
        </button>
        {auditOpen && <McpAuditFeed entries={audit} loading={auditLoading} onRefresh={loadAudit} />}
      </div>
    </>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bot, Check, Copy, ShieldAlert, History, RefreshCw, ShieldCheck } from 'lucide-react';
import SectionHelp from '@/components/SectionHelp';
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
    ? 'text-emerald-600 dark:text-emerald-400'
    : entry.outcome === 'blocked'
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-red-600 dark:text-red-400';
  const outcomeIcon = entry.outcome === 'ok' ? '✓' : entry.outcome === 'blocked' ? '⛔' : '✗';
  return (
    <li className="text-xs border-l-2 border-gray-200 dark:border-gray-700 pl-2 py-0.5">
      <div className="flex items-center gap-2">
        <span className={`font-mono ${outcomeStyle}`}>{outcomeIcon}</span>
        <span className="font-mono text-gray-900 dark:text-gray-100">{entry.tool}</span>
        <span className="text-gray-400">{entry.durationMs}ms</span>
        <span className="text-gray-400 ml-auto">{new Date(entry.ts).toLocaleTimeString()}</span>
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
      className={`shrink-0 mt-1 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${on ? onColor : 'bg-gray-300 dark:bg-gray-600'}`}
      role="switch"
      aria-checked={ariaChecked}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
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
    <div className="mt-5 pt-4 border-t border-gray-100 dark:border-gray-800 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Allow MCP clients to mutate state</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            When off, MCP can <span className="font-medium">read</span> services, logs, health, and config but cannot <span className="font-medium">start/stop/deploy/delete/exec</span>. Recommended baseline; flip on only for trusted clients.
          </p>
        </div>
        <ToggleSwitch
          on={allowMutations}
          disabled={saving || allowMutations === null}
          onColor="bg-blue-600"
          ariaChecked={allowMutations === true}
          onClick={props.onToggleMutations}
        />
      </div>

      <div className={`flex items-start justify-between gap-4 ${!allowMutations ? 'opacity-50' : ''}`}>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
            <ShieldAlert size={14} className="text-amber-500 shrink-0" />
            Allow dangerous <span className="font-mono">exec_command</span> patterns
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Advisory tripwire — <span className="font-mono">exec_command</span> refuses cliché-class foot-guns (<span className="font-mono">rm -rf /</span>, <span className="font-mono">mkfs</span>, <span className="font-mono">dd of=/dev/sd*</span>, fork bombs, …) to catch typo-class mistakes. Not a security boundary; trivial quoting bypasses it. The real boundaries are the mutations switch above, per-tool token scopes, the pre-exec snapshot, and the audit log.
          </p>
        </div>
        <ToggleSwitch
          on={allowDangerousExec}
          disabled={saving || !allowMutations || allowDangerousExec === null}
          onColor="bg-amber-600"
          ariaChecked={allowDangerousExec === true}
          onClick={props.onToggleDangerous}
        />
      </div>

      {saveError && (
        <p className="text-xs text-red-600 dark:text-red-400">Save failed: {saveError}</p>
      )}

      <p className="text-[11px] text-gray-400 dark:text-gray-500 italic">
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
  expiresAt: number;
}

function PendingApprovalRow({ entry, busy, onApprove }: { entry: PendingApproval; busy: boolean; onApprove: (id: string) => void }) {
  // Absolute expiry time (not a Date.now()-derived countdown) so render stays
  // pure; the 15s poll drops expired entries off the list anyway.
  const expiresAtLabel = new Date(entry.expiresAt).toLocaleTimeString();
  return (
    <li className="text-xs rounded-md border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-900/20 p-2">
      <div className="flex items-center gap-2">
        <span className="font-mono font-semibold text-amber-700 dark:text-amber-300">{entry.toolName}</span>
        {entry.caller && <span className="text-gray-500">from {entry.caller}</span>}
        <span className="text-gray-400 ml-auto">expires {expiresAtLabel}</span>
      </div>
      <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-gray-600 dark:text-gray-300 font-mono">{JSON.stringify(entry.args, null, 2)}</pre>
      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          disabled={busy}
          onClick={() => onApprove(entry.pendingId)}
          className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50 flex items-center gap-1"
        >
          <ShieldCheck size={12} />
          {busy ? 'Approving…' : 'Approve & run'}
        </button>
      </div>
    </li>
  );
}

function McpPendingApprovals({ pending, busyId, error, onRefresh, onApprove }: {
  pending: PendingApproval[] | null;
  busyId: string | null;
  error: string | null;
  onRefresh: () => void;
  onApprove: (id: string) => void;
}) {
  if (!pending || pending.length === 0) return null;
  return (
    <div className="mt-5 pt-4 border-t border-gray-100 dark:border-gray-800">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
          <ShieldAlert size={14} className="text-amber-500 shrink-0" />
          Pending destructive approvals
          <span className="text-xs font-normal text-gray-500">({pending.length})</span>
        </p>
        <button
          type="button"
          onClick={onRefresh}
          className="text-xs flex items-center gap-1 px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
        An MCP agent proposed these destructive tool calls. They run only after you approve them here — the agent cannot approve its own request.
      </p>
      {error && <p className="text-xs text-red-600 dark:text-red-400 mb-2">{error}</p>}
      <ul className="space-y-2">
        {pending.map(p => (
          <PendingApprovalRow key={p.pendingId} entry={p} busy={busyId === p.pendingId} onApprove={onApprove} />
        ))}
      </ul>
    </div>
  );
}

function McpAuditFeed({ entries, loading, onRefresh }: { entries: AuditEntry[] | null; loading: boolean; onRefresh: () => void }) {
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
        <span>Newest first. Older entries roll over after 5 MB; full log persists in <span className="font-mono">DATA_DIR/mcp-audit.log</span>.</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="flex items-center gap-1 px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {entries && entries.length === 0 && (
        <p className="text-xs text-gray-500 italic">No MCP activity recorded yet.</p>
      )}
      {entries && entries.length > 0 && (
        <ul className="space-y-1.5 max-h-64 overflow-y-auto">
          {entries.map((e, i) => <AuditEntryRow key={`${e.ts}-${i}`} entry={e} />)}
        </ul>
      )}
    </div>
  );
}

export default function McpSection() {
  const [mcpUrl, setMcpUrl] = useState('');
  const [copied, setCopied] = useState(false);
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

  const loadPending = useCallback(() => {
    fetch('/api/system/mcp/approve')
      .then(r => r.ok ? r.json() : { pending: [] })
      .then((data: { pending?: PendingApproval[] }) => setPending(data.pending ?? []))
      .catch(() => setPending([]));
  }, []);

  const approvePending = useCallback(async (id: string) => {
    setApproveBusyId(id);
    setApproveError(null);
    try {
      const res = await fetch(`/api/system/mcp/approve/${id}`, { method: 'POST' });
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
    setMcpUrl(`${window.location.origin}/mcp`);
  }, []);

  // Poll for pending destructive-tool approvals (#1766). In-memory + short TTL,
  // so a light poll keeps the badge fresh without a socket channel.
  useEffect(() => {
    loadPending();
    const t = setInterval(loadPending, 15000);
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

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-purple-100 dark:bg-purple-900/30 rounded-lg">
            <Bot size={20} className="text-purple-600 dark:text-purple-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">MCP Server</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Let an AI assistant (Claude Code, Claude Desktop, …) drive ServiceBay through the Model Context Protocol.
            </p>
          </div>
        </div>
        <SectionHelp
          helpId="mcp"
          title="Connecting an LLM via MCP"
          label="How to connect"
        />
      </div>

      <div className="mt-4">
        <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">
          MCP endpoint
        </label>
        <div className="flex items-stretch gap-2">
          <input
            type="text"
            readOnly
            value={mcpUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="flex-1 font-mono text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100"
          />
          <button
            type="button"
            onClick={handleCopy}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center gap-2 text-sm"
            title="Copy URL"
          >
            {copied ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
          Authenticate with a scoped <span className="font-medium">API token</span> (see the API tokens section) or the same session cookie as this UI. Click <span className="font-medium">How to connect</span> for the full setup walk-through.
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
          approve. Only renders when something is pending. */}
      <McpPendingApprovals
        pending={pending}
        busyId={approveBusyId}
        error={approveError}
        onRefresh={loadPending}
        onApprove={approvePending}
      />

      {/* Recent MCP activity. Toggleable so the section stays compact for
          operators who don't care about the audit feed. Lazy-loads on
          open so a heavy log doesn't slow down the rest of Settings. */}
      <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
        <button
          type="button"
          onClick={() => {
            const next = !auditOpen;
            setAuditOpen(next);
            if (next && audit === null) loadAudit();
          }}
          className="w-full flex items-center justify-between text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400"
        >
          <span className="flex items-center gap-2">
            <History size={14} />
            Recent MCP activity
            {audit && (
              <span className="text-xs font-normal text-gray-500">({audit.length} entr{audit.length === 1 ? 'y' : 'ies'})</span>
            )}
          </span>
          <span className="text-xs text-gray-400">{auditOpen ? '▾' : '▸'}</span>
        </button>
        {auditOpen && <McpAuditFeed entries={audit} loading={auditLoading} onRefresh={loadAudit} />}
      </div>
    </div>
  );
}

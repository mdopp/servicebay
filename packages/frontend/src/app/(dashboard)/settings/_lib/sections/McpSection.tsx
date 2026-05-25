'use client';

import { useEffect, useState } from 'react';
import { Bot, Check, Copy, ShieldAlert, History, RefreshCw, Key, Plus, Trash2 } from 'lucide-react';
import SectionHelp from '@/components/SectionHelp';

interface AuditEntry {
  ts: string;
  tool: string;
  outcome: 'ok' | 'error' | 'blocked';
  durationMs: number;
  args?: Record<string, unknown>;
  errorMessage?: string;
}

type ApiScope = 'read' | 'lifecycle' | 'mutate' | 'destroy' | 'exec';
const ALL_SCOPES: ApiScope[] = ['read', 'lifecycle', 'mutate', 'destroy', 'exec'];

/**
 * Copy text to clipboard with HTTP fallback.
 *
 * navigator.clipboard.writeText is gated behind the secure-context spec,
 * which means it silently rejects on plain http://192.168.x.x origins.
 * That's exactly the deployment shape ServiceBay ships in by default,
 * so copy buttons would fail with no feedback for the operator.
 *
 * Fallback: a hidden textarea + document.execCommand('copy') still works
 * in plain-HTTP contexts. Deprecated but universally supported by the
 * browsers we care about — and the API isn't going anywhere imminently.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  // Modern path: only works in secure contexts (HTTPS or localhost).
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy
    }
  }
  // Legacy path: hidden textarea + execCommand('copy').
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.setAttribute('readonly', '');
  document.body.appendChild(ta);
  try {
    ta.select();
    const ok = document.execCommand('copy');
    return ok;
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}

interface TokenView {
  id: string;
  name: string;
  scopes: ApiScope[];
  prefix: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  createdBy: string;
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

  const loadAudit = () => {
    setAuditLoading(true);
    fetch('/api/system/mcp-audit?limit=50')
      .then(r => r.ok ? r.json() : { entries: [] })
      .then(data => setAudit(data.entries ?? []))
      .catch(() => setAudit([]))
      .finally(() => setAuditLoading(false));
  };

  // ── Bootstrap-token state (#322) ──────────────────────────────────
  // The hash is set by the install script; this UI just reflects
  // status + offers a manual revoke. Auto-revoked when the operator
  // mints their first regular MCP token below.
  type BootstrapStatus =
    | { active: false }
    | { active: true; expiresAt: string | null; minutesRemaining: number | null };
  const [bootstrap, setBootstrap] = useState<BootstrapStatus | null>(null);
  const [revokingBootstrap, setRevokingBootstrap] = useState(false);

  const loadBootstrap = () => {
    fetch('/api/system/mcp-bootstrap')
      .then(r => r.ok ? r.json() : { active: false })
      .then((data: BootstrapStatus) => setBootstrap(data))
      .catch(() => setBootstrap({ active: false }));
  };

  const revokeBootstrap = async () => {
    setRevokingBootstrap(true);
    try {
      await fetch('/api/system/mcp-bootstrap', { method: 'DELETE' });
      loadBootstrap();
    } finally {
      setRevokingBootstrap(false);
    }
  };

  // ── API token state ──────────────────────────────────────────────
  const [tokensOpen, setTokensOpen] = useState(false);
  const [tokens, setTokens] = useState<TokenView[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newScopes, setNewScopes] = useState<ApiScope[]>(['read']);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  const loadTokens = () => {
    fetch('/api/system/mcp-tokens')
      .then(r => r.ok ? r.json() : { tokens: [] })
      .then(data => setTokens(data.tokens ?? []))
      .catch(() => setTokens([]));
  };

  const createNewToken = async () => {
    if (!newName.trim() || newScopes.length === 0) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/system/mcp-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), scopes: newScopes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setRevealedSecret(data.secret);
      setNewName('');
      setNewScopes(['read']);
      setShowCreate(false);
      loadTokens();
      // Server-side createToken auto-revokes the bootstrap token —
      // refresh the panel so the operator sees it disappear.
      loadBootstrap();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const revokeOneToken = async (id: string, name: string) => {
    if (!confirm(`Revoke token "${name}"? Any client using this token will be locked out immediately.`)) return;
    const res = await fetch(`/api/system/mcp-tokens?id=${id}`, { method: 'DELETE' });
    if (res.ok) loadTokens();
  };

  const copySecret = async () => {
    if (!revealedSecret) return;
    if (await copyToClipboard(revealedSecret)) {
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 1500);
    }
  };

  const toggleScope = (scope: ApiScope) => {
    setNewScopes(prev => prev.includes(scope) ? prev.filter(s => s !== scope) : [...prev, scope]);
  };

  useEffect(() => {
    // Read window.location after mount to avoid SSR/hydration mismatch.

    setMcpUrl(`${window.location.origin}/mcp`);
    // Bootstrap-token status (#322) loads alongside the rest of the
    // panel so a fresh-install operator sees the active bootstrap
    // banner without having to expand a sub-section.
    fetch('/api/system/mcp-bootstrap')
      .then(r => r.ok ? r.json() : { active: false })
      .then((data: BootstrapStatus) => setBootstrap(data))
      .catch(() => setBootstrap({ active: false }));

  }, []);

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

      {bootstrap?.active && (
        <div className="mt-4 rounded-lg border border-amber-200 dark:border-amber-700/40 bg-amber-50/80 dark:bg-amber-900/20 px-4 py-3 flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">Bootstrap token active</p>
            <p className="text-xs text-amber-800/90 dark:text-amber-200/80 mt-0.5">
              {bootstrap.minutesRemaining !== null
                ? `LAN-only, read scope, ${bootstrap.minutesRemaining} min remaining.`
                : 'LAN-only, read scope. Expiry will be set on next server boot.'}
              {' '}Auto-revokes when you mint your first regular token below.
            </p>
          </div>
          <button
            type="button"
            disabled={revokingBootstrap}
            onClick={revokeBootstrap}
            className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-100 bg-white dark:bg-amber-900/40 hover:bg-amber-100 dark:hover:bg-amber-900/60 disabled:opacity-50"
          >
            {revokingBootstrap ? 'Revoking…' : 'Revoke now'}
          </button>
        </div>
      )}

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
          Auth uses the same session cookie as this UI. Click <span className="font-medium">How to connect</span> for the full setup walk-through.
        </p>
      </div>

      {/* Safety toggles. New installs default to read-only (allowMutations=false);
          the operator opts into mutations explicitly. allowDangerousExec is
          gated behind allowMutations and shows an extra warning. */}
      <div className="mt-5 pt-4 border-t border-gray-100 dark:border-gray-800 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Allow MCP clients to mutate state</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              When off, MCP can <span className="font-medium">read</span> services, logs, health, and config but cannot <span className="font-medium">start/stop/deploy/delete/exec</span>. Recommended baseline; flip on only for trusted clients.
            </p>
          </div>
          <button
            type="button"
            disabled={saving || allowMutations === null}
            onClick={() => persistMcp({ allowMutations: !allowMutations, ...(allowMutations ? { allowDangerousExec: false } : {}) })}
            className={`shrink-0 mt-1 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
              allowMutations ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
            }`}
            role="switch"
            aria-checked={allowMutations === true}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${allowMutations ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
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
          <button
            type="button"
            disabled={saving || !allowMutations || allowDangerousExec === null}
            onClick={() => persistMcp({ allowDangerousExec: !allowDangerousExec })}
            className={`shrink-0 mt-1 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              allowDangerousExec ? 'bg-amber-600' : 'bg-gray-300 dark:bg-gray-600'
            }`}
            role="switch"
            aria-checked={allowDangerousExec === true}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${allowDangerousExec ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>

        {saveError && (
          <p className="text-xs text-red-600 dark:text-red-400">Save failed: {saveError}</p>
        )}

        <p className="text-[11px] text-gray-400 dark:text-gray-500 italic">
          When mutations are enabled, every destructive call (delete/update/exec/restore) takes a labelled system-config snapshot first. Find them in <span className="font-mono">Settings → Backups</span> with a <span className="font-mono">pre-mutation</span> timestamp.
        </p>
      </div>

      {/* API tokens — named, revocable credentials with explicit scopes.
          The Bearer-token auth path is preferred over the session cookie:
          it's revocable per-client, lets you scope down to read-only, and
          appears as `caller` in the audit log so you can attribute calls.
          Cookie auth still works but always carries all scopes. */}
      <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
        <button
          type="button"
          onClick={() => {
            const next = !tokensOpen;
            setTokensOpen(next);
            if (next && tokens === null) loadTokens();
          }}
          className="w-full flex items-center justify-between text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400"
        >
          <span className="flex items-center gap-2">
            <Key size={14} />
            API tokens
            {tokens && (
              <span className="text-xs font-normal text-gray-500">({tokens.length})</span>
            )}
          </span>
          <span className="text-xs text-gray-400">{tokensOpen ? '▾' : '▸'}</span>
        </button>
        {tokensOpen && (
          <div className="mt-3 space-y-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Per-client credentials with explicit scopes. Pass as <span className="font-mono">Authorization: Bearer sb_…</span> on every MCP request. Revocable here without disturbing other clients.
            </p>

            {revealedSecret && (
              <div className="p-3 bg-amber-50 dark:bg-amber-900/30 rounded border border-amber-300 dark:border-amber-700 space-y-2">
                <p className="text-xs font-semibold text-amber-900 dark:text-amber-100">⚠️ Save this token now — it will not be shown again.</p>
                <div className="flex items-stretch gap-2">
                  <input
                    type="text"
                    readOnly
                    value={revealedSecret}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 font-mono text-xs px-2 py-1.5 rounded border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                  />
                  <button
                    type="button"
                    onClick={copySecret}
                    className="px-3 py-1.5 text-xs rounded bg-amber-600 hover:bg-amber-700 text-white flex items-center gap-1"
                  >
                    {secretCopied ? <Check size={12} /> : <Copy size={12} />}
                    {secretCopied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRevealedSecret(null)}
                    className="px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300 hover:underline"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {tokens && tokens.length > 0 && (
              <ul className="space-y-1.5">
                {tokens.map(t => (
                  <li key={t.id} className="flex items-center justify-between gap-3 px-2 py-1.5 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-gray-900 dark:text-gray-100 truncate">{t.name}</span>
                        <span className="font-mono text-xs text-gray-500">sb_{t.id}_{t.prefix}…</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {t.scopes.map(s => (
                          <span key={s} className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
                            s === 'destroy' ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300' :
                            s === 'exec' ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300' :
                            s === 'mutate' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300' :
                            s === 'lifecycle' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' :
                            'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                          }`}>{s}</span>
                        ))}
                        <span className="text-[10px] text-gray-400">
                          {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString()}` : 'never used'}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => revokeOneToken(t.id, t.name)}
                      className="shrink-0 p-1.5 rounded text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
                      title="Revoke"
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {tokens && tokens.length === 0 && !showCreate && (
              <p className="text-xs text-gray-500 italic">No tokens yet. Create one for each MCP client (Claude Code, Claude Desktop, …).</p>
            )}

            {showCreate ? (
              <div className="space-y-2 p-3 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1">Name</label>
                  <input
                    type="text"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    placeholder="e.g. Claude Code on workstation"
                    className="w-full px-2 py-1.5 text-sm rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1">Scopes</label>
                  <div className="flex flex-wrap gap-2">
                    {ALL_SCOPES.map(scope => (
                      <label key={scope} className="flex items-center gap-1.5 text-xs cursor-pointer">
                        <input
                          type="checkbox"
                          checked={newScopes.includes(scope)}
                          onChange={() => toggleScope(scope)}
                          className="rounded"
                        />
                        <span className="font-mono">{scope}</span>
                      </label>
                    ))}
                  </div>
                  <p className="text-[10px] text-gray-400 mt-1">read = list/get only. lifecycle = start/stop/restart. mutate = create/update/config-edit. destroy = delete/restore/purge. exec = exec_command (shell). Tokens with destroy also implicitly grant exec for back-compat (#591).</p>
                </div>
                {createError && <p className="text-xs text-red-600">{createError}</p>}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={createNewToken}
                    disabled={creating || !newName.trim() || newScopes.length === 0}
                    className="flex-1 px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
                  >
                    {creating ? 'Creating…' : 'Create'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowCreate(false); setCreateError(null); }}
                    className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-1.5 px-2 py-1 text-xs rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                <Plus size={12} />
                New token
              </button>
            )}
          </div>
        )}
      </div>

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
        {auditOpen && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>Newest first. Older entries roll over after 5 MB; full log persists in <span className="font-mono">DATA_DIR/mcp-audit.log</span>.</span>
              <button
                type="button"
                onClick={loadAudit}
                disabled={auditLoading}
                className="flex items-center gap-1 px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
              >
                <RefreshCw size={12} className={auditLoading ? 'animate-spin' : ''} />
                {auditLoading ? 'Loading…' : 'Refresh'}
              </button>
            </div>
            {audit && audit.length === 0 && (
              <p className="text-xs text-gray-500 italic">No MCP activity recorded yet.</p>
            )}
            {audit && audit.length > 0 && (
              <ul className="space-y-1.5 max-h-64 overflow-y-auto">
                {audit.map((e, i) => {
                  const outcomeStyle = e.outcome === 'ok'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : e.outcome === 'blocked'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-red-600 dark:text-red-400';
                  const outcomeIcon = e.outcome === 'ok' ? '✓' : e.outcome === 'blocked' ? '⛔' : '✗';
                  return (
                    <li key={`${e.ts}-${i}`} className="text-xs border-l-2 border-gray-200 dark:border-gray-700 pl-2 py-0.5">
                      <div className="flex items-center gap-2">
                        <span className={`font-mono ${outcomeStyle}`}>{outcomeIcon}</span>
                        <span className="font-mono text-gray-900 dark:text-gray-100">{e.tool}</span>
                        <span className="text-gray-400">{e.durationMs}ms</span>
                        <span className="text-gray-400 ml-auto">{new Date(e.ts).toLocaleTimeString()}</span>
                      </div>
                      {e.errorMessage && (
                        <div className={`pl-4 mt-0.5 ${outcomeStyle} opacity-80 break-words`}>{e.errorMessage}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

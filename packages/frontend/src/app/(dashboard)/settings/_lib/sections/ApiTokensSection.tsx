'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Key, Plus, Trash2 } from 'lucide-react';
import { copyToClipboard } from '../clipboard';

type ApiScope = 'read' | 'lifecycle' | 'mutate' | 'destroy' | 'exec';
const ALL_SCOPES: ApiScope[] = ['read', 'lifecycle', 'mutate', 'destroy', 'exec'];

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

type BootstrapStatus =
  | { active: false; present?: boolean }
  | { active: true; present?: boolean; expiresAt: string | null; minutesRemaining: number | null };

const SCOPE_BADGE: Record<ApiScope, string> = {
  destroy: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300',
  exec: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
  mutate: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
  lifecycle: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  read: 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
};

function BootstrapBanner({ status, revoking, reactivating, onRevoke, onReactivate }: { status: BootstrapStatus; revoking: boolean; reactivating: boolean; onRevoke: () => void; onReactivate: () => void }) {
  // Show whenever the bootstrap entry still exists — including after its
  // window lapsed — so an expired token can be re-activated (#1419).
  if (!status.active && !status.present) return null;
  const btnClass = 'text-xs font-medium px-3 py-1.5 rounded-lg border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-100 bg-white dark:bg-amber-900/40 hover:bg-amber-100 dark:hover:bg-amber-900/60 disabled:opacity-50';
  return (
    <div className="mt-4 rounded-lg border border-amber-200 dark:border-amber-700/40 bg-amber-50/80 dark:bg-amber-900/20 px-4 py-3 flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{status.active ? 'Bootstrap token active' : 'Bootstrap token expired'}</p>
        <p className="text-xs text-amber-800/90 dark:text-amber-200/80 mt-0.5">
          {status.active
            ? (status.minutesRemaining !== null
                ? `LAN-only, read scope, ${status.minutesRemaining} min remaining.`
                : 'LAN-only, read scope. Expiry will be set on next server boot.')
            : 'LAN-only, read scope. Re-activate to reconnect an MCP client for ~30 min — same token, no new credential.'}
          {' '}Auto-revokes when you mint your first regular token below.
        </p>
      </div>
      <div className="shrink-0 flex items-center gap-2">
        <button
          type="button"
          disabled={reactivating}
          onClick={onReactivate}
          className={btnClass}
          title="Re-issue the existing LAN-only bootstrap token for another ~30 minutes so an MCP client can reconnect — same token value."
        >
          {reactivating ? 'Re-activating…' : 'Re-activate (30 min)'}
        </button>
        <button type="button" disabled={revoking} onClick={onRevoke} className={btnClass}>
          {revoking ? 'Revoking…' : 'Revoke now'}
        </button>
      </div>
    </div>
  );
}

function RevealedSecretBox({ secret, copied, onCopy, onDismiss }: { secret: string; copied: boolean; onCopy: () => void; onDismiss: () => void }) {
  return (
    <div className="p-3 bg-amber-50 dark:bg-amber-900/30 rounded border border-amber-300 dark:border-amber-700 space-y-2">
      <p className="text-xs font-semibold text-amber-900 dark:text-amber-100">⚠️ Save this token now — it will not be shown again.</p>
      <div className="flex items-stretch gap-2">
        <input
          type="text"
          readOnly
          value={secret}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 font-mono text-xs px-2 py-1.5 rounded border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
        />
        <button type="button" onClick={onCopy} className="px-3 py-1.5 text-xs rounded bg-amber-600 hover:bg-amber-700 text-white flex items-center gap-1">
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={onDismiss} className="px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300 hover:underline">
          Dismiss
        </button>
      </div>
    </div>
  );
}

function TokenRow({ token, onRevoke }: { token: TokenView; onRevoke: (id: string, name: string) => void }) {
  return (
    <li className="flex items-center justify-between gap-3 px-2 py-1.5 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium text-gray-900 dark:text-gray-100 truncate">{token.name}</span>
          <span className="font-mono text-xs text-gray-500">sb_{token.id}_{token.prefix}…</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {token.scopes.map(s => (
            <span key={s} className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${SCOPE_BADGE[s]}`}>{s}</span>
          ))}
          <span className="text-[10px] text-gray-400">
            {token.lastUsedAt ? `last used ${new Date(token.lastUsedAt).toLocaleString()}` : 'never used'}
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => onRevoke(token.id, token.name)}
        className="shrink-0 p-1.5 rounded text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
        title="Revoke"
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

interface CreateTokenFormProps {
  name: string;
  scopes: ApiScope[];
  creating: boolean;
  error: string | null;
  onName: (v: string) => void;
  onToggleScope: (s: ApiScope) => void;
  onCreate: () => void;
  onCancel: () => void;
}

function CreateTokenForm(props: CreateTokenFormProps) {
  return (
    <div className="space-y-2 p-3 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1">Name</label>
        <input
          type="text"
          value={props.name}
          onChange={e => props.onName(e.target.value)}
          placeholder="e.g. Claude Code on workstation"
          className="w-full px-2 py-1.5 text-sm rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
        />
      </div>
      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1">Scopes</label>
        <div className="flex flex-wrap gap-2">
          {ALL_SCOPES.map(scope => (
            <label key={scope} className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="checkbox" checked={props.scopes.includes(scope)} onChange={() => props.onToggleScope(scope)} className="rounded" />
              <span className="font-mono">{scope}</span>
            </label>
          ))}
        </div>
        <p className="text-[10px] text-gray-400 mt-1">read = list/get only. lifecycle = start/stop/restart. mutate = create/update/config-edit. destroy = delete/restore/purge. exec = exec_command (shell). Tokens with destroy also implicitly grant exec for back-compat (#591).</p>
      </div>
      {props.error && <p className="text-xs text-red-600">{props.error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={props.onCreate}
          disabled={props.creating || !props.name.trim() || props.scopes.length === 0}
          className="flex-1 px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
        >
          {props.creating ? 'Creating…' : 'Create'}
        </button>
        <button type="button" onClick={props.onCancel} className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Named, revocable API tokens — the single credential surface for both the
 * MCP server and (opt-in) REST API routes (#1264). Split out of the MCP
 * settings section once the same token started authenticating REST too, so
 * token management lives in one place regardless of which surface uses it.
 */
export default function ApiTokensSection() {
  const [bootstrap, setBootstrap] = useState<BootstrapStatus | null>(null);
  const [revokingBootstrap, setRevokingBootstrap] = useState(false);
  const [reactivatingBootstrap, setReactivatingBootstrap] = useState(false);
  const [tokens, setTokens] = useState<TokenView[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newScopes, setNewScopes] = useState<ApiScope[]>(['read']);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  // The hash is set by the install script; this UI just reflects status +
  // offers a manual revoke. Auto-revoked when the operator mints their first
  // regular token (#322).
  const loadBootstrap = useCallback(() => {
    fetch('/api/system/mcp-bootstrap')
      .then(r => r.ok ? r.json() : { active: false })
      .then((data: BootstrapStatus) => setBootstrap(data))
      .catch(() => setBootstrap({ active: false }));
  }, []);

  const loadTokens = useCallback(() => {
    fetch('/api/system/api-tokens')
      .then(r => r.ok ? r.json() : { tokens: [] })
      .then(data => setTokens(data.tokens ?? []))
      .catch(() => setTokens([]));
  }, []);

  useEffect(() => {
    loadBootstrap();
    loadTokens();
  }, [loadBootstrap, loadTokens]);

  const revokeBootstrap = async () => {
    setRevokingBootstrap(true);
    try {
      await fetch('/api/system/mcp-bootstrap', { method: 'DELETE' });
      loadBootstrap();
    } finally {
      setRevokingBootstrap(false);
    }
  };

  // Re-issue the existing bootstrap token for another ~30 min (#1419) — same
  // token value, so an MCP client reconnects without a fresh credential.
  const reactivateBootstrap = async () => {
    setReactivatingBootstrap(true);
    try {
      await fetch('/api/system/mcp-bootstrap', { method: 'POST' });
      loadBootstrap();
    } finally {
      setReactivatingBootstrap(false);
    }
  };

  const createNewToken = async () => {
    if (!newName.trim() || newScopes.length === 0) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/system/api-tokens', {
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
      // refresh the banner so the operator sees it disappear.
      loadBootstrap();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const revokeOneToken = async (id: string, name: string) => {
    if (!confirm(`Revoke token "${name}"? Any client using this token will be locked out immediately.`)) return;
    const res = await fetch(`/api/system/api-tokens?id=${id}`, { method: 'DELETE' });
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

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-emerald-100 dark:bg-emerald-900/30 rounded-lg">
          <Key size={20} className="text-emerald-600 dark:text-emerald-400" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">API tokens</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Named, revocable, scoped credentials. One token authenticates both the MCP server and opt-in REST API routes (e.g. the ServiceBay TUI or a script).
          </p>
        </div>
      </div>

      {bootstrap && <BootstrapBanner status={bootstrap} revoking={revokingBootstrap} reactivating={reactivatingBootstrap} onRevoke={revokeBootstrap} onReactivate={reactivateBootstrap} />}

      <div className="mt-4 space-y-3">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Pass as <span className="font-mono">Authorization: Bearer sb_…</span> on MCP requests and on opt-in REST API routes. Each token is revocable here without disturbing other clients, and appears as <span className="font-mono">caller</span> in the MCP audit log.
        </p>

        {revealedSecret && (
          <RevealedSecretBox secret={revealedSecret} copied={secretCopied} onCopy={copySecret} onDismiss={() => setRevealedSecret(null)} />
        )}

        {tokens && tokens.length > 0 && (
          <ul className="space-y-1.5">
            {tokens.map(t => <TokenRow key={t.id} token={t} onRevoke={revokeOneToken} />)}
          </ul>
        )}
        {tokens && tokens.length === 0 && !showCreate && (
          <p className="text-xs text-gray-500 italic">No tokens yet. Create one per client — an MCP assistant (Claude Code, Claude Desktop, …), the ServiceBay TUI, or a script.</p>
        )}

        {showCreate ? (
          <CreateTokenForm
            name={newName}
            scopes={newScopes}
            creating={creating}
            error={createError}
            onName={setNewName}
            onToggleScope={toggleScope}
            onCreate={createNewToken}
            onCancel={() => { setShowCreate(false); setCreateError(null); }}
          />
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
    </div>
  );
}

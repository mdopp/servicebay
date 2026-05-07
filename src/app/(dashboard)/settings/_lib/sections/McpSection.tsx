'use client';

import { useEffect, useState } from 'react';
import { Bot, Check, Copy, ShieldAlert } from 'lucide-react';
import PluginHelp from '@/components/PluginHelp';

export default function McpSection() {
  const [mcpUrl, setMcpUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [allowMutations, setAllowMutations] = useState<boolean | null>(null);
  const [allowDangerousExec, setAllowDangerousExec] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    // Read window.location after mount to avoid SSR/hydration mismatch.
     
    setMcpUrl(`${window.location.origin}/mcp`);
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
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be blocked on insecure origins; user can select & copy manually
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
        <PluginHelp
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
              By default <span className="font-mono">exec_command</span> refuses obvious foot-guns: <span className="font-mono">rm -rf /</span>, <span className="font-mono">mkfs</span>, <span className="font-mono">dd of=/dev/sd*</span>, partition editors, redirects to block devices, fork bombs. Lift this only if you genuinely need them through MCP.
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
    </div>
  );
}

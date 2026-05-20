'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, Layers, Loader2, Trash2 } from 'lucide-react';

import type { StackManifest } from '@/lib/template/stackContract';
import type { StackHealth, ChildHealthState } from '@servicebay/api-client';
import { useToast } from '@/providers/ToastProvider';

/**
 * Stack card — reusable detail view for a single stack (#634).
 *
 * Shows manifest annotations + per-child health + the wipe action
 * (lifecycle=wipeable only). Atomic-wipe stacks (the core stack)
 * surface a hint pointing at Settings → System → Factory Reset
 * instead of letting the operator click a destructive button on the
 * primary card.
 *
 * Install action is intentionally NOT here yet — the wizard rewrite
 * (Phase 5B follow-up) owns the variable-collection UX before install
 * can fire from a card. For now, cards exist on Settings → Stacks for
 * post-install management.
 */

interface StackCardProps {
  name: string;
  manifest: StackManifest | null;
  health: StackHealth | null;
  onWiped?: () => void;
}

function statusIcon(state: ChildHealthState) {
  if (state === 'ready') {
    return <CheckCircle2 size={14} className="text-green-600 dark:text-green-400" aria-label="ready" />;
  }
  if (state === 'unhealthy') {
    return <AlertTriangle size={14} className="text-red-600 dark:text-red-400" aria-label="unhealthy" />;
  }
  return <HelpCircle size={14} className="text-gray-400 dark:text-gray-500" aria-label="unknown" />;
}

function overallBadge(health: StackHealth | null) {
  if (!health) {
    return <span className="text-xs text-gray-500 dark:text-gray-400">No health yet</span>;
  }
  if (health.ready) {
    return <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 font-medium">Healthy</span>;
  }
  if (!health.hasAnySignal) {
    return <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 font-medium">Not installed</span>;
  }
  return <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 font-medium">Degraded</span>;
}

export default function StackCard({ name, manifest, health, onWiped }: StackCardProps) {
  const { addToast } = useToast();
  const [confirmInput, setConfirmInput] = useState('');
  const [running, setRunning] = useState(false);

  if (!manifest) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-center gap-2 text-gray-600 dark:text-gray-300">
          <Layers size={16} />
          <span className="font-medium">{name}</span>
        </div>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          README-only stack — no <code>stack.yml</code> yet.
        </p>
      </div>
    );
  }

  const wipeable = manifest.lifecycle === 'wipeable';
  const expected = `WIPE-${name}`;
  const canWipe = wipeable && confirmInput === expected && !running;

  const wipe = async () => {
    if (!canWipe) return;
    setRunning(true);
    try {
      const res = await fetch(`/api/system/stacks/${encodeURIComponent(name)}/wipe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: expected }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
      const failed = (data.failed ?? []).length;
      const handlerFails = (data.capabilityFailures ?? []).length;
      addToast(
        failed + handlerFails === 0 ? 'success' : 'info',
        `Wiped ${name}`,
        `Removed ${data.deleted?.length ?? 0} service${data.deleted?.length === 1 ? '' : 's'}` +
          (failed > 0 ? ` (${failed} failed)` : '') +
          (handlerFails > 0 ? `; ${handlerFails} cross-service cleanup issue${handlerFails === 1 ? '' : 's'}` : ''),
      );
      setConfirmInput('');
      onWiped?.();
    } catch (e) {
      addToast('error', `Wipe failed`, e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center gap-3">
        <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg text-blue-600 dark:text-blue-400">
          <Layers size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <h3 className="font-bold text-gray-900 dark:text-white">{manifest.label}</h3>
            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 font-medium">
              {manifest.tier}
            </span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {manifest.templates.length} template{manifest.templates.length === 1 ? '' : 's'}: {manifest.templates.join(', ')}
          </p>
        </div>
        <div className="shrink-0">{overallBadge(health)}</div>
      </div>

      <div className="p-4 space-y-3">
        {health && (
          <ul className="text-sm space-y-1">
            {manifest.templates.map(t => (
              <li key={t} className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                {statusIcon(health.children[t])}
                <code className="font-mono text-xs">{t}</code>
                <span className="text-xs text-gray-400 dark:text-gray-500">{health.children[t]}</span>
              </li>
            ))}
          </ul>
        )}

        {wipeable && (
          <div className="pt-3 border-t border-gray-100 dark:border-gray-700 space-y-2">
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Wipe removes every template in this stack: stops the units, deletes their data, and clears the cross-service registrations (Authelia OIDC client, NPM proxy host, AdGuard rewrite, credentials manifest).
            </p>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
              Type <span className="font-mono text-red-600 dark:text-red-400">{expected}</span> to confirm:
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={confirmInput}
                onChange={e => setConfirmInput(e.target.value)}
                disabled={running}
                placeholder={expected}
                autoComplete="off"
                spellCheck={false}
                className="flex-1 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-white font-mono text-xs focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={wipe}
                disabled={!canWipe}
                className="px-3 py-1 bg-red-600 text-white rounded text-xs font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
              >
                {running ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                {running ? 'Wiping…' : 'Wipe'}
              </button>
            </div>
          </div>
        )}

        {!wipeable && (
          <p className="pt-3 border-t border-gray-100 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
            This stack is atomic-wipe — use <strong>Settings → System → Factory Reset</strong> if you need to remove it.
          </p>
        )}
      </div>
    </div>
  );
}

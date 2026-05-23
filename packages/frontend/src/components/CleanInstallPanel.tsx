'use client';

import { useEffect, useState, useRef } from 'react';
import { AlertTriangle, ShieldCheck, Trash2, ShieldAlert } from 'lucide-react';

/**
 * "Clean install" wizard panel with per-group preserve checkboxes
 * (#568 transparency rework). Replaces the old binary
 * Preserve-data / Clean-install radio with a granular control so the
 * operator picks *what* a wipe actually deletes.
 *
 * The four groups + their defaults mirror `src/lib/install/resetGroups`
 * on the backend; we fetch the runtime sizes from
 * `/api/system/stacks/reset/info` so the wipe panel shows "Service
 * data (4.7 GB)" instead of an abstract checkbox the operator can't
 * size up before clicking RESET.
 *
 * State contract:
 *   - `cleanInstall = false` → outer install runs without a wipe.
 *     `preserve` value is irrelevant.
 *   - `cleanInstall = true` + `preserve = undefined` → API default
 *     (keep secrets/certs/identity, wipe service-data).
 *   - `cleanInstall = true` + `preserve = [<ids>]` → explicit choices.
 *     Empty array `[]` means factory reset (wipe everything).
 */

type GroupInfo = {
  id: 'secrets' | 'certs' | 'identity' | 'service-data' | 'quadlet-backup';
  label: string;
  description: string;
  paths: string[];
  bytes: number | null;
  exists: boolean;
  /** When true the group ignores the preserve list — UI renders a
   *  disabled checkbox with an "always wiped" badge so the operator
   *  sees the size but cannot toggle it. */
  alwaysWipe?: boolean;
};

type InfoResponse = {
  node: string;
  groups: GroupInfo[];
  /** Existing NPM proxy hosts, tagged with the reset-group whose wipe
   *  would orphan them. Empty when nothing's installed yet. */
  proxyHosts?: Array<{ domain: string; service: string; group: GroupInfo['id'] }>;
};

const DEFAULT_KEPT: GroupInfo['id'][] = ['secrets', 'certs', 'identity'];

function formatBytes(n: number | null): string {
  if (n === null) return 'size unknown';
  if (n === 0) return 'empty';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export default function CleanInstallPanel({
  cleanInstall,
  setCleanInstall,
  cleanInstallConfirm,
  setCleanInstallConfirm,
  preserve,
  setPreserve,
  node,
}: {
  cleanInstall: boolean;
  setCleanInstall: (b: boolean) => void;
  cleanInstallConfirm: string;
  setCleanInstallConfirm: (s: string) => void;
  preserve: string[] | undefined;
  setPreserve: (p: string[] | undefined) => void;
  node?: string;
}) {
  const [info, setInfo] = useState<InfoResponse | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const isValidCombo = validationErrors.length === 0;
  const validateAbort = useRef<AbortController | null>(null);

  // Fetch group sizes whenever the panel is expanded. Avoid hammering
  // the endpoint when the panel is collapsed — `du -sb` walks the
  // whole tree which can take a few hundred ms on a deep service-data
  // dir. Refetch when `node` changes so multi-node setups show the
  // right numbers.
  useEffect(() => {
    if (!cleanInstall) return;
    let cancelled = false;
    const qs = node ? `?node=${encodeURIComponent(node)}` : '';
    fetch(`/api/system/stacks/reset/info${qs}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: InfoResponse) => {
        if (cancelled) return;
        setInfo(d);
        setInfoError(null);
      })
      .catch(e => { if (!cancelled) setInfoError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [cleanInstall, node]);

  // Validate preserve combo on every checkbox change (#847 / ARCH-16b).
  // Debounced with an AbortController so rapid toggles don't queue up
  // stale responses. Validation errors are cleared in the checkbox
  // onChange handler (not here) to avoid the set-state-in-effect lint.
  useEffect(() => {
    if (!cleanInstall) return;
    validateAbort.current?.abort();
    const controller = new AbortController();
    validateAbort.current = controller;

    const effectivePreserveList = preserve ?? DEFAULT_KEPT;
    fetch('/api/system/stacks/reset/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preserve: effectivePreserveList, node }),
      signal: controller.signal,
    })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: { valid: boolean; errors: string[] }) => {
        if (!controller.signal.aborted) {
          setValidationErrors(d.errors);
        }
      })
      .catch(e => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (!controller.signal.aborted) setValidationErrors([]);
      });

    return () => { controller.abort(); };
  }, [cleanInstall, preserve, node]);

  // Source of truth for which groups are kept right now. When the
  // operator hasn't touched anything, `preserve === undefined` and we
  // show the safe defaults. Toggling a checkbox materialises the
  // array so we know the operator made an intentional choice.
  const effectivePreserve = preserve ?? DEFAULT_KEPT;
  // alwaysWipe groups are never "kept" regardless of preserve[] — the
  // backend strips them too, this just keeps the UI consistent.
  const isKept = (g: GroupInfo) => !g.alwaysWipe && effectivePreserve.includes(g.id);
  const toggleKept = (id: GroupInfo['id']) => {
    const cur = preserve ?? [...DEFAULT_KEPT];
    setPreserve(cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);
  };

  const willWipe = info?.groups.filter(g => !isKept(g) && g.exists) ?? [];
  const willKeep = info?.groups.filter(g => isKept(g) && g.exists) ?? [];
  const totalWipeBytes = willWipe.reduce<number | null>(
    (acc, g) => acc === null || g.bytes === null ? null : acc + g.bytes,
    0,
  );

  return (
    <div className="border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3">
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={cleanInstall}
          onChange={(e) => {
            setCleanInstall(e.target.checked);
            if (!e.target.checked) {
              setCleanInstallConfirm('');
              setPreserve(undefined);
              setValidationErrors([]);
            }
          }}
          className="mt-0.5"
        />
        <div className="text-sm text-amber-900 dark:text-amber-100">
          <strong>Clean install</strong> — wipe selected groups before installing.
          <p className="text-xs text-amber-800 dark:text-amber-200/80 mt-1">
            Defaults keep system-critical data (secrets, certs, identity) and wipe only service payload. Override per group below. ServiceBay itself is never touched.
          </p>
        </div>
      </label>

      {cleanInstall && (
        <div className="mt-3 pt-3 border-t border-amber-300 dark:border-amber-700 space-y-3">
          {infoError && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Could not load group sizes ({infoError}) — checkboxes still work, just no bytes shown.
            </p>
          )}

          <div className="space-y-1.5">
            {(info?.groups ?? [
              { id: 'secrets', label: 'ServiceBay secrets + config', description: 'Encryption keys, AUTH_SECRET, config.json, cert-archive', paths: [], bytes: null, exists: true },
              { id: 'certs', label: "NPM proxy + Let's Encrypt certs", description: 'Reverse-proxy config + issued LE certificates', paths: [], bytes: null, exists: true },
              { id: 'identity', label: 'Identity provider (Authelia + LLDAP)', description: 'User accounts, groups, OIDC clients, session cookies', paths: [], bytes: null, exists: true },
              { id: 'service-data', label: 'Service data', description: 'Photos, HA, media, files, vault, …', paths: [], bytes: null, exists: true },
              { id: 'quadlet-backup', label: 'Quadlet unit backup', description: 'Snapshot of systemd Quadlet units regenerated by setup-raid on next boot', paths: [], bytes: null, exists: true, alwaysWipe: true },
            ] as GroupInfo[]).map(g => {
              const kept = isKept(g);
              const missing = !g.exists;
              const locked = !!g.alwaysWipe;
              const disabled = missing || locked;
              // Visual state: missing > locked > kept > wipe. Locked
              // rows look like wipe (red) because that's what they do,
              // just with a disabled checkbox + badge.
              const borderClass = missing
                ? 'opacity-50 border-amber-200 dark:border-amber-800'
                : kept
                  ? 'cursor-pointer border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/10 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
                  : locked
                    ? 'border-red-300 dark:border-red-700 bg-red-50/40 dark:bg-red-900/5'
                    : 'cursor-pointer border-red-300 dark:border-red-700 bg-red-50/60 dark:bg-red-900/10 hover:bg-red-50 dark:hover:bg-red-900/20';
              return (
                <label
                  key={g.id}
                  className={`flex items-start gap-2 p-2 rounded border ${borderClass}`}
                >
                  <input
                    type="checkbox"
                    checked={kept}
                    disabled={disabled}
                    onChange={() => toggleKept(g.id)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-amber-900 dark:text-amber-100">
                      {kept ? <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Trash2 className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />}
                      <span>{kept ? 'Keep' : 'Wipe'} — {g.label}</span>
                      {locked && (
                        <span className="text-[9px] uppercase tracking-wide font-semibold text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-900/40 px-1.5 py-0.5 rounded">
                          always wiped
                        </span>
                      )}
                      <span className="ml-auto text-[10px] text-amber-700 dark:text-amber-300 font-mono">{g.exists ? formatBytes(g.bytes) : 'not present'}</span>
                    </div>
                    <p className="text-[11px] text-amber-800/80 dark:text-amber-200/70 leading-snug mt-0.5">
                      {g.description}
                    </p>
                  </div>
                </label>
              );
            })}
          </div>

          {willWipe.length > 0 && (
            <div className="text-xs text-amber-900 dark:text-amber-100 flex items-start gap-1.5 p-2 rounded bg-amber-100/60 dark:bg-amber-900/30">
              <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
              <span>
                Will wipe <strong>{formatBytes(totalWipeBytes)}</strong> across <strong>{willWipe.length}</strong> group{willWipe.length === 1 ? '' : 's'}
                {willKeep.length > 0 && <>, keeping {willKeep.length} group{willKeep.length === 1 ? '' : 's'}</>}.
                This is irreversible.
              </span>
            </div>
          )}

          {/* Stale proxy-route preview (#667 — S8). For every NPM
              proxy host whose backing service is in a group that's
              about to be wiped, show it so the operator knows what
              they'll need to clean up post-install (or re-deploy
              instead). Pure preview — operator decides. */}
          {(() => {
            const stale = (info?.proxyHosts ?? []).filter(h => !effectivePreserve.includes(h.group));
            if (stale.length === 0) return null;
            return (
              <div className="text-xs flex items-start gap-1.5 p-2 rounded bg-orange-100/70 dark:bg-orange-900/30 border border-orange-300 dark:border-orange-700">
                <AlertTriangle className="w-4 h-4 text-orange-700 dark:text-orange-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="font-medium text-orange-900 dark:text-orange-100">
                    {stale.length} proxy route{stale.length === 1 ? '' : 's'} will become dangling
                  </div>
                  <div className="text-orange-800 dark:text-orange-200/90 mt-0.5">
                    {stale.slice(0, 5).map(h => (
                      <div key={h.domain} className="font-mono">{h.domain} <span className="opacity-70">({h.service})</span></div>
                    ))}
                    {stale.length > 5 && <div className="opacity-70">… and {stale.length - 5} more</div>}
                  </div>
                  <div className="text-orange-800/80 dark:text-orange-200/70 mt-1">
                    Fix after install via the diagnose page (Delete route) or re-deploy these services from the library.
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Validation errors (#847 / ARCH-16b) */}
          {!isValidCombo && (
            <div className="text-xs flex items-start gap-1.5 p-2 rounded bg-red-100/80 dark:bg-red-900/30 border border-red-400 dark:border-red-600">
              <ShieldAlert className="w-4 h-4 text-red-700 dark:text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-semibold text-red-900 dark:text-red-100 mb-1">
                  Unsafe combination — reset blocked
                </div>
                {validationErrors.map((err, i) => (
                  <p key={i} className="text-red-800 dark:text-red-200/90 leading-snug mt-0.5">
                    {err}
                  </p>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="text-xs font-medium block mb-1 text-amber-900 dark:text-amber-100">
              Type <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">RESET</code> to confirm:
            </label>
            <input
              type="text"
              value={cleanInstallConfirm}
              onChange={(e) => setCleanInstallConfirm(e.target.value)}
              disabled={!isValidCombo}
              className={`w-full px-2 py-1 border rounded text-sm ${
                isValidCombo
                  ? 'border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-900'
                  : 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 cursor-not-allowed opacity-60'
              }`}
              placeholder={isValidCombo ? 'RESET' : 'Fix the unsafe combination above first'}
              autoComplete="off"
            />
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, ShieldCheck, Trash2 } from 'lucide-react';

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
  id: 'secrets' | 'certs' | 'identity' | 'service-data';
  label: string;
  description: string;
  paths: string[];
  bytes: number | null;
  exists: boolean;
};

type InfoResponse = { node: string; groups: GroupInfo[] };

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

  // Source of truth for which groups are kept right now. When the
  // operator hasn't touched anything, `preserve === undefined` and we
  // show the safe defaults. Toggling a checkbox materialises the
  // array so we know the operator made an intentional choice.
  const effectivePreserve = preserve ?? DEFAULT_KEPT;
  const isKept = (id: GroupInfo['id']) => effectivePreserve.includes(id);
  const toggleKept = (id: GroupInfo['id']) => {
    const cur = preserve ?? [...DEFAULT_KEPT];
    setPreserve(cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);
  };

  const willWipe = info?.groups.filter(g => !isKept(g.id) && g.exists) ?? [];
  const willKeep = info?.groups.filter(g => isKept(g.id) && g.exists) ?? [];
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
            ] as GroupInfo[]).map(g => {
              const kept = isKept(g.id);
              const disabled = !g.exists;
              return (
                <label
                  key={g.id}
                  className={`flex items-start gap-2 p-2 rounded border ${
                    disabled
                      ? 'opacity-50 border-amber-200 dark:border-amber-800'
                      : kept
                        ? 'cursor-pointer border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/10 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
                        : 'cursor-pointer border-red-300 dark:border-red-700 bg-red-50/60 dark:bg-red-900/10 hover:bg-red-50 dark:hover:bg-red-900/20'
                  }`}
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

          <div>
            <label className="text-xs font-medium block mb-1 text-amber-900 dark:text-amber-100">
              Type <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">RESET</code> to confirm:
            </label>
            <input
              type="text"
              value={cleanInstallConfirm}
              onChange={(e) => setCleanInstallConfirm(e.target.value)}
              className="w-full px-2 py-1 border border-amber-300 dark:border-amber-700 rounded text-sm bg-white dark:bg-gray-900"
              placeholder="RESET"
              autoComplete="off"
            />
          </div>
        </div>
      )}
    </div>
  );
}

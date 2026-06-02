'use client';

/**
 * UI surface for the shared `useStackInstall` engine.
 *
 * Exposed as three sibling components plus a convenience default that
 * dispatches by `controller.phase`:
 *
 *   - `<StackInstallConfigureForm>` — configure phase: optional node
 *     selector, variable form (delegates to the shared
 *     `<StackVariableField>` for the type dispatch).
 *   - `<StackInstallProgress>`       — installing / done phase: log
 *     panel with auto-scroll + the NPM-credentials prompt when the
 *     proxy step asks for them.
 *   - `<StackInstallSummary>`        — done phase: credentials banner
 *     with Bitwarden-CSV download.
 *
 * The default export wires all three together; modal uses it as-is.
 * The wizard imports the siblings directly because its configure step
 * has consumer-specific tab UI that doesn't share with the modal.
 *
 * See useStackInstall.ts for the state machine, and #341 for the
 * consolidation history.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCcw, XCircle, ChevronDown, ChevronRight, CheckCircle2, Circle } from 'lucide-react';
import type { StackItem } from '@/hooks/useStackInstall';
import StackVariableField from './StackVariableField';
import { groupVariablesByTemplate } from '@servicebay/api-client';
import { buildBitwardenCsv } from '@servicebay/api-client';
import type { UseStackInstallReturn } from '@/hooks/useStackInstall';

interface DeviceContext {
  deviceOptions: Record<string, string[]>;
  loadingDevices: boolean;
  canRefresh: boolean;
  onRefresh: (devicePath: string) => void;
}

interface CommonProps {
  controller: UseStackInstallReturn;
  /** Tailwind class applied to every <StackVariableField> input. The wizard
   *  and modal pass slightly different shapes so the visual rhythm of each
   *  consumer stays unchanged. */
  inputClassName?: string;
}

interface ConfigureFormProps extends CommonProps {
  /** Cluster nodes available to deploy on. Pass `[]` to hide the picker
   *  (single-node deployments don't need it). */
  nodes?: { Name: string; URI: string }[];
  selectedNode?: string;
  onSelectNode?: (name: string) => void;
  deviceContext?: DeviceContext;
  /** Rendered above the variable form. Wizard uses this for its tab
   *  strip; modal omits it. */
  beforeVariables?: React.ReactNode;
  /** Rendered below the variable form. */
  afterVariables?: React.ReactNode;
}

export function StackInstallConfigureForm({
  controller,
  inputClassName,
  nodes,
  selectedNode,
  onSelectNode,
  deviceContext,
  beforeVariables,
  afterVariables,
}: ConfigureFormProps) {
  const { variables, setVariableValue, setVariableExposure } = controller;
  const groups = groupVariablesByTemplate(variables).filter(g => g.key !== '_global');
  const publicDomain = variables.find(v => v.name === 'PUBLIC_DOMAIN')?.value;

  return (
    <div className="space-y-4">
      {nodes && nodes.length > 1 && (
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 uppercase mb-1">Target Node</label>
          <select
            value={selectedNode ?? ''}
            onChange={(e) => onSelectNode?.(e.target.value)}
            className={inputClassName ?? 'w-full p-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded'}
          >
            <option value="" disabled>Select a node</option>
            {nodes.map(n => (
              <option key={n.Name} value={n.Name}>{n.Name} ({n.URI})</option>
            ))}
          </select>
        </div>
      )}

      {beforeVariables}

      {variables.length === 0 ? (
        <div className="p-4 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 rounded">
          No variables found. You can proceed.
        </div>
      ) : (
        <div className="space-y-4">
          {variables.filter(v => v.global).length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">From Settings</p>
              <div className="grid gap-2">
                {variables.filter(v => v.global).map(v => (
                  <div key={v.name} className="flex items-center gap-3 p-2 bg-gray-50 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">
                    <span className="text-sm font-medium text-gray-500 dark:text-gray-400 min-w-[100px]">{v.name}</span>
                    <span className="text-sm text-gray-700 dark:text-gray-300 font-mono">{v.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {groups.map(group => (
            <div key={group.key}>
              <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-gray-700 pb-1 mb-3">{group.label}</h4>
              <div className="grid gap-4">
                {group.variables.map(v => (
                  <div key={v.name}>
                    <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">{v.name}</label>
                    {v.meta?.description && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">{v.meta.description}</p>
                    )}
                    <StackVariableField
                      variable={v}
                      onChange={(value) => setVariableValue(v.name, value)}
                      onExposureChange={(exposure) => setVariableExposure(v.name, exposure)}
                      publicDomain={publicDomain}
                      deviceContext={deviceContext}
                      inputClassName={inputClassName}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {afterVariables}
    </div>
  );
}

interface ProgressProps extends CommonProps {
  /** Optional content rendered above the log panel — wizard uses it for
   *  the digital-twin status strip. */
  beforeLog?: React.ReactNode;
}

export function StackInstallProgress({ controller, beforeLog }: ProgressProps) {
  const { items, logs, phase, installingNow, deployedNames, npmCredPrompt, npmCredFallback, retryNpmCredentials, skipNpmCredentials, abortInstall, reset } = controller;
  const logTailRef = useRef<HTMLDivElement | null>(null);
  const [credEmail, setCredEmail] = useNpmCredFallback(npmCredFallback.email);
  const [credPassword, setCredPassword] = useNpmCredFallback(npmCredFallback.password);

  useEffect(() => {
    if (phase !== 'installing') return;
    const el = logTailRef.current;
    if (typeof el?.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [logs, phase]);

  // Bucket the flat log stream into per-service groups (#822). The
  // runner already emits `Installing <name>...` / `✅ <name> deployed`
  // markers, plus `Running <name> post-deploy script…` for post-install
  // steps — anything between an Install marker and its closing line
  // belongs to that service. Everything else stays in the "global" tail.
  //
  // Skip attribution when there are no items to render rows for (e.g.
  // the StackInstallModal path, or a controller spun up without the
  // wizard's items prefetch); a flat log is the correct fallback there.
  const { perService, globalLines } = useMemo(
    () => (items.length > 0 ? attributeLogs(logs) : { perService: new Map<string, string[]>(), globalLines: logs }),
    [items.length, logs],
  );

  return (
    <div>
      {beforeLog}

      {items.length > 0 && (
        <InstallServiceRows
          items={items}
          installingNow={installingNow}
          deployedNames={deployedNames}
          perService={perService}
        />
      )}

      <div className="bg-gray-900 text-gray-100 p-4 rounded-md font-mono text-xs min-h-[12rem] border border-gray-800">
        {globalLines.map((log, i) => (
          <div key={i} className="mb-1">{log}</div>
        ))}
        {phase === 'installing' && (
          <div className="flex items-center gap-2 text-gray-400 mt-2">
            <Loader2 size={14} className="animate-spin" /> Processing...
          </div>
        )}
        <div ref={logTailRef} />
      </div>

      {/* Abort + start-over controls. Visible-only:
          - `installing`: red Abort button (confirmed). Cancels the
            in-flight stream and stops the deploy loop.
          - `error`: amber Start over button. Resets state and returns
            the wizard to its initial step so the operator can pick
            their templates again. */}
      {phase === 'installing' && (
        <div className="mt-3 flex items-center justify-end">
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Abort the install? Already-deployed services stay running; in-flight templates may be partially applied.')) {
                abortInstall();
              }
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-red-600 text-white hover:bg-red-700"
          >
            <XCircle size={14} /> Abort install
          </button>
        </div>
      )}
      {phase === 'error' && (
        <div className="mt-3 flex items-center justify-end">
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Start over? This wipes the current install state and returns to the template catalog. Any services already deployed on the host stay running.')) {
                reset();
              }
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-amber-600 text-white hover:bg-amber-700"
          >
            <RefreshCcw size={14} /> Start over
          </button>
        </div>
      )}

      {npmCredPrompt && (
        <div className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200 mb-2">NPM admin login required</p>
          <p className="text-xs text-amber-700 dark:text-amber-300 mb-3">
            Nginx Proxy Manager rejected the password this install tried to set — usually because the data volume on this host carries an admin password from a previous install. The fields below are pre-filled with the credentials ServiceBay previously had stored (best guess for what NPM&apos;s database still accepts); the wizard&apos;s newly-generated password is <em>not</em> shown here because NPM already rejected it. Click <span className="font-semibold">Authenticate &amp; Retry</span> to try these values, replace them with whatever password you know NPM is actually using, or Skip to configure proxy routes manually later.
          </p>
          <div className="space-y-2">
            <input
              type="email"
              value={credEmail}
              onChange={(e) => setCredEmail(e.target.value)}
              className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-amber-300 dark:border-amber-700 rounded-md text-sm"
              placeholder="NPM admin email"
            />
            <input
              type="text"
              value={credPassword}
              onChange={(e) => setCredPassword(e.target.value)}
              className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-amber-300 dark:border-amber-700 rounded-md text-sm font-mono"
              placeholder="NPM admin password"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="flex gap-2">
              <button
                onClick={() => { void retryNpmCredentials(credEmail, credPassword); }}
                disabled={!credPassword}
                className="flex-1 px-3 py-2 bg-amber-600 text-white rounded-md text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
              >
                Authenticate &amp; Retry
              </button>
              <button
                onClick={skipNpmCredentials}
                className="px-3 py-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 text-sm"
              >
                Skip
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface SummaryProps extends CommonProps {
  /** Optional content rendered below the credentials banner — modal
   *  uses it for the DNS/SSL/access-restriction next-steps panels;
   *  wizard uses it for the auto-run diagnose probe summary. */
  doneFooter?: React.ReactNode;
}

export function StackInstallSummary({ controller, doneFooter }: SummaryProps) {
  const manifest = controller.credentialsManifest;
  const downloadCsv = () => {
    const blob = new Blob([buildBitwardenCsv(manifest)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `servicebay-credentials-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="mt-3 space-y-3">
      {manifest.length > 0 && (
        <div className="p-3 bg-rose-50 dark:bg-rose-900/20 rounded border border-rose-200 dark:border-rose-800 text-sm">
          <div className="flex items-center justify-between mb-2">
            <p className="font-medium text-rose-800 dark:text-rose-200">🔑 Credentials — save now</p>
            <button
              type="button"
              onClick={downloadCsv}
              className="text-xs px-2 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded"
              title="Download as Bitwarden / Vaultwarden CSV"
            >
              ⬇ Download CSV
            </button>
          </div>
          <p className="text-xs text-rose-700 dark:text-rose-300 mb-2">
            Won&apos;t be shown again. Either copy them into your password manager now or use the CSV button: Vaultwarden → Tools → Import → Bitwarden (csv).
          </p>
          <div className="space-y-1.5 font-mono text-xs">
            {manifest.filter(c => c.importance === 'critical').map(c => (
              <div key={c.service} className="border-l-2 border-rose-300 dark:border-rose-700 pl-2">
                <div className="font-sans font-medium text-rose-900 dark:text-rose-100">{c.service}</div>
                <div className="text-rose-700 dark:text-rose-300 break-all">{c.url}</div>
                <div className="text-rose-600 dark:text-rose-400">{c.username} / {c.password}</div>
              </div>
            ))}
          </div>
          {manifest.some(c => c.importance === 'system') && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-rose-700 dark:text-rose-300">System / DR secrets ({manifest.filter(c => c.importance === 'system').length})</summary>
              <div className="mt-1 space-y-1 font-mono">
                {manifest.filter(c => c.importance === 'system').map(c => (
                  <div key={c.service} className="text-rose-600 dark:text-rose-400 pl-2">
                    <span className="font-sans">{c.service}:</span> {c.password}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      {doneFooter}
    </div>
  );
}

/**
 * Convenience wrapper that picks the right sub-component for the current
 * controller phase. Modal uses this as its primary surface; wizard
 * composes the siblings directly because its configure step has tabs.
 */
export default function StackInstallFlow(props: {
  controller: UseStackInstallReturn;
  inputClassName?: string;
  nodes?: { Name: string; URI: string }[];
  selectedNode?: string;
  onSelectNode?: (name: string) => void;
  deviceContext?: DeviceContext;
  beforeVariables?: React.ReactNode;
  afterVariables?: React.ReactNode;
  beforeLog?: React.ReactNode;
  doneFooter?: React.ReactNode;
}) {
  const phase = props.controller.phase;
  if (phase === 'configure') {
    return (
      <StackInstallConfigureForm
        controller={props.controller}
        inputClassName={props.inputClassName}
        nodes={props.nodes}
        selectedNode={props.selectedNode}
        onSelectNode={props.onSelectNode}
        deviceContext={props.deviceContext}
        beforeVariables={props.beforeVariables}
        afterVariables={props.afterVariables}
      />
    );
  }
  if (phase === 'installing' || phase === 'done' || phase === 'error') {
    return (
      <>
        <StackInstallProgress
          controller={props.controller}
          inputClassName={props.inputClassName}
          beforeLog={props.beforeLog}
        />
        {phase === 'done' && (
          <StackInstallSummary
            controller={props.controller}
            inputClassName={props.inputClassName}
            doneFooter={props.doneFooter}
          />
        )}
      </>
    );
  }
  return null;
}

/**
 * Local-state helper seeded from the hook's `npmCredFallback`. After a
 * failed retry the operator's edits are preserved across the re-open
 * because the prompt component stays mounted — the hook just flips
 * `npmCredPrompt` true → false → true again with the same fallback
 * values it captured at runInstall time.
 */
function useNpmCredFallback(initial: string): [string, (v: string) => void] {
  return useState(initial);
}

/**
 * Per-service log attribution (#822). The runner emits markers around
 * every service it installs:
 *
 *   Installing <name>...
 *   …per-service stdout/stderr…
 *   ✅ <name> deployed (...)
 *   Running <name> post-deploy script…
 *   …per-service post-deploy output…
 *
 * Lines between an opener and the next service-affecting marker are
 * attributed to the named service. Anything outside any service block
 * (Install order announcement, manifest-assembly chatter, NPM prompt
 * status) stays in the global tail so nothing gets hidden.
 *
 * Exported for unit testing — the regexes are worth pinning since the
 * markers' shape is the only contract this attribution depends on.
 */
export function attributeLogs(logs: string[]): {
  perService: Map<string, string[]>;
  globalLines: string[];
} {
  const perService = new Map<string, string[]>();
  const globalLines: string[] = [];
  let currentService: string | null = null;

  const startInstall = /^Installing (\S+)\.{3}\s*$/;
  const doneInstall = /^✅ (\S+) deployed/;
  const startPostDeploy = /^Running (\S+) post-deploy script/;

  for (const line of logs) {
    const m1 = startInstall.exec(line);
    const m2 = doneInstall.exec(line);
    const m3 = startPostDeploy.exec(line);

    if (m1) {
      currentService = m1[1];
      pushToService(perService, currentService, line);
      continue;
    }
    if (m3) {
      currentService = m3[1];
      pushToService(perService, currentService, line);
      continue;
    }
    if (m2) {
      const svc = m2[1];
      pushToService(perService, svc, line);
      // Closing line; subsequent lines fall back to global until the
      // next opener.
      currentService = null;
      continue;
    }

    if (currentService) {
      pushToService(perService, currentService, line);
    } else {
      globalLines.push(line);
    }
  }

  return { perService, globalLines };
}

function pushToService(map: Map<string, string[]>, svc: string, line: string) {
  const existing = map.get(svc);
  if (existing) existing.push(line);
  else map.set(svc, [line]);
}

interface InstallServiceRowsProps {
  items: StackItem[];
  installingNow: string | null;
  deployedNames: string[];
  perService: Map<string, string[]>;
}

/**
 * Per-service expandable status rows (#822). Renders the install
 * order as a vertical list above the global log tail. Each row is
 * collapsed by default — expand to see only that service's lines.
 *
 * Order: trust `items[]` as the install order. The runner topo-sorts
 * by `servicebay.dependencies` before it emits items via job state, so
 * the array already arrives in dependency order. (Falls back to input
 * order when dependencies aren't declared.)
 */
function InstallServiceRows({ items, installingNow, deployedNames, perService }: InstallServiceRowsProps) {
  const deployedSet = useMemo(() => new Set(deployedNames), [deployedNames]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = (name: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="mb-3 border border-gray-200 dark:border-gray-800 rounded-md overflow-hidden">
      {items.map(item => {
        const isDone = deployedSet.has(item.name);
        const isInstalling = installingNow === item.name;
        const lines = perService.get(item.name) || [];
        const isOpen = expanded.has(item.name);
        const statusIcon = isDone
          ? <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />
          : isInstalling
            ? <Loader2 size={14} className="animate-spin text-blue-500 shrink-0" />
            : <Circle size={14} className="text-gray-300 dark:text-gray-600 shrink-0" />;
        const statusText = isDone ? 'Deployed' : isInstalling ? 'Installing…' : 'Pending';
        return (
          <div key={item.name} className="border-b border-gray-200 dark:border-gray-800 last:border-b-0">
            <button
              type="button"
              onClick={() => toggle(item.name)}
              className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors"
            >
              {isOpen ? <ChevronDown size={14} className="text-gray-400 shrink-0" /> : <ChevronRight size={14} className="text-gray-400 shrink-0" />}
              {statusIcon}
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100 flex-1 truncate">{item.name}</span>
              <span className={`text-xs ${isDone ? 'text-emerald-600 dark:text-emerald-400' : isInstalling ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`}>
                {statusText}
              </span>
              {lines.length > 0 && (
                <span className="text-[10px] text-gray-400 tabular-nums">{lines.length} ln</span>
              )}
            </button>
            {isOpen && (
              <div className="bg-gray-900 text-gray-100 px-3 py-2 font-mono text-[11px] max-h-48 overflow-y-auto">
                {lines.length === 0 ? (
                  <span className="text-gray-500">No log lines yet for {item.name}.</span>
                ) : (
                  lines.map((line, i) => <div key={i} className="leading-snug">{line}</div>)
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

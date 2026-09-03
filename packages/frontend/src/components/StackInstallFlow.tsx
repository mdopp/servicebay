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
 *   - `<StackInstallSummary>`        — done phase: hands the freshly
 *     generated credentials to the blocking hand-over gate (#2560).
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
import type { StackItem, StackInstallPhase } from '@/hooks/useStackInstall';
import StackVariableField from './StackVariableField';
import { groupVariablesByTemplate } from '@servicebay/api-client';
import { notifyCredentialsChanged } from '@/components/CredentialHandoverGate';
import type { UseStackInstallReturn } from '@/hooks/useStackInstall';
import { Button, Input, Select } from '@/components/ui';

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
          <label className="block text-xs font-medium text-subtle uppercase mb-1">Target Node</label>
          <Select
            value={selectedNode ?? ''}
            onChange={(e) => onSelectNode?.(e.target.value)}
            className={inputClassName ?? 'w-full p-2 border border-border bg-surface text-text rounded'}
          >
            <option value="" disabled>Select a node</option>
            {nodes.map(n => (
              <option key={n.Name} value={n.Name}>{n.Name} ({n.URI})</option>
            ))}
          </Select>
        </div>
      )}

      {beforeVariables}

      {variables.length === 0 ? (
        <div className="p-4 bg-surface text-status-ok rounded">
          No variables found. You can proceed.
        </div>
      ) : (
        <div className="space-y-4">
          {variables.filter(v => v.global).length > 0 && (
            <div>
              <p className="text-xs font-medium text-subtle uppercase tracking-wide mb-2">From Settings</p>
              <div className="grid gap-2">
                {variables.filter(v => v.global).map(v => (
                  <div key={v.name} className="flex items-center gap-3 p-2 bg-surface-2 rounded border border-border">
                    <span className="text-sm font-medium text-subtle min-w-[100px]">{v.name}</span>
                    <span className="text-sm text-text font-mono">{v.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {groups.map(group => (
            <div key={group.key}>
              <h4 className="text-sm font-semibold text-text border-b border-border pb-1 mb-3">{group.label}</h4>
              <div className="grid gap-4">
                {group.variables.map(v => (
                  <div key={v.name}>
                    <label className="block text-sm font-bold text-text mb-1">{v.name}</label>
                    {v.meta?.description && (
                      <p className="text-xs text-subtle mb-1">{v.meta.description}</p>
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

/**
 * What the progress panel reads off a controller. `useStackInstall`
 * satisfies it; so does `/setup`, which builds one straight from the
 * shared `InstallJobProvider` job (#2732) and has no local wizard state
 * to reset — hence `reset` is optional and the Start-over button is
 * only offered when it is there.
 */
export type InstallProgressController = Pick<
  UseStackInstallReturn,
  | 'items' | 'logs' | 'phase' | 'installingNow' | 'deployedNames' | 'error'
  | 'npmCredPrompt' | 'npmCredFallback' | 'npmCredError'
  | 'retryNpmCredentials' | 'skipNpmCredentials' | 'abortInstall'
> & { reset?: UseStackInstallReturn['reset'] };

interface ProgressProps {
  controller: InstallProgressController;
  /** Optional content rendered above the log panel — wizard uses it for
   *  the digital-twin status strip. */
  beforeLog?: React.ReactNode;
}

export function StackInstallProgress({ controller, beforeLog }: ProgressProps) {
  const { items, logs, phase, installingNow, deployedNames, error, npmCredPrompt, npmCredFallback, npmCredError, retryNpmCredentials, skipNpmCredentials, abortInstall, reset } = controller;
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
  const { perService, globalLines, failedServices } = useMemo(
    () => (items.length > 0
      ? attributeLogs(logs)
      : { perService: new Map<string, string[]>(), globalLines: logs, failedServices: new Set<string>() }),
    [items.length, logs],
  );

  return (
    <div>
      {beforeLog}

      <InstallOutcomeBanner items={items} phase={phase} deployedNames={deployedNames} error={error} />

      {items.length > 0 && (
        <InstallServiceRows
          items={items}
          installingNow={installingNow}
          deployedNames={deployedNames}
          perService={perService}
          failedServices={failedServices}
        />
      )}

      <div className="bg-surface-muted text-text p-4 rounded-md font-mono text-xs min-h-[12rem] border border-border">
        {globalLines.map((log, i) => (
          <div key={i} className="mb-1">{log}</div>
        ))}
        {phase === 'installing' && (
          <div className="flex items-center gap-2 text-muted mt-2">
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
          <Button
            type="button"
            onClick={() => {
              if (window.confirm('Abort the install? Already-deployed services stay running; in-flight templates may be partially applied.')) {
                abortInstall();
              }
            }}
            variant="danger"
            className="inline-flex items-center gap-1.5"
          >
            <XCircle size={14} /> Abort install
          </Button>
        </div>
      )}
      {phase === 'error' && reset && (
        <div className="mt-3 flex items-center justify-end">
          <Button
            type="button"
            onClick={() => {
              if (window.confirm('Start over? This wipes the current install state and returns to the template catalog. Any services already deployed on the host stay running.')) {
                reset();
              }
            }}
            variant="secondary"
            className="inline-flex items-center gap-1.5"
          >
            <RefreshCcw size={14} /> Start over
          </Button>
        </div>
      )}

      {npmCredPrompt && (
        <div className="mt-3 p-3 bg-surface rounded-lg border border-border">
          <p className="text-sm font-medium text-status-warn mb-2">NPM admin login required</p>
          <p className="text-xs text-status-warn mb-3">
            Nginx Proxy Manager rejected the password this install tried to set — usually because the data volume on this host carries an admin password from a previous install.{' '}
            {npmCredFallback.email || npmCredFallback.password
              ? <>The fields below are pre-filled with the credentials ServiceBay previously had stored (best guess for what NPM&apos;s database still accepts); the wizard&apos;s newly-generated password is <em>not</em> shown here because NPM already rejected it.</>
              : <>ServiceBay has no stored credentials for this host, so the fields below start empty — fill in the admin email and password NPM is actually using.</>}
            {' '}Click <span className="font-semibold">Authenticate &amp; Retry</span> to submit these values, replace them with whatever password you know NPM is actually using, or Skip to configure proxy routes manually later.
          </p>
          <div className="space-y-2">
            <Input
              type="email"
              value={credEmail}
              onChange={(e) => setCredEmail(e.target.value)}
              className="w-full px-3 py-2 bg-surface border border-border rounded-md text-sm"
              placeholder="NPM admin email"
            />
            <Input
              type="text"
              value={credPassword}
              onChange={(e) => setCredPassword(e.target.value)}
              className="w-full px-3 py-2 bg-surface border border-border rounded-md text-sm font-mono"
              placeholder="NPM admin password"
              autoComplete="off"
              spellCheck={false}
            />
            {npmCredError && (
              <p role="alert" className="text-xs font-medium text-status-fail">
                {npmCredError}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                onClick={() => { void retryNpmCredentials(credEmail, credPassword); }}
                disabled={!credPassword}
                variant="secondary"
                className="flex-1"
              >
                Authenticate &amp; Retry
              </Button>
              <Button
                onClick={skipNpmCredentials}
                variant="ghost"
              >
                Skip
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The run's outcome, in words, above the log (#2601).
 *
 * Before this, a run that stopped before `deployItem` — the migration-gate
 * abort that left two services on the reference box nine days stale — ended
 * with a green `✅ <svc>'s dependencies are healthy.` as its last visible
 * line and a finished run's buttons underneath. `controller.error` was
 * populated by the status poll and read by no component at all.
 *
 * The count it reports is deliberately over the REQUESTED services, not over
 * `deployedNames`: the latter also carries the already-installed dependency
 * satisfiers the runner skipped, so a run that rolled out nothing would
 * otherwise report sixteen deployments. Check the denominator, not the
 * return status.
 */
function InstallOutcomeBanner({
  items, phase, deployedNames, error,
}: {
  items: StackItem[];
  phase: StackInstallPhase;
  deployedNames: string[];
  error: string | null;
}) {
  const requested = items.filter(i => i.checked && !i.alreadyInstalled).map(i => i.name);
  const rolledOut = requested.filter(n => deployedNames.includes(n));
  const isTerminal = phase === 'done' || phase === 'error';
  const deployedNothing = isTerminal && requested.length > 0 && rolledOut.length === 0;
  if (phase !== 'error' && !deployedNothing) return null;

  const missing = requested.filter(n => !rolledOut.includes(n));
  return (
    <div role="alert" className="mb-3 p-3 rounded-md border border-status-fail bg-surface text-sm space-y-1">
      <p className="font-semibold text-status-fail flex items-center gap-1.5">
        <XCircle size={15} className="shrink-0" />
        {deployedNothing ? 'Nothing was deployed' : 'The install did not finish'}
      </p>
      {error && <p className="text-text break-words">{error}</p>}
      {requested.length > 0 && (
        <p className="text-subtle">
          {rolledOut.length} of {requested.length} requested service
          {requested.length === 1 ? '' : 's'} rolled out
          {rolledOut.length > 0 ? ` (${rolledOut.join(', ')})` : ''}.
          {missing.length > 0 && <> Still on the previous version: {missing.join(', ')}.</>}
        </p>
      )}
    </div>
  );
}

interface SummaryProps {
  controller: Pick<UseStackInstallReturn, 'credentialsManifest'>;
  /** Modal uses it for the DNS/SSL/access-restriction next-steps panels;
   *  wizard uses it for the auto-run diagnose probe summary; /setup for
   *  its DNS check + self-test. */
  doneFooter?: React.ReactNode;
}

/**
 * Done phase (#2560).
 *
 * This used to print every generated password on screen under "won't be
 * shown again". It doesn't any more: the hand-over is a file, exactly
 * once, and the local copy goes as soon as that file is proven delivered.
 * Reading passwords off a screen is neither of those things, and it left
 * ServiceBay's copy in place afterwards regardless.
 *
 * So all this does now is tell the gate in the dashboard layout that new
 * credentials exist. The gate takes over from there and cannot be
 * dismissed until the download has worked.
 */
export function StackInstallSummary({ controller, doneFooter }: SummaryProps) {
  const pending = controller.credentialsManifest.length;

  useEffect(() => {
    if (pending > 0) notifyCredentialsChanged();
  }, [pending]);

  return <div className="mt-3 space-y-3">{doneFooter}</div>;
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
          beforeLog={props.beforeLog}
        />
        {phase === 'done' && (
          <StackInstallSummary
            controller={props.controller}
            doneFooter={props.doneFooter}
          />
        )}
      </>
    );
  }
  return null;
}

/**
 * Local input state seeded from the hook's `npmCredFallback`.
 *
 * The fallback is *not* available at mount: this component mounts as
 * soon as the phase becomes `installing`, while the fallback only
 * arrives later on the shared install poll (`InstallJobProvider`) that
 * reports `needs_credentials`. A bare `useState(fallback)` therefore captured
 * `''` forever and the prompt rendered blank inputs under copy that
 * promised pre-filled values (#2442).
 *
 * So re-seed whenever the fallback *value* changes — React's
 * "adjust state when a prop changes" pattern, done in render so there
 * is no blank-then-filled flash. The comparison is on the string, not
 * the `npmCredFallback` object, which is deliberate: the poll hands
 * back a fresh object every 2s, and re-seeding on identity would wipe
 * a half-typed retry. Operator edits survive a failed retry for the
 * same reason — the runner re-reports the same fallback string, so
 * nothing is clobbered.
 */
function useNpmCredFallback(fallback: string): [string, (v: string) => void] {
  const [value, setValue] = useState(fallback);
  const [seededFrom, setSeededFrom] = useState(fallback);
  if (fallback !== seededFrom) {
    setSeededFrom(fallback);
    setValue(fallback);
  }
  return [value, setValue];
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
  /** Services whose block contains a `❌` line (#2601). Derived from where
   *  the line sits, not from parsing its text — the runner emits several
   *  differently-worded failures and the service name is not reliably in
   *  any of them. */
  failedServices: Set<string>;
} {
  const perService = new Map<string, string[]>();
  const globalLines: string[] = [];
  const failedServices = new Set<string>();
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

    // #2601 — a failure line is the run's OUTCOME, not per-service detail.
    // Attributing it to the open service alone buried it inside a row that
    // is collapsed by default, so the last line the operator could actually
    // see was the green "✅ <svc>'s dependencies are healthy." that came
    // before it. It goes to both places: the row (for context) and the
    // global tail (so it is on screen), and it closes the block.
    if (line.startsWith('❌')) {
      if (currentService) {
        pushToService(perService, currentService, line);
        failedServices.add(currentService);
        currentService = null;
      }
      globalLines.push(line);
      continue;
    }

    if (currentService) {
      pushToService(perService, currentService, line);
    } else {
      globalLines.push(line);
    }
  }

  return { perService, globalLines, failedServices };
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
  failedServices?: Set<string>;
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
 *
 * #2600 — the list is split by *why* an item is in it, which is the
 * distinction the flat list lost. `InstallerModal` seeds every already-
 * deployed service as an `alreadyInstalled` item so the runner's topo-sort
 * recognises pre-deployed dependency satisfiers; the runner then skips them
 * (`runner.ts`, `if (item.alreadyInstalled) … continue`). They emit no
 * `Installing X...` marker, so status inferred from the log left them on
 * "Pending" forever — sixteen rows of apparent pending work around the one
 * service actually being upgraded. They are still listed (the order carries
 * meaning on a real stack install), just behind one labelled, collapsed
 * summary row instead of sixteen fake ones.
 */
/**
 * One row's status. `Failed` is the state #2601 added — before it, a service
 * whose deploy aborted sat on the same "Pending" the untouched dependency
 * satisfiers showed, so the row that broke looked exactly like the rows that
 * were never going to move.
 */
function rowStatus(
  name: string,
  state: { failed?: Set<string>; deployed: Set<string>; installingNow: string | null },
): { icon: React.ReactNode; text: string; tone: string } {
  if (state.failed?.has(name)) {
    return { icon: <XCircle size={14} className="text-status-fail shrink-0" />, text: 'Failed', tone: 'text-status-fail' };
  }
  if (state.deployed.has(name)) {
    return { icon: <CheckCircle2 size={14} className="text-status-ok shrink-0" />, text: 'Deployed', tone: 'text-status-ok' };
  }
  if (state.installingNow === name) {
    return { icon: <Loader2 size={14} className="animate-spin text-status-info shrink-0" />, text: 'Installing…', tone: 'text-status-info' };
  }
  return { icon: <Circle size={14} className="text-text-subtle shrink-0" />, text: 'Pending', tone: 'text-subtle' };
}

function InstallServiceRows({ items, installingNow, deployedNames, perService, failedServices }: InstallServiceRowsProps) {
  const deployedSet = useMemo(() => new Set(deployedNames), [deployedNames]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [satisfiersOpen, setSatisfiersOpen] = useState(false);

  const working = items.filter(i => !i.alreadyInstalled);
  const satisfiers = items.filter(i => i.alreadyInstalled);

  const toggle = (name: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="mb-3 border border-border rounded-md overflow-hidden">
      {working.map(item => {
        const { icon: statusIcon, text: statusText, tone } = rowStatus(
          item.name,
          { failed: failedServices, deployed: deployedSet, installingNow },
        );
        const lines = perService.get(item.name) || [];
        const isOpen = expanded.has(item.name);
        return (
          <div key={item.name} className="border-b border-border last:border-b-0">
            {/* `!h-auto !px-3` forces out Button's default size="md" (h-10/px-space-4) so it
                can't win the cascade against this row's own px-3/py-2 geometry — cn() has no
                Tailwind-merge dedup, same escape hatch as ServiceMonitor.tsx's tab strip
                (box-verify 2a9decfa follow-up: this row shipped in the same #2480 batch with
                the identical unguarded Button migration, just never caught until the sibling
                fix's re-verify swept the rest of the PR). */}
            <Button
              type="button"
              onClick={() => toggle(item.name)}
              variant="ghost"
              className="!h-auto !px-3 w-full justify-start py-2 flex items-center gap-2 text-left hover:bg-surface-2 transition-colors"
            >
              {isOpen ? <ChevronDown size={14} className="text-text-subtle shrink-0" /> : <ChevronRight size={14} className="text-text-subtle shrink-0" />}
              {statusIcon}
              <span className="text-sm font-medium text-text flex-1 truncate">{item.name}</span>
              <span className={`text-xs ${tone}`}>{statusText}</span>
              {lines.length > 0 && (
                <span className="text-[10px] text-text-subtle tabular-nums">{lines.length} ln</span>
              )}
            </Button>
            {isOpen && (
              <div className="bg-surface-muted text-text px-3 py-2 font-mono text-[11px] max-h-48 overflow-y-auto">
                {lines.length === 0 ? (
                  <span className="text-subtle">No log lines yet for {item.name}.</span>
                ) : (
                  lines.map((line, i) => <div key={i} className="leading-snug">{line}</div>)
                )}
              </div>
            )}
          </div>
        );
      })}

      {satisfiers.length > 0 && (
        <div className="border-b border-border last:border-b-0">
          <Button
            type="button"
            onClick={() => setSatisfiersOpen(o => !o)}
            variant="ghost"
            className="!h-auto !px-3 w-full justify-start py-2 flex items-center gap-2 text-left hover:bg-surface-2 transition-colors"
          >
            {satisfiersOpen ? <ChevronDown size={14} className="text-text-subtle shrink-0" /> : <ChevronRight size={14} className="text-text-subtle shrink-0" />}
            <CheckCircle2 size={14} className="text-status-ok shrink-0" />
            <span className="text-sm font-medium text-text flex-1 truncate">
              {satisfiers.length} already-installed {satisfiers.length === 1 ? 'dependency' : 'dependencies'}
            </span>
            <span className="text-xs text-subtle">Not touched</span>
          </Button>
          {satisfiersOpen && (
            <div className="bg-surface-muted text-text px-3 py-2 text-[11px]">
              <p className="text-subtle mb-1">
                Listed so the install order is complete. This run does not redeploy them.
              </p>
              <ul className="font-mono leading-snug">
                {satisfiers.map(s => <li key={s.name}>{s.name}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

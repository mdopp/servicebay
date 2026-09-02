/**
 * Shared install engine used by both OnboardingWizard and InstallerModal.
 *
 * Owns the configure → start half of the state machine. The configure
 * step (`startConfigure`) is an interactive review of resolved variables;
 * `runInstall` POSTs the result to `/api/install/start`, after which the
 * server owns the deploy loop (`src/lib/install/runner.ts`) and closing
 * the browser no longer interrupts an install.
 *
 * Everything about the *running* job — phase, progress, log, the NPM
 * credentials prompt — comes from `InstallJobProvider` (#2732): one poll
 * for the whole dashboard, one cadence, one `/status → /progress` 401
 * fallback. This hook only says which job it is following (`jobId`) and
 * derives its view from the provider while the provider reports that job.
 * `attachToJob` lets a reopened tab pick up an in-flight job; the
 * credentials / skip / abort actions forward to the provider.
 */

'use client';

import { useCallback, useRef, useState } from 'react';
import type { VariableMeta } from '@servicebay/api-client';
import { type Credential } from '@servicebay/api-client';
import { useInstallJob } from '@/hooks/useInstallJob';
import { isFailedPhase } from '@/providers/InstallJobProvider';

export type StackInstallPhase = 'idle' | 'configure' | 'installing' | 'done' | 'error';

interface ConfigFile {
  filename: string;
  content: string;
  targetPath?: string;
}

export interface StackItem {
  name: string;
  checked: boolean;
  yaml?: string;
  configFiles?: ConfigFile[];
  alreadyInstalled?: boolean;
  /** Template names that must install before this one. Parsed from the
   *  `servicebay.dependencies` annotation in template.yml during
   *  startConfigure. Empty when the template has no install-time deps. */
  dependencies?: string[];
}

export interface StackVariable {
  name: string;
  value: string;
  global?: boolean;
  meta?: VariableMeta;
  /** #2574 — the operator typed or regenerated this value in the Configure
   *  step (or the caller prefilled it). Sent through to the install job so the
   *  runner's saved-secret reuse keeps it instead of silently restoring the
   *  previously saved secret — which is what made a service password
   *  unrotatable from the wizard as well as from `install_template`. */
  explicit?: boolean;
}

export interface StackItemInput {
  name: string;
  checked: boolean;
  alreadyInstalled?: boolean;
}

export interface UseStackInstallOptions {
  /** Template source passed to the backend manifest assembler
   *  (`POST /api/install/assemble`). Usually `'Built-in'` (wizard) or
   *  the registry source URL (modal). */
  templateSource: string;
  /** Free-form tag that lands on the JobState so the install-in-progress
   *  banner can show "wizard" vs "modal" to the operator. */
  source?: string;
}

export interface UseStackInstallReturn {
  phase: StackInstallPhase;
  items: StackItem[];
  variables: StackVariable[];
  logs: string[];
  installingNow: string | null;
  /**
   * Names of services the runner has already deployed in this job.
   * Driven by `JobState.progress.deployedNames` — the wizard's stack
   * status panel diffs this against the checked `items[]` to render
   * per-stack state (queued / installing / done) without parsing the
   * log (#732).
   */
  deployedNames: string[];
  credentialsManifest: Credential[];
  npmCredPrompt: boolean;
  /** Pre-fill values for the NPM-credentials prompt — usually the
   *  auto-generated values the wizard used; operator can override.
   *  Arrives with the `needs_credentials` status poll, i.e. *after* the
   *  prompt's component has mounted, so consumers must treat it as a
   *  changing value rather than a mount-time seed (#2442). */
  npmCredFallback: { email: string; password: string };
  /** Why the last `retryNpmCredentials` call could not be sent, or null.
   *  Rendered next to the prompt's inputs so a rejected submit is visible
   *  instead of a dead button (#2442). */
  npmCredError: string | null;
  error: string | null;

  /** Toggle an item's checked state (used by select-step UIs in caller). */
  setItemChecked: (name: string, checked: boolean) => void;
  setItems: (items: StackItem[]) => void;
  setVariableValue: (name: string, value: string) => void;
  /**
   * Override the exposure profile of a subdomain-typed variable. Per-
   * template defaults live in `variables.json` (`meta.exposure`); this
   * setter mutates `meta.exposure` on the live install state so the
   * proxy-hosts POST sees the operator's choice. Only meaningful for
   * subdomain variables — no-op on others.
   */
  setVariableExposure: (name: string, exposure: 'public' | 'internal' | 'lan') => void;

  /** Fetch yamls + variable metadata + configFiles for every checked
   *  item, resolve placeholders, transition to 'configure'. `prefilled`
   *  is merged into globalSettings — wizard uses it for PUBLIC_DOMAIN /
   *  NGINX_ADMIN_EMAIL captured before this step; modal passes `{}`.
   *  An install never wipes existing data (#1520): stored credential
   *  values (LLDAP / NPM password, etc.) are reused server-side so
   *  services with pre-existing data volumes keep authenticating; a
   *  full wipe is the explicit Factory Reset, not an install option. */
  startConfigure: (
    items: StackItemInput[],
    prefilled: Record<string, string>,
    options?: { node?: string },
  ) => Promise<{ items: StackItem[]; variables: StackVariable[] }>;

  /** POST the resolved items/variables to /api/install/start. The
   *  server owns the deploy loop from here on; the InstallJobProvider
   *  follows the job. The browser tab can be closed without
   *  interrupting the install. */
  runInstall: (overrides?: { items?: StackItem[]; variables?: StackVariable[]; node?: string }) => Promise<void>;

  /** Submit operator-supplied NPM credentials to resume a paused job.
   *  Backed by POST /api/install/credentials. A submit it cannot send
   *  (missing field, no job attached) sets `npmCredError` and leaves the
   *  prompt open rather than returning silently (#2442). */
  retryNpmCredentials: (email: string, password: string) => Promise<void>;

  /** Resume a paused job by skipping the NPM credentials prompt. */
  skipNpmCredentials: () => void;

  /** Append a single line to the local log buffer. Pre-install only —
   *  once a job has started, all log lines come from the server.
   *  Callers use this to prefix the log with one-shot actions like a
   *  RAID-mount notice before `runInstall` takes over. */
  appendLog: (line: string) => void;

  /** Reset local state and detach from any current job. Does NOT abort
   *  a running job server-side — call `abortInstall` first if needed. */
  reset: () => void;

  /** Abort the running install via POST /api/install/abort. The runner
   *  flips the job to phase=aborted; the provider's next poll picks
   *  that up and it shows here as `error`. */
  abortInstall: () => void;

  /** Attach to an already-running install job. Used by the wizard when
   *  it detects an in-progress job on mount (e.g. operator reopened the
   *  tab mid-install). Resolves once the provider has fetched it. */
  attachToJob: (jobId: string) => Promise<void>;

  /** Current job ID, or null when no install is being tracked.
   *  Exposed so the wizard can render the "another tab is running this
   *  install" banner with the right job context. */
  jobId: string | null;
}

// provisionPortalWithRetries lives in ./portalProvision (server-only).
// Don't re-export it here — the chain client→useStackInstall→portalProvision
// would pull AUTH_SECRET-touching code into the browser bundle.

const EMPTY_STRINGS: string[] = [];
const EMPTY_CREDENTIALS: Credential[] = [];

export function useStackInstall(options: UseStackInstallOptions): UseStackInstallReturn {
  const { templateSource, source } = options;
  const install = useInstallJob();
  // The action callbacks are stable across polls; the snapshot is not.
  const { track, abort, skipCredentials: skipJobCredentials, submitCredentials } = install;
  /** Phase before a job exists (idle / configure / a failed start). Once
   *  `jobId` matches the provider's job, the provider's phase wins. */
  const [localPhase, setLocalPhase] = useState<StackInstallPhase>('idle');
  const [items, setItems] = useState<StackItem[]>([]);
  const [variables, setVariables] = useState<StackVariable[]>([]);
  const [localLogs, setLocalLogs] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  /** Only the "no job attached" case is decided here; the provider owns
   *  the prompt itself and every other reason a submit could fail. */
  const [localCredError, setLocalCredError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  /** Latest node value. Cached in a ref so async runInstall sees fresh
   *  value if the consumer changes nodes between configure and install. */
  const nodeRef = useRef<string>('');

  const job = jobId !== null && install.job?.id === jobId ? install.job : null;

  const appendLog = useCallback((line: string) => {
    setLocalLogs(prev => [...prev, line]);
  }, []);

  const reset = useCallback(() => {
    setLocalPhase('idle');
    setItems([]);
    setVariables([]);
    setLocalLogs([]);
    setLocalError(null);
    setLocalCredError(null);
    setJobId(null);
    nodeRef.current = '';
  }, []);

  const abortInstall = useCallback(() => {
    if (!jobId) return;
    abort();
  }, [jobId, abort]);

  /** Attach to an already-running job. The wizard calls this on mount
   *  when checkOnboardingStatus reports an active install. The provider
   *  fetches the state + accumulated log so the new tab catches up
   *  immediately, then keeps it live. */
  const attachToJob = useCallback(async (id: string): Promise<void> => {
    const found = await track(id);
    if (!found) return;
    setLocalError(null);
    setLocalPhase('installing');
    setJobId(id);
  }, [track]);

  // No-op writes return the same array reference so subscribers (e.g. the
  // wizard's device-poll effect) don't see a spurious change. Pre-refactor
  // (v3.19.1) the wizard owned variables state and guarded with a
  // `changed ? next : prev` map; the v3.19.2 refactor moved state in here
  // and lost that guard, which turned the device-poll effect into a hot
  // loop during install (every appendLog re-render queued another
  // /api/system/devices fetch and saturated the browser connection pool).
  const setItemChecked = useCallback((name: string, checked: boolean) => {
    setItems(prev => {
      const i = prev.findIndex(x => x.name === name);
      if (i === -1 || prev[i].checked === checked) return prev;
      const next = prev.slice();
      next[i] = { ...next[i], checked };
      return next;
    });
  }, []);

  const setVariableValue = useCallback((name: string, value: string) => {
    setVariables(prev => {
      const i = prev.findIndex(x => x.name === name);
      if (i === -1 || prev[i].value === value) return prev;
      const next = prev.slice();
      // #2574 — mark the field as operator-supplied for this run. The install
      // runner reuses a saved secret over the manifest's value, so without
      // this flag a new password typed (or regenerated) here was silently
      // replaced by the old one and the install still reported success.
      next[i] = { ...next[i], value, explicit: true };
      return next;
    });
  }, []);

  const setVariableExposure = useCallback((name: string, exposure: 'public' | 'internal' | 'lan') => {
    setVariables(prev => {
      const i = prev.findIndex(x => x.name === name);
      if (i === -1) return prev;
      const cur = prev[i];
      if (cur.meta?.type !== 'subdomain' || cur.meta?.exposure === exposure) return prev;
      const next = prev.slice();
      next[i] = { ...cur, meta: { ...cur.meta, exposure } };
      return next;
    });
  }, []);

  const startConfigure = useCallback(async (
    inputItems: StackItemInput[],
    prefilled: Record<string, string>,
    opts?: { node?: string },
  ): Promise<{ items: StackItem[]; variables: StackVariable[] }> => {
    setLocalPhase('configure');
    setLocalError(null);
    setJobId(null);
    if (opts?.node !== undefined) nodeRef.current = opts.node;

    // Manifest assembly — variable resolution, secret / RSA / bcrypt
    // generation, config-file targetPath resolution — runs server-side
    // now (#800). The wizard's screens and flow are unchanged; it just
    // calls the backend assembler instead of building the manifest
    // itself. The same `/api/install/assemble` endpoint is what a
    // headless / ISO-driven first-boot setup uses to turn baked
    // `config.json` defaults into an installable manifest.
    try {
      const res = await fetch('/api/install/assemble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: inputItems.map(i => ({
            name: i.name,
            checked: i.checked,
            alreadyInstalled: i.alreadyInstalled,
          })),
          prefilled,
          templateSource,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
      }
      const data = await res.json() as { items?: StackItem[]; variables?: StackVariable[] };
      const newItems = data.items ?? [];
      const resolvedVars = data.variables ?? [];
      setItems(newItems);
      setVariables(resolvedVars);
      return { items: newItems, variables: resolvedVars };
    } catch (e) {
      // Callers (OnboardingWizard, InstallerModal) await this inside a
      // try/finally with no catch — surface the failure via the hook's
      // `error`/`phase` state and return empty rather than throwing.
      const msg = e instanceof Error ? e.message : String(e);
      setLocalError(`Could not prepare the install: ${msg}`);
      setLocalPhase('error');
      return { items: [], variables: [] };
    }
  }, [templateSource]);

  /** Build the JobInput payload from the wizards resolved state and POST
   *  it to /api/install/start. The server takes ownership of the deploy
   *  loop from there; the provider follows the new job. */
  const runInstall = useCallback(async (overrides?: {
    items?: StackItem[];
    variables?: StackVariable[];
    node?: string;
  }): Promise<void> => {
    if (overrides?.node !== undefined) nodeRef.current = overrides.node;
    const itemsBase = overrides?.items ?? items;
    const varsBase = overrides?.variables ?? variables;
    const node = nodeRef.current;

    setLocalError(null);
    setLocalLogs([]);
    setLocalCredError(null);
    setJobId(null);
    setLocalPhase("installing");

    const host = typeof window !== "undefined" ? window.location.hostname : "";
    const payload = {
      source: source ?? "wizard",
      input: {
        items: itemsBase.map(i => ({
          name: i.name,
          checked: i.checked,
          alreadyInstalled: i.alreadyInstalled,
          yaml: i.yaml,
          configFiles: i.configFiles,
          dependencies: i.dependencies,
        })),
        variables: varsBase.map(v => ({
          name: v.name,
          value: v.value,
          global: v.global,
          meta: v.meta,
          // #2574 — carry the operator-edited marker to the runner; dropping it
          // here would put the wizard straight back to "the new password looked
          // applied but the old one deployed".
          explicit: v.explicit,
        })),
        node: node || undefined,
        templateSource,
        host,
      },
    };

    // 30s timeout on the start POST. createJob + startJob should return
    // in milliseconds; if it hangs longer something is genuinely wrong on
    // the server and we want the wizard to surface an error instead of
    // sitting on "Processing..." forever.
    const startTimeout = AbortSignal.timeout(30_000);
    try {
      const res = await fetch("/api/install/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: startTimeout,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 409 = another install is already in progress. Attach to it
        // instead of failing — the operator probably just clicked
        // Install in two tabs.
        if (res.status === 409 && typeof data.jobId === "string") {
          await attachToJob(data.jobId);
          return;
        }
        const msg = data.error || `HTTP ${res.status}`;
        setLocalError(msg);
        setLocalPhase("error");
        return;
      }
      const newJobId = data.jobId as string;
      setJobId(newJobId);
      // Fetch it now rather than on the next tick so the first log lines
      // show up as soon as the runner writes them.
      void track(newJobId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLocalError(`Could not start install: ${msg}`);
      setLocalPhase("error");
    }
  }, [items, variables, templateSource, source, attachToJob, track]);

  const retryNpmCredentials = useCallback(async (email: string, password: string): Promise<void> => {
    if (!jobId) {
      // The provider's own bail-outs (#2442) cover the rest; this one is
      // about this hook's job, which the provider cannot know.
      setLocalCredError("This install is no longer attached to a job — start over to retry.");
      return;
    }
    setLocalCredError(null);
    await submitCredentials(email, password);
  }, [jobId, submitCredentials]);

  const skipNpmCredentials = useCallback(() => {
    if (!jobId) return;
    setLocalCredError(null);
    skipJobCredentials();
  }, [jobId, skipJobCredentials]);

  const failed = job !== null && isFailedPhase(job.phase);

  return {
    phase: job ? install.phase : localPhase,
    items,
    variables,
    logs: job ? install.logs : localLogs,
    installingNow: job?.progress?.currentItem ?? null,
    deployedNames: job?.progress?.deployedNames ?? EMPTY_STRINGS,
    credentialsManifest: job?.credentialsManifest ?? EMPTY_CREDENTIALS,
    npmCredPrompt: job !== null && install.credentials.prompt,
    npmCredFallback: install.credentials.fallback,
    npmCredError: localCredError ?? (job ? install.credentials.error : null),
    error: job ? (failed ? job.error ?? 'Install failed.' : null) : localError,
    setItemChecked,
    setItems,
    setVariableValue,
    setVariableExposure,
    startConfigure,
    runInstall,
    retryNpmCredentials,
    skipNpmCredentials,
    appendLog,
    reset,
    abortInstall,
    attachToJob,
    jobId,
  };
}

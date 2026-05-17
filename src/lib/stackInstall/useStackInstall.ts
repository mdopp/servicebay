/**
 * Shared install engine used by both OnboardingWizard and InstallerModal.
 *
 * Owns the configure → installing → done state machine. The configure
 * step (`startConfigure`) still runs entirely client-side because it's
 * an interactive review of resolved variables. The deploy loop itself
 * runs server-side via `src/lib/install/runner.ts`; this hook is the
 * thin RPC + socket-subscription client that:
 *
 *   - POSTs to `/api/install/start` when the operator confirms
 *   - polls `/api/install/status?jobId=…&logsSince=N` every 2s while
 *     the job is in a non-terminal phase, applying state + appending
 *     new log lines as they arrive
 *   - exposes `attachToJob(jobId)` so a reopened tab can pick up an
 *     in-flight job mid-install (the runner kept working server-side
 *     while the operator was away)
 *   - forwards `retryNpmCredentials` / `skipNpmCredentials` /
 *     `abortInstall` to their `/api/install/*` endpoints
 *
 * 3.25.x had a socket-subscription model here. It was racy: useSocket
 * could return `undefined` for the socket on first render, the
 * subscription effect would throw into a swallowed React error, and
 * the wizard would never receive the runner's `done` event even
 * though the install completed end-to-end. Polling sidesteps every
 * one of those failure modes.
 *
 * Closing the browser no longer interrupts an install — the runner
 * owns the deploy loop end-to-end.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { VariableMeta } from '@/lib/registry';
import {
  fetchTemplateYaml,
  fetchTemplateVariables,
  fetchTemplateConfigFiles,
  fetchStoredVariableValues,
} from '@/app/actions';
import { parseTemplateLabel } from '@/lib/templateLabel';
import { type Credential } from './credentialsManifest';
import { generateRandomSecret } from './randomSecret';
import { parseTemplateDependencies } from './dependencies';
import type { JobState as RemoteJobState } from '@/lib/install/jobStore';

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
}

export interface StackItemInput {
  name: string;
  checked: boolean;
  alreadyInstalled?: boolean;
}

export interface UseStackInstallOptions {
  /** Template source for `fetchTemplateYaml` / `fetchTemplateVariables` /
   *  `fetchTemplateConfigFiles` / `fetchTemplatePostDeployScript`.
   *  Usually `'Built-in'` (wizard) or the registry source URL (modal). */
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
  credentialsManifest: Credential[];
  npmCredPrompt: boolean;
  /** Pre-fill values for the NPM-credentials prompt — usually the
   *  auto-generated values the wizard used; operator can override. */
  npmCredFallback: { email: string; password: string };
  error: string | null;

  cleanInstall: boolean;
  cleanInstallConfirm: string;
  setCleanInstall: (b: boolean) => void;
  setCleanInstallConfirm: (s: string) => void;

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
   *  When `cleanInstall` is false, stored credential values (LLDAP
   *  password, NPM password, etc.) are used instead of generating new
   *  random secrets so that services with pre-existing data volumes
   *  continue to accept the password they were initialised with. */
  startConfigure: (
    items: StackItemInput[],
    prefilled: Record<string, string>,
    options?: { node?: string; cleanInstall?: boolean },
  ) => Promise<{ items: StackItem[]; variables: StackVariable[] }>;

  /** POST the resolved items/variables to /api/install/start. The
   *  server owns the deploy loop from here on — this hook just
   *  subscribes to socket events for live progress. The browser tab
   *  can be closed without interrupting the install. */
  runInstall: (overrides?: { items?: StackItem[]; variables?: StackVariable[]; node?: string }) => Promise<void>;

  /** Submit operator-supplied NPM credentials to resume a paused job.
   *  Backed by POST /api/install/credentials. */
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
   *  flips the job to phase=aborted; the subscription effect picks
   *  that up and reflects it in local state. */
  abortInstall: () => void;

  /** Attach to an already-running install job. Used by the wizard when
   *  it detects an in-progress job on mount (e.g. operator reopened the
   *  tab mid-install). Fetches the current state + log and subscribes
   *  to socket updates. */
  attachToJob: (jobId: string) => Promise<void>;

  /** Current job ID, or null when no install is being tracked.
   *  Exposed so the wizard can render the "another tab is running this
   *  install" banner with the right job context. */
  jobId: string | null;
}

/** Strip Mustache section tags (`{{#NAME}}` / `{{/NAME}}` / `{{^NAME}}`)
 *  so the sentinel-encoded YAML still parses. Section tokens slip past
 *  the bare `{{VAR}}` sentinel and trip js-yaml with "missed comma
 *  between flow collection entries"; the volume map then stays empty
 *  and any `.mustache` config file fails to map a hostPath. Stripping
 *  is safe because we only need the unconditional volumes/mounts to
 *  discover the config-mount hostPath. */
const MUSTACHE_SECTION_RE = /\{\{\s*[#^/]\s*[\w\d_]+\s*\}\}/g;
const MUSTACHE_VAR_RE_OUT = /\{\{\s*([\w\d_]+)\s*\}\}/g;
const SBVAR_SENTINEL_IN = /__SBVAR_([\w\d_]+)__/g;

/** Resolve config-file targetPath by parsing the YAML pod spec for
 *  volumes / volumeMounts. Mirrors the live-debugged behaviour from
 *  OnboardingWizard.handleStackFetchVars and InstallerModal
 *  .fetchYamlsAndExtractVars — see those for the war stories about
 *  the previous regex-based version (one of which silently wrote
 *  config files to `~/0/` for ~24 hours). */
async function resolveConfigFilePaths(yaml: string, cfgFiles: ConfigFile[]): Promise<void> {
  if (cfgFiles.length === 0) return;
  const safeYaml = yaml
    .replace(MUSTACHE_SECTION_RE, '')
    .replace(MUSTACHE_VAR_RE_OUT, (_m, n) => `__SBVAR_${n}__`);
  const restorePlaceholders = (s: string): string =>
    s.replace(SBVAR_SENTINEL_IN, (_m, n) => `{{${n}}}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let docs: any[] = [];
  try {
    docs = (await import('js-yaml')).loadAll(safeYaml);
  } catch {
    docs = [];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = docs.find((d: any) => d?.kind === 'Pod') ?? docs[0];
  const nameToHostPath = new Map<string, string>();
  const mountPathToHostPath = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const v of ((doc?.spec?.volumes ?? []) as any[])) {
    if (typeof v?.name === 'string' && typeof v?.hostPath?.path === 'string') {
      nameToHostPath.set(v.name, restorePlaceholders(v.hostPath.path));
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of ((doc?.spec?.containers ?? []) as any[])) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const m of ((c?.volumeMounts ?? []) as any[])) {
      if (typeof m?.mountPath === 'string' && typeof m?.name === 'string') {
        const hp = nameToHostPath.get(m.name);
        if (hp && !mountPathToHostPath.has(m.mountPath)) {
          mountPathToHostPath.set(m.mountPath, hp);
        }
      }
    }
  }
  const annotations: Record<string, string> = doc?.metadata?.annotations ?? {};
  const explicitMount = annotations['servicebay.config-mount'];
  for (const cf of cfgFiles) {
    let hp: string | undefined;
    if (explicitMount) hp = mountPathToHostPath.get(explicitMount);
    if (!hp) {
      for (const [mp, h] of mountPathToHostPath.entries()) {
        if (mp === '/config' || mp.endsWith('/config') || mp.endsWith('/conf')) {
          hp = h;
          break;
        }
      }
    }
    if (hp) cf.targetPath = `${hp}/${cf.filename}`;
  }
}

// provisionPortalWithRetries lives in ./portalProvision (server-only).
// Don't re-export it here — the chain client→useStackInstall→portalProvision
// would pull AUTH_SECRET-touching code into the browser bundle.

/** Map server-side `JobPhase` to the client-facing display phase the
 *  rest of the wizard already understands. `crashed` and `aborted` both
 *  surface as `error` so the existing Start-over UI works without
 *  branching on every distinct terminal state. */
function mapPhase(serverPhase: RemoteJobState['phase']): StackInstallPhase {
  switch (serverPhase) {
    case 'running':           return 'installing';
    case 'needs_credentials': return 'installing';
    case 'done':              return 'done';
    case 'error':             return 'error';
    case 'aborted':           return 'error';
    case 'crashed':           return 'error';
  }
}

export function useStackInstall(options: UseStackInstallOptions): UseStackInstallReturn {
  const { templateSource, source } = options;
  const [phase, setPhase] = useState<StackInstallPhase>('idle');
  const [items, setItems] = useState<StackItem[]>([]);
  const [variables, setVariables] = useState<StackVariable[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [installingNow, setInstallingNow] = useState<string | null>(null);
  const [credentialsManifest, setCredentialsManifest] = useState<Credential[]>([]);
  const [npmCredPrompt, setNpmCredPrompt] = useState(false);
  const [npmCredFallback, setNpmCredFallback] = useState<{ email: string; password: string }>({ email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [cleanInstall, setCleanInstall] = useState(false);
  const [cleanInstallConfirm, setCleanInstallConfirm] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);

  /** Latest node value. Cached in a ref so async runInstall sees fresh
   *  value if the consumer changes nodes between configure and install. */
  const nodeRef = useRef<string>('');

  /** Byte offset into the server-side log file. Bumped when /api/install/status
   *  returns log content; lets a subsequent fetch (e.g. on socket reconnect)
   *  pull only the new tail instead of replaying the entire log. */
  const logsOffsetRef = useRef<number>(0);

  /** Tracks the currently subscribed jobId in a ref so socket handlers
   *  can filter incoming events without re-binding on every state change. */
  const jobIdRef = useRef<string | null>(null);

  const appendLog = useCallback((line: string) => {
    setLogs(prev => [...prev, line]);
  }, []);

  /** Apply a server JobState snapshot to local React state. The server
   *  is the source of truth for everything except `items`/`variables`
   *  (which the client owns from startConfigure) and the few client-only
   *  state values that don't appear on the job. */
  const applyJobState = useCallback((state: RemoteJobState) => {
    setPhase(mapPhase(state.phase));
    setInstallingNow(state.progress?.currentItem ?? null);
    if (state.credentialsManifest) setCredentialsManifest(state.credentialsManifest);
    setError(state.phase === 'aborted' || state.phase === 'crashed' || state.phase === 'error'
      ? state.error ?? 'Install failed.'
      : null);
    if (state.phase === 'needs_credentials' && state.needsCredentials) {
      setNpmCredFallback(state.needsCredentials.fallback);
      setNpmCredPrompt(true);
    } else {
      setNpmCredPrompt(false);
    }
  }, []);

  const reset = useCallback(() => {
    setPhase('idle');
    setItems([]);
    setVariables([]);
    setLogs([]);
    setInstallingNow(null);
    setCredentialsManifest([]);
    setNpmCredPrompt(false);
    setNpmCredFallback({ email: '', password: '' });
    setError(null);
    setCleanInstall(false);
    setCleanInstallConfirm('');
    setJobId(null);
    jobIdRef.current = null;
    logsOffsetRef.current = 0;
    nodeRef.current = '';
  }, []);

  // Poll /api/install/status for state + new log lines while a job is
  // actively running. Replaces the socket-only subscription that was
  // here in 3.25.x — the socket approach had a race where `useSocket`
  // returned `undefined` on first render and the subscription effect
  // ran (with `socket.on` throwing into a swallowed React error) before
  // the WebSocket completed its handshake. Net effect: install ran
  // server-side end-to-end, but the wizard never received the `done`
  // event and stayed stuck on "Processing..." forever.
  //
  // Polling sidesteps that entirely:
  //   - works whether or not the socket ever connects
  //   - works after a tab reopen (no replay needed; we read from
  //     wherever the log file is now)
  //   - stops the moment phase becomes terminal (done/error/aborted/crashed)
  //   - 2s cadence is plenty — even a 5-minute install only gets
  //     ~150 polls, each <1KB. Latency on phase transitions is up to
  //     2s which is invisible inside a multi-minute pipeline.
  useEffect(() => {
    if (!jobId) return;
    jobIdRef.current = jobId;
    if (phase !== 'installing') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const url = `/api/install/status?jobId=${encodeURIComponent(jobId)}&logsSince=${logsOffsetRef.current}`;
        const res = await fetch(url);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          job: RemoteJobState | null;
          logs: string;
          logsOffset: number;
        };
        if (cancelled) return;
        if (data.logs) {
          const newLines = data.logs.split('\n').filter(l => l.length > 0);
          if (newLines.length > 0) setLogs(prev => [...prev, ...newLines]);
        }
        if (typeof data.logsOffset === 'number') {
          logsOffsetRef.current = data.logsOffset;
        }
        if (data.job) applyJobState(data.job);
      } catch { /* network blip — try again next tick */ }
    };
    void tick();
    const id = setInterval(() => { void tick(); }, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [jobId, phase, applyJobState]);

  const abortInstall = useCallback(() => {
    const id = jobIdRef.current;
    if (!id) return;
    void fetch('/api/install/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: id }),
    }).catch(() => undefined);
  }, []);

  /** Attach to an already-running job. The wizard calls this on mount
   *  when checkOnboardingStatus reports an active install. Fetches the
   *  full state + accumulated log so the new tab catches up immediately;
   *  the subscription effect then keeps it live. */
  const attachToJob = useCallback(async (id: string): Promise<void> => {
    try {
      const res = await fetch(`/api/install/status?jobId=${encodeURIComponent(id)}`);
      if (!res.ok) return;
      const data = await res.json() as {
        job: RemoteJobState | null;
        logs: string;
        logsOffset: number;
      };
      if (!data.job) return;
      // Reset log buffer to whatever the server has so far. After this,
      // socket events accumulate normally; the subscription is gated on
      // jobIdRef.current matching the incoming event's jobId.
      const initialLogs = data.logs ? data.logs.split('\n').filter(l => l.length > 0) : [];
      setLogs(initialLogs);
      logsOffsetRef.current = data.logsOffset;
      applyJobState(data.job);
      setJobId(id);
    } catch { /* best-effort attach */ }
  }, [applyJobState]);

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
      next[i] = { ...next[i], value };
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
    opts?: { node?: string; cleanInstall?: boolean },
  ): Promise<{ items: StackItem[]; variables: StackVariable[] }> => {
    setPhase('configure');
    setError(null);
    if (opts?.node !== undefined) nodeRef.current = opts.node;

    const newItems: StackItem[] = inputItems.map(i => ({
      name: i.name,
      checked: i.checked,
      alreadyInstalled: i.alreadyInstalled,
    }));
    const selected = newItems.filter(i => i.checked && !i.alreadyInstalled);
    const vars = new Set<string>();
    const allMeta: Record<string, VariableMeta> = {};

    // Global template settings (DATA_DIR + anything else the operator
    // pinned in Settings → Template Settings). Fetched once per
    // startConfigure call.
    let globalSettings: Record<string, string> = {};
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const settings = await res.json();
        globalSettings = settings.templateSettings || {};
      }
    } catch { /* empty defaults are fine */ }

    // On a non-clean reinstall, prefer stored passwords over freshly
    // generated ones. Services like LLDAP only read their admin password
    // on first DB init — a new random value would mismatch the data volume.
    let storedValues: Record<string, string> = {};
    if (!opts?.cleanInstall) {
      try { storedValues = await fetchStoredVariableValues(); } catch { /* best-effort */ }
    }

    for (const item of selected) {
      try {
        const yaml = await fetchTemplateYaml(item.name, templateSource);
        if (!yaml) continue;
        const idx = newItems.findIndex(i => i.name === item.name);
        if (idx !== -1) {
          newItems[idx].yaml = yaml;
          // Parse install-time deps from the (still un-rendered) yaml.
          // Mustache placeholders don't appear in the dependencies
          // annotation, so the raw string is fine here.
          newItems[idx].dependencies = parseTemplateDependencies(yaml);
        }

        for (const match of yaml.matchAll(MUSTACHE_VAR_RE_OUT)) vars.add(match[1]);

        const meta = await fetchTemplateVariables(item.name, templateSource);
        const templateLabel = parseTemplateLabel(yaml);
        if (meta) {
          // First template that declares a variable owns it for grouping
          // (shared vars like LLDAP_HOST live under the originator).
          for (const [key, value] of Object.entries(meta)) {
            if (!allMeta[key]) {
              allMeta[key] = { ...value, templateName: item.name, templateLabel };
            }
          }
        }

        const cfgFiles = await fetchTemplateConfigFiles(item.name, templateSource);
        if (cfgFiles.length > 0) {
          await resolveConfigFilePaths(yaml, cfgFiles);
          for (const cf of cfgFiles) {
            for (const m of cf.content.matchAll(MUSTACHE_VAR_RE_OUT)) vars.add(m[1]);
          }
          if (idx !== -1) newItems[idx].configFiles = cfgFiles;
        }
      } catch { /* skip — install loop will surface a clearer error if a deploy fails */ }
    }

    // Include variables declared via metadata but not referenced in YAML
    // (e.g. subdomain vars used only for proxy configuration).
    for (const key of Object.keys(allMeta)) vars.add(key);

    const resolvedVars: StackVariable[] = Array.from(vars).map(name => {
      const meta = allMeta[name];
      // Caller-provided prefills (PUBLIC_DOMAIN, NGINX_ADMIN_EMAIL, ...)
      // win over Settings; LLDAP_HOST is always 'localhost' because every
      // template assumes the auth pod is reachable via the local stack.
      let value = '';
      let isGlobal = false;
      if (Object.prototype.hasOwnProperty.call(prefilled, name) && prefilled[name]) {
        value = prefilled[name];
        isGlobal = true;
      } else if (globalSettings[name]) {
        value = globalSettings[name];
        isGlobal = true;
      }
      if (name === 'LLDAP_HOST') { value = 'localhost'; isGlobal = true; }
      if (!value && meta?.default) value = meta.default;
      if (!value && meta?.type === 'secret') {
        // On a reinstall without RESET, use the stored value if available so
        // services with existing data volumes keep the password they know.
        value = storedValues[name] ?? generateRandomSecret();
      }
      return { name, value, global: isGlobal, meta };
    });

    // RSA private keys — server-generated, PEM pre-indented for YAML block scalars.
    await Promise.all(resolvedVars.map(async v => {
      if (v.value || v.meta?.type !== 'rsa-private') return;
      try {
        const res = await fetch('/api/system/keys/rsa');
        if (res.ok) {
          const data = await res.json();
          if (typeof data.pem === 'string') {
            v.value = data.pem.trimEnd().split('\n').map((l: string) => '          ' + l).join('\n');
          }
        }
      } catch { /* install will fail with a clearer error if it matters */ }
    }));

    // Bcrypt hashes derive from another variable's plaintext. Runs after
    // the secret pass so the source value is already populated.
    await Promise.all(resolvedVars.map(async v => {
      if (v.value || v.meta?.type !== 'bcrypt') return;
      const sourceName = v.meta?.bcryptSource;
      if (!sourceName) return;
      const source = resolvedVars.find(x => x.name === sourceName);
      if (!source?.value) return;
      try {
        const res = await fetch('/api/system/keys/bcrypt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: source.value }),
        });
        if (res.ok) {
          const data = await res.json();
          if (typeof data.hash === 'string') v.value = data.hash;
        }
      } catch { /* leave empty */ }
    }));

    // VAULTWARDEN_DOMAIN derives from SUBDOMAIN + PUBLIC_DOMAIN.
    const pubDomain = resolvedVars.find(v => v.name === 'PUBLIC_DOMAIN')?.value;
    const vwSub = resolvedVars.find(v => v.name === 'VAULTWARDEN_SUBDOMAIN')?.value;
    if (pubDomain && vwSub) {
      const vwDomain = resolvedVars.find(v => v.name === 'VAULTWARDEN_DOMAIN');
      if (vwDomain) {
        vwDomain.value = `https://${vwSub}.${pubDomain}`;
        vwDomain.global = true;
      }
    }

    setItems(newItems);
    setVariables(resolvedVars);
    return { items: newItems, variables: resolvedVars };
  }, [templateSource]);

  /** Build the JobInput payload from the wizards resolved state and POST
   *  it to /api/install/start. The server takes ownership of the deploy
   *  loop from there; the subscription effect above keeps local state in
   *  sync via socket events. */
  const runInstall = useCallback(async (overrides?: {
    items?: StackItem[];
    variables?: StackVariable[];
    node?: string;
  }): Promise<void> => {
    if (overrides?.node !== undefined) nodeRef.current = overrides.node;
    const itemsBase = overrides?.items ?? items;
    const varsBase = overrides?.variables ?? variables;
    const node = nodeRef.current;

    setError(null);
    setLogs([]);
    setNpmCredPrompt(false);
    setCredentialsManifest([]);
    setPhase("installing");

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
        })),
        node: node || undefined,
        cleanInstall,
        cleanInstallConfirm,
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
        setError(msg);
        setPhase("error");
        return;
      }
      const newJobId = data.jobId as string;
      logsOffsetRef.current = 0;
      setJobId(newJobId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Could not start install: ${msg}`);
      setPhase("error");
    }
  }, [items, variables, cleanInstall, cleanInstallConfirm, templateSource, source, attachToJob]);

  const retryNpmCredentials = useCallback(async (email: string, password: string): Promise<void> => {
    if (!email || !password) return;
    const id = jobIdRef.current;
    if (!id) return;
    setNpmCredPrompt(false);
    try {
      await fetch("/api/install/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: id, email, password }),
      });
    } catch {
      // Re-show the prompt so the operator can retry. The runner stays
      // paused on the in-memory promise; nothing has been committed.
      setNpmCredPrompt(true);
    }
  }, []);

  const skipNpmCredentials = useCallback(() => {
    const id = jobIdRef.current;
    if (!id) return;
    setNpmCredPrompt(false);
    void fetch("/api/install/skip-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: id }),
    }).catch(() => undefined);
  }, []);


  return {
    phase,
    items,
    variables,
    logs,
    installingNow,
    credentialsManifest,
    npmCredPrompt,
    npmCredFallback,
    error,
    cleanInstall,
    cleanInstallConfirm,
    setCleanInstall,
    setCleanInstallConfirm,
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

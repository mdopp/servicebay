/**
 * Shared install engine used by both OnboardingWizard and InstallerModal.
 *
 * Owns the configure → installing → done state machine that used to live
 * in (almost) duplicate form in `OnboardingWizard.handleStackFetchVars /
 * handleStackInstall / handleNpmCredentialSubmit` and
 * `InstallerModal.fetchYamlsAndExtractVars / handleInstall /
 * registerOidcClients`. Both call sites kept drifting — auto-fill rules,
 * Mustache section-tag handling, post-deploy.py support, OIDC client
 * registration — and bugs landed in one path but not the other. Funnelling
 * everything through this hook means there's one place to fix the next
 * one, and both UIs benefit at once.
 *
 * Streaming-only by design — both consumers now use
 * `POST /api/services?stream=1`. The InstallerModal previously did
 * sequential non-streaming POSTs; that path is gone (see #341 phase-2
 * decisions section).
 *
 * State surface is intentionally callback-light: phase transitions are
 * driven by the hook calling its own state setters; consumers read
 * `phase` and react to the values exposed in the returned object. The
 * one optional callback (`onBeforeDone`) exists so the wizard can run
 * its digital-twin settle-wait between "deploys finished" and the UI
 * showing the Done banner.
 */

'use client';

import { useCallback, useRef, useState } from 'react';
import Mustache from 'mustache';
import type { VariableMeta } from '@/lib/registry';
import {
  fetchTemplateYaml,
  fetchTemplateVariables,
  fetchTemplateConfigFiles,
  fetchTemplatePostDeployScript,
} from '@/app/actions';
import { parseTemplateLabel } from '@/lib/templateLabel';
import {
  runPostInstall,
  configureProxyRoutes,
} from './postInstall';
import { buildCredentialsManifest, type Credential } from './credentialsManifest';
import { generateRandomSecret } from './randomSecret';

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
  /**
   * Optional async step run after deploys + runPostInstall + OIDC client
   * registration succeed, but BEFORE the phase transitions to 'done'.
   * The wizard uses it for the digital-twin settle-wait that polls until
   * each deployed service reports active. Returning lets the hook move on;
   * throwing is swallowed (settling is informational, not a gate).
   */
  onBeforeDone?: (deployed: { name: string }[], appendLog: (msg: string) => void) => Promise<void>;
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

  /** Fetch yamls + variable metadata + configFiles for every checked
   *  item, resolve placeholders, transition to 'configure'. `prefilled`
   *  is merged into globalSettings — wizard uses it for PUBLIC_DOMAIN /
   *  NGINX_ADMIN_EMAIL captured before this step; modal passes `{}`. */
  startConfigure: (
    items: StackItemInput[],
    prefilled: Record<string, string>,
    options?: { node?: string },
  ) => Promise<{ items: StackItem[]; variables: StackVariable[] }>;

  /** Deploy all selected services and run the post-install pipeline.
   *  Transitions configure → installing → done (or pauses on npm
   *  credential prompt). */
  runInstall: (overrides?: { items?: StackItem[]; variables?: StackVariable[]; node?: string }) => Promise<void>;

  /** Retry proxy-route creation with user-provided NPM credentials.
   *  Hook stores them on /api/system/nginx/credentials on success. */
  retryNpmCredentials: (email: string, password: string) => Promise<void>;

  /** Dismiss the prompt without retrying — phase moves to 'done'. */
  skipNpmCredentials: () => void;

  /** Append a single line to the install log. Used by consumers to
   *  prefix the log with pre-flow actions (RAID mount, dependency
   *  warning) before runInstall takes over. */
  appendLog: (line: string) => void;

  /** Reset all install state. Use when consumer cancels mid-flow. */
  reset: () => void;
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

const MAX_DEPLOY_ATTEMPTS = 3;
const DEPLOY_BACKOFF_MS = [0, 1000, 4000];

export function useStackInstall(options: UseStackInstallOptions): UseStackInstallReturn {
  const { templateSource, onBeforeDone } = options;

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

  /** Latest node value. The deploy loop and post-install pipeline read
   *  this via the ref so async work doesn't get pinned to a stale closure
   *  value if the consumer changes nodes mid-resolve. */
  const nodeRef = useRef<string>('');

  const appendLog = useCallback((line: string) => {
    setLogs(prev => [...prev, line]);
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
    nodeRef.current = '';
  }, []);

  const setItemChecked = useCallback((name: string, checked: boolean) => {
    setItems(prev => prev.map(i => (i.name === name ? { ...i, checked } : i)));
  }, []);

  const setVariableValue = useCallback((name: string, value: string) => {
    setVariables(prev => prev.map(v => (v.name === name ? { ...v, value } : v)));
  }, []);

  const startConfigure = useCallback(async (
    inputItems: StackItemInput[],
    prefilled: Record<string, string>,
    opts?: { node?: string },
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

    for (const item of selected) {
      try {
        const yaml = await fetchTemplateYaml(item.name, templateSource);
        if (!yaml) continue;
        const idx = newItems.findIndex(i => i.name === item.name);
        if (idx !== -1) newItems[idx].yaml = yaml;

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
      if (!value && meta?.type === 'secret') value = generateRandomSecret();
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

  /**
   * Register OIDC clients with Authelia for any subdomain variables whose
   * meta.oidcClient is set. Cross-template concern (one POST collects
   * every checked template's clients in a single call) — that's why it
   * stays here instead of inside the auth template's post-deploy.py.
   */
  const registerOidcClients = useCallback(async (
    checkedItems: StackItem[],
    vars: StackVariable[],
  ): Promise<void> => {
    if (!vars.find(v => v.name === 'PUBLIC_DOMAIN')?.value) return;
    const hasOidcClients = vars.some(v => v.meta?.oidcClient && v.meta?.type === 'subdomain' && v.value);
    if (!hasOidcClients) return;

    appendLog('Registering OIDC clients with Authelia...');
    const variableValues = vars.reduce<Record<string, string>>((acc, v) => {
      acc[v.name] = v.value;
      return acc;
    }, {});
    try {
      const res = await fetch('/api/system/authelia/oidc-clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templates: checkedItems.map(i => ({ name: i.name, source: templateSource })),
          variables: variableValues,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data.added?.length) appendLog(`✅ OIDC clients registered: ${data.added.join(', ')}`);
        if (data.skipped?.length) appendLog(`ℹ️ Already registered: ${data.skipped.join(', ')}`);
      } else if (res.status === 404) {
        appendLog('⚠️ Authelia not deployed — OIDC clients not registered. Deploy Authelia first, then redeploy this service.');
      } else {
        appendLog(`⚠️ Could not register OIDC clients: ${data.error || 'unknown error'}`);
      }
    } catch {
      appendLog('⚠️ Could not reach Authelia. Register OIDC clients manually.');
    }
  }, [templateSource, appendLog]);

  const runInstall = useCallback(async (overrides?: {
    items?: StackItem[];
    variables?: StackVariable[];
    node?: string;
  }): Promise<void> => {
    setPhase('installing');
    setError(null);
    setNpmCredPrompt(false);
    setLogs([]);

    if (overrides?.node !== undefined) nodeRef.current = overrides.node;
    const itemsBase = overrides?.items ?? items;
    const varsBase = overrides?.variables ?? variables;
    const node = nodeRef.current;

    if (cleanInstall && cleanInstallConfirm === 'RESET') {
      appendLog('🧹 Clean install — wiping existing service data...');
      try {
        const res = await fetch('/api/system/stacks/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: 'RESET', node: node || undefined }),
        });
        const data = await res.json();
        if (res.ok) {
          const removed = data.deleted?.length ?? 0;
          appendLog(`✅ Reset done — removed ${removed} service${removed === 1 ? '' : 's'}, wiped ${data.dataDir}.`);
          if (data.failed?.length) {
            appendLog(`⚠️ Some services could not be cleanly removed: ${data.failed.map((f: { name: string }) => f.name).join(', ')}`);
          }
        } else {
          appendLog(`⚠️ Reset failed: ${data.error || 'unknown error'}. Continuing with install — existing data may remain.`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown error';
        appendLog(`⚠️ Reset call failed: ${msg}. Continuing with install.`);
      }
    }

    const selected = itemsBase.filter(i => i.checked);
    if (selected.length === 0) {
      appendLog('⚠️ No services selected to install — aborting.');
      setPhase('done');
      setCredentialsManifest([]);
      return;
    }

    const deployed: { name: string; checked: boolean }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scriptCredentials: any[] = [];

    for (const item of selected) {
      if (item.alreadyInstalled) {
        appendLog(`✅ ${item.name} already installed, skipping.`);
        deployed.push({ name: item.name, checked: true });
        continue;
      }
      if (!item.yaml) continue;
      appendLog(`Installing ${item.name}...`);
      setInstallingNow(item.name);

      const view = varsBase.reduce<Record<string, string>>((acc, v) => {
        acc[v.name] = v.value;
        return acc;
      }, {});
      // Disable HTML escaping — Mustache renders YAML and config files,
      // not HTML.
      const savedEscape = Mustache.escape;
      Mustache.escape = (text: string) => text;
      const yamlContent = Mustache.render(item.yaml, view);
      const kubeContent = `[Kube]\nYaml=${item.name}.yml\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target`;

      // Sanity-check that every {{VAR}} referenced in a config file has a
      // value. Without this, Mustache renders missing vars as empty strings
      // — silent data loss that produces crash-looping pods with no
      // breadcrumb back to the configure step.
      const refRe = /\{\{\s*[#^/{]?\s*([A-Z_][A-Z0-9_]*)\s*\}{1,3}/g;
      for (const cf of (item.configFiles || [])) {
        if (!cf.targetPath) continue;
        const refs = new Set<string>();
        for (const m of cf.content.matchAll(refRe)) refs.add(m[1]);
        const missing = [...refs].filter(r => !(r in view) || view[r] === '');
        if (missing.length > 0) {
          Mustache.escape = savedEscape;
          const msg = `Cannot deploy ${item.name}: ${cf.filename} references variable(s) with no value: ${missing.join(', ')}. ` +
            `Go back to the Configure step and fill them in (or check the template's variables.json defaults).`;
          appendLog(`❌ ${msg}`);
          setError(msg);
          setPhase('error');
          setInstallingNow(null);
          return;
        }
      }
      const extraFiles = (item.configFiles || [])
        .filter(cf => cf.targetPath)
        .map(cf => ({
          path: Mustache.render(cf.targetPath!, view),
          content: Mustache.render(cf.content, view),
        }));

      // Optional per-template post-deploy.py — server runs it after the
      // unit starts; output streams back via `progress` events. Parsed
      // below for `__SB_CREDENTIAL__ {json}` markers.
      let postDeployScript: string | undefined;
      try {
        const raw = await fetchTemplatePostDeployScript(item.name, templateSource);
        if (raw) postDeployScript = Mustache.render(raw, view);
      } catch { /* template ships no script — fine */ }
      Mustache.escape = savedEscape;

      const postDeployEnv: Record<string, string> = {};
      for (const v of varsBase) {
        if (typeof v.value === 'string') postDeployEnv[v.name] = v.value;
      }
      if (typeof window !== 'undefined') {
        postDeployEnv.HOST = window.location.hostname || 'localhost';
      }

      const attemptDeploy = async (): Promise<void> => {
        const query = node ? `?node=${node}&stream=1` : '?stream=1';
        let res: Response;
        try {
          res = await fetch(`/api/services${query}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: item.name,
              kubeContent,
              yamlContent,
              yamlFileName: `${item.name}.yml`,
              extraFiles,
              postDeployScript,
              postDeployEnv: postDeployScript ? postDeployEnv : undefined,
            }),
          });
        } catch (networkErr) {
          throw new Error(`network: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`);
        }
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          const msg = errBody.error || `HTTP ${res.status}`;
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
            const fatal = new Error(msg);
            (fatal as Error & { fatal?: boolean }).fatal = true;
            throw fatal;
          }
          throw new Error(msg);
        }
        const reader = res.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let buf = '';
        let lastProgressLine = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const evt = JSON.parse(line);
              if (evt.type === 'progress') {
                if (typeof evt.message === 'string' && evt.message.startsWith('__SB_CREDENTIAL__ ')) {
                  try {
                    scriptCredentials.push(JSON.parse(evt.message.slice('__SB_CREDENTIAL__ '.length)));
                  } catch { /* malformed marker — drop it */ }
                  continue;
                }
                // In-place collapse for image-pull progress only (which
                // ticks once a second per layer). Everything else —
                // including post-deploy.py stdout — appends a new line.
                const isPullProgress = /Pulling image \d+\/\d+|MB\s*\/\s*[\d.]+\s*MB/.test(evt.message ?? '');
                if (isPullProgress && lastProgressLine && /Pulling image \d+\/\d+|MB\s*\/\s*[\d.]+\s*MB/.test(lastProgressLine)) {
                  setLogs(prev => {
                    const next = [...prev];
                    next[next.length - 1] = evt.message;
                    return next;
                  });
                } else {
                  appendLog(evt.message);
                }
                lastProgressLine = evt.message;
              } else if (evt.type === 'error') {
                throw new Error(evt.message);
              }
            } catch (parseErr) {
              if (parseErr instanceof Error && parseErr.message !== line.trim()) throw parseErr;
            }
          }
        }
      };

      let lastDeployErr: Error | null = null;
      let deployedOk = false;
      for (let attempt = 1; attempt <= MAX_DEPLOY_ATTEMPTS; attempt++) {
        if (DEPLOY_BACKOFF_MS[attempt - 1] > 0) {
          await new Promise(r => setTimeout(r, DEPLOY_BACKOFF_MS[attempt - 1]));
        }
        try {
          await attemptDeploy();
          appendLog(attempt > 1
            ? `✅ ${item.name} deployed on attempt ${attempt}/${MAX_DEPLOY_ATTEMPTS}.`
            : `✅ ${item.name} deployed (containers may still be starting in background).`);
          deployedOk = true;
          break;
        } catch (e) {
          lastDeployErr = e instanceof Error ? e : new Error(String(e));
          if ((lastDeployErr as Error & { fatal?: boolean }).fatal) break;
          if (attempt < MAX_DEPLOY_ATTEMPTS) {
            appendLog(`⏳ ${item.name} attempt ${attempt}/${MAX_DEPLOY_ATTEMPTS} failed (${lastDeployErr.message}); retrying in ${DEPLOY_BACKOFF_MS[attempt] / 1000}s…`);
          }
        }
      }
      if (deployedOk) {
        deployed.push({ name: item.name, checked: true });
      } else {
        const msg = lastDeployErr?.message ?? 'unknown error';
        const fatal = lastDeployErr && (lastDeployErr as Error & { fatal?: boolean }).fatal;
        const tail = fatal ? msg : `after ${MAX_DEPLOY_ATTEMPTS} attempt(s): ${msg}`;
        appendLog(`❌ Failed to install ${item.name} ${tail}`);
      }
      setInstallingNow(null);
    }

    const proxyResult = await runPostInstall({
      selected: deployed,
      variables: varsBase,
      node: node || undefined,
      onLog: appendLog,
      extraCredentials: scriptCredentials,
    });

    await registerOidcClients(itemsBase.filter(i => i.checked), varsBase);

    const host = typeof window !== 'undefined' ? window.location.hostname : '';
    const manifest = [
      ...buildCredentialsManifest({ variables: varsBase, host }),
      ...scriptCredentials,
    ];
    setCredentialsManifest(manifest);

    if (proxyResult === 'needs_credentials') {
      // Pre-fill the prompt with whatever the wizard configured — usually
      // the auto-generated values are correct but NPM rejected them
      // because of a stale data volume. Operator can override.
      const fallbackEmail = varsBase.find(v => v.name === 'NGINX_ADMIN_EMAIL')?.value ?? '';
      const fallbackPassword = varsBase.find(v => v.name === 'NGINX_ADMIN_PASSWORD')?.value ?? '';
      setNpmCredFallback({ email: fallbackEmail, password: fallbackPassword });
      setNpmCredPrompt(true);
      return;
    }

    if (onBeforeDone) {
      try {
        await onBeforeDone(deployed, appendLog);
      } catch { /* settle-wait is informational, swallow failures */ }
    }

    setPhase('done');
  }, [items, variables, cleanInstall, cleanInstallConfirm, templateSource, appendLog, registerOidcClients, onBeforeDone]);

  const retryNpmCredentials = useCallback(async (email: string, password: string): Promise<void> => {
    if (!email || !password) return;
    setNpmCredPrompt(false);
    appendLog('Retrying with provided credentials...');
    const result = await configureProxyRoutes({
      variables,
      node: nodeRef.current || undefined,
      onLog: appendLog,
      credentials: { email, password },
      skipWait: true,
    });
    if (result === 'needs_credentials') {
      appendLog('❌ Authentication failed. Please check your credentials.');
      setNpmCredPrompt(true);
      return;
    }
    try {
      await fetch('/api/system/nginx/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      appendLog('Saved NPM credentials for future installs.');
    } catch { /* install succeeded — just won't auto-sync next time */ }
    if (onBeforeDone) {
      try {
        // No `deployed` snapshot available here; pass the checked items as
        // a best-effort substitute. Settle-wait only uses names anyway.
        await onBeforeDone(items.filter(i => i.checked).map(i => ({ name: i.name })), appendLog);
      } catch { /* swallow */ }
    }
    setPhase('done');
  }, [variables, items, appendLog, onBeforeDone]);

  const skipNpmCredentials = useCallback(() => {
    setNpmCredPrompt(false);
    setPhase('done');
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
    startConfigure,
    runInstall,
    retryNpmCredentials,
    skipNpmCredentials,
    appendLog,
    reset,
  };
}

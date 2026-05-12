'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
    checkOnboardingStatus,
    skipOnboarding,
    saveGatewayConfig,
    saveAutoUpdateConfig,
    saveRegistriesConfig,
    saveEmailConfig,
    completeStackSetup,
    markInstallStarted,
    forceClearInstallLock,
    OnboardingStatus
} from '@/app/actions/onboarding';
import { generateLocalKey } from '@/app/actions/ssh';
import { fetchTemplates, fetchReadme } from '@/app/actions';
import { isValidOperatorEmail, operatorEmailIssue } from '@/lib/operatorEmail';
import { getNodes } from '@/app/actions/system';
import { Template } from '@/lib/registry';
import type { TemplateTier } from '@/lib/templateTier';
import { groupVariablesByTemplate } from '@/lib/stackInstall/groupVariables';
import { useStackInstall } from '@/lib/stackInstall/useStackInstall';

import { Loader2, Monitor, Network, Key, CheckCircle, ArrowRight, SkipForward, RefreshCw, Box, Mail, Layers, Package, Globe, HardDrive, Home } from 'lucide-react';
import StackVariableField from './StackVariableField';
import { StackInstallProgress, StackInstallSummary } from './StackInstallFlow';
import { useToast } from '@/providers/ToastProvider';
import { useDigitalTwin } from '@/hooks/useDigitalTwin';

// Steps definition
// Wizard flow:
//   welcome         → pick which features to configure
//   network         → gateway + SSH (if selected on welcome)
//   email           → SMTP (if selected on welcome)
//   install-confirm → compact "express install" summary: domain + clean
//                     install + auto-mount + preselected full-stack.
//                     Default landing for stacksOnlyMode and the next
//                     step after email in fresh setup. Click Install
//                     and the wizard runs the whole install with
//                     sensible defaults; click Edit on a row to fall
//                     through into the explicit machine + stacks steps
//                     below.
//   machine         → host-side prep: domain choice, drive detection
//                     / RAID mount, optional clean-install reset.
//                     Reached via Edit from install-confirm.
//   stacks          → stack picker + per-service selection + per-
//                     service config. Reached via Edit from install-
//                     confirm OR by Continue from machine.
//   finish          → summary
type WizardStep = 'welcome' | 'network' | 'email' | 'install-confirm' | 'machine' | 'stacks' | 'finish';

interface ConfigFile {
  filename: string;
  content: string;
  targetPath?: string;
}

interface StackItem {
  name: string;
  /** Short rationale shown below the service name on the install picker. */
  description?: string;
  checked: boolean;
  yaml?: string;
  alreadyInstalled?: boolean;
  configFiles?: ConfigFile[];
  /**
   * Platform vs feature classification, parsed from the template's
   * `metadata.annotations['servicebay.tier']`. Defaults to 'feature'.
   * Infrastructure-tier templates are auto-included by the wizard
   * with their checkbox locked-on; users pick features on top.
   */
  tier?: TemplateTier;
}

/** Fetch names of services already deployed on the target node */
async function fetchExistingServices(node?: string): Promise<Set<string>> {
  try {
    const query = node ? `?node=${node}` : '';
    const res = await fetch(`/api/services${query}`);
    if (!res.ok) return new Set();
    const services = await res.json();
    return new Set(services.map((s: { name: string }) => s.name?.toLowerCase()));
  } catch {
    return new Set();
  }
}

const WIZARD_STATE_KEY = 'sb.onboarding.v1';

interface PersistedWizardState {
  currentStep: WizardStep;
  stepHistory: WizardStep[];
  selection: {
    gateway: boolean;
    ssh: boolean;
    updates: boolean;
    registries: boolean;
    email: boolean;
    stacks: boolean;
  };
  gwHost: string;
  gwUser: string;
  emailHost: string;
  emailPort: number;
  emailSecure: boolean;
  emailUser: string;
  emailFrom: string;
  emailRecipients: string;
}

function loadPersistedWizardState(): PersistedWizardState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(WIZARD_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedWizardState;
  } catch {
    return null;
  }
}

function clearPersistedWizardState() {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(WIZARD_STATE_KEY);
  } catch { /* noop */ }
}

export default function OnboardingWizard() {
  const persisted = typeof window !== 'undefined' ? loadPersistedWizardState() : null;
  const [isOpen, setIsOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState<WizardStep>(persisted?.currentStep ?? 'welcome');
  const [stepHistory, setStepHistory] = useState<WizardStep[]>(persisted?.stepHistory ?? []);
  
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);
  // ServiceBay version, surfaced in the wizard header. ServiceBay uses
  // autoupdate=registry, so the running version can change between two
  // attempts of the same install — knowing which version produced a
  // given install log saves a debugging round-trip.
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const { addToast } = useToast();
  const router = useRouter();

  // Selection Selection (Welcome Step)
  const [selection, setSelection] = useState(persisted?.selection ?? {
    gateway: true,
    ssh: true,
    updates: false,
    registries: true,
    email: false,
    stacks: true
  });

  // Gateway Form (passwords are intentionally never persisted)
  const [gwHost, setGwHost] = useState(persisted?.gwHost ?? 'fritz.box');
  const [gwUser, setGwUser] = useState(persisted?.gwUser ?? '');
  const [gwPass, setGwPass] = useState('');

  // Email Form (pass is intentionally never persisted)
  const [emailConfig, setEmailConfig] = useState({
      host: persisted?.emailHost ?? '',
      port: persisted?.emailPort ?? 587,
      secure: persisted?.emailSecure ?? false,
      user: persisted?.emailUser ?? '',
      pass: '',
      from: persisted?.emailFrom ?? '',
      recipients: persisted?.emailRecipients ?? ''
  });

  // Stack Selection
  const [availableStacks, setAvailableStacks] = useState<Template[]>([]);
  /** name → tier map of every template (not just stacks). Populated by
   *  loadStacks(), used by handleSelectStack to mark each StackItem as
   *  'infrastructure' or 'feature' so the wizard can lock-include the
   *  platform tier. See `src/lib/templateTier.ts`. */
  const [templateTiers, setTemplateTiers] = useState<Map<string, TemplateTier>>(new Map());
  const [selectedStack, setSelectedStack] = useState<Template | null>(null);
  const [stackItems, setStackItems] = useState<StackItem[]>([]);
  /** Stage in the install sub-flow. 'select' and 'services' are wizard-
   *  specific UIs (stack picker + per-service dependency resolution); the
   *  shared engine takes over from 'configure' onwards via `installFlow`. */
  const [wizardSubStep, setWizardSubStep] = useState<'select' | 'services' | 'flow'>('select');
  const [stackNodes, setStackNodes] = useState<{ Name: string; URI: string }[]>([]);
  const [stackSelectedNode, setStackSelectedNode] = useState('');
  const [stacksLoading, setStacksLoading] = useState(false);
  // Two-mode classification per #249 / #262. The wizard's domain step
  // surfaces a 2-way picker:
  //   🌍 'public' (default, recommended): user has a real domain →
  //      services land on <sub>.publicDomain with Let's Encrypt + external.
  //   🏡 'lan': no public domain → services land on <sub>.home.arpa via
  //      AdGuard rewrites; HTTP-only on the LAN. Switchable later in
  //      Settings → Reverse Proxy.
  // `publicDomain` only matters when `installMode === 'public'`.
  // `stackNoDomain` and `stackDomain` (derived below for back-compat
  // with the rest of the wizard) reflect the new state.
  const [installMode, setInstallMode] = useState<'public' | 'lan'>('public');
  const [publicDomain, setPublicDomain] = useState('');
  /** True when the operator picked the LAN-only path. Derived from
   *  `installMode` so the rest of the wizard's existing references
   *  keep working without site-wide renames. */
  const stackNoDomain = installMode === 'lan';
  /** Effective public-domain value to fan out to deploy templates +
   *  PUBLIC_DOMAIN var injection. Empty when LAN-only. Setter mutates
   *  `publicDomain` (which only matters in public-mode); legacy callers
   *  that previously did `setStackDomain('foo')` still work. */
  const stackDomain = installMode === 'public' ? publicDomain : '';
  const setStackDomain = (val: string) => {
    setPublicDomain(val);
    if (val) setInstallMode('public');
  };
  /** Operator e-mail. Used as NPM's admin login + Let's Encrypt ACME
   *  registration. Mandatory in public mode (LE rejects `.local` and
   *  empty values); ignored in LAN-only mode. Pre-filled from
   *  `config.notifications.email.to[0]` so the operator doesn't retype
   *  the address they already gave us during bootstrap.
   *
   *  Fans out at variable-collection time (#365): any template variable
   *  named `NGINX_ADMIN_EMAIL` is overridden with this value and marked
   *  global so it disappears from the configure step. */
  const [operatorEmail, setOperatorEmail] = useState('');
  const [stackDeviceOptions, setStackDeviceOptions] = useState<Record<string, string[]>>({});
  const [stackLoadingDevices, setStackLoadingDevices] = useState(false);

  // RAID detection
  const [raidArrays, setRaidArrays] = useState<{ device: string; label: string; fstype: string; size: string; mountpoint: string | null; degraded: boolean }[]>([]);
  // Full block-device list from /api/system/storage. Surfaced as a
  // "Detected drives" panel so the operator can confirm every expected
  // disk is visible before deciding what to mount. Tree-shaped (top-level
  // disks with children for partitions / RAID members).
  type DetectedDrive = {
    name: string; path: string; type: string; size: string;
    model?: string; vendor?: string; serial?: string; rota?: boolean;
    fstype?: string; label?: string; mountpoint?: string | null;
    fsAvail?: string; fsUsedPct?: string;
    children?: DetectedDrive[];
  };
  const [detectedDrives, setDetectedDrives] = useState<DetectedDrive[]>([]);
  const [raidMounting, setRaidMounting] = useState(false);
  const [raidMounted, setRaidMounted] = useState(false);

  // Track whether we're in stacks-only mode (post-install first boot)
  const [stacksOnlyMode, setStacksOnlyMode] = useState(false);

  // Service-dependency map. Hard deps must be installed together; soft
  // deps just enable optional integrations (typically OIDC SSO). Keep
  // this in sync with what the templates assume — eventually we should
  // declare it inside each template's variables.json instead of here,
  // but the catalog is small enough today that hardcoding is fine.
  type ServiceDeps = { requires?: string[]; recommendedWith?: string[]; reason?: string };
  const SERVICE_DEPS: Record<string, ServiceDeps> = {
    // The 'auth' stack bundles authelia + lldap together, so there's no
    // longer a separate authelia → lldap hard dep to declare. Soft deps
    // ("recommendedWith: ['auth']") indicate which services benefit from
    // SSO if you also install the auth stack.
    vaultwarden:      { recommendedWith: ['auth'], reason: 'OIDC SSO via authelia (optional but recommended)' },
    immich:           { recommendedWith: ['auth'], reason: 'OIDC SSO via authelia (optional)' },
    'home-assistant': { recommendedWith: ['auth'], reason: 'OIDC SSO via authelia (optional)' },
    radicale:         { recommendedWith: ['auth'] },
    media:            { recommendedWith: ['auth'], reason: 'Audiobookshelf OIDC + Navidrome reverse-proxy SSO via authelia' },
    'file-share':     { recommendedWith: ['auth'], reason: 'FileBrowser uses authelia forward-auth for family-facing access' },
  };

  // Live container/service state from the agent. The status strip
  // ABOVE the log panel uses this — NOT log-parsing — so a service
  // counts as "deployed" only when its container is actually Up, not
  // when the deploy API just returned. (Earlier log-parsing version
  // showed "12/12 deployed" while NPM was still pulling its image.)
  const { data: digitalTwin } = useDigitalTwin();
  // Async install handlers (deploy → settle-wait → done) capture the
  // initial digitalTwin closure value and never see SSE-driven updates
  // for the duration of the loop. Mirror the latest value into a ref
  // so those long-running async functions can read fresh state via
  // `digitalTwinRef.current`. Without this, the settle-wait loop reads
  // stale data and reports "0/N services active" indefinitely even
  // though services are actually coming up.
  const digitalTwinRef = useRef(digitalTwin);
  useEffect(() => { digitalTwinRef.current = digitalTwin; }, [digitalTwin]);

  // Settle-wait — don't transition to 'done' until each newly-deployed
  // service shows up as active in the digital twin. Previously inline in
  // handleStackInstall; now passed to the shared engine via onBeforeDone
  // so the wizard's "(N/M up)" log lines still appear before the Done
  // credentials banner renders. Cap the wait at 3 minutes — long enough
  // for cold-start image pulls on a normal connection — then transition
  // either way and let the diagnose probe report what's genuinely stuck.
  //
  // Skip if there's no twin connection (tests, or a disconnected agent —
  // in either case hanging the wizard for 3 min helps no one) or nothing
  // was deployed.
  const settleWait = useCallback(async (
    deployed: { name: string }[],
    appendLog: (msg: string) => void,
  ) => {
    if (!digitalTwinRef.current || deployed.length === 0) return;
    const expected = deployed.map(i => i.name);
    const SETTLE_TIMEOUT_MS = 3 * 60_000;
    const SETTLE_POLL_MS = 5_000;
    const startedAt = Date.now();
    let lastReady = -1;
    while (Date.now() - startedAt < SETTLE_TIMEOUT_MS) {
      const node = stackSelectedNode || 'Local';
      const twinNode = digitalTwinRef.current?.nodes?.[node];
      const services = twinNode?.services ?? [];
      const ready = expected.filter(name =>
        services.some(s => (s.name === name || s.name === `${name}.service`) && s.active),
      ).length;
      if (ready !== lastReady) {
        appendLog(`Waiting for services to become active... (${ready}/${expected.length} up)`);
        lastReady = ready;
      }
      if (ready === expected.length) break;
      await new Promise(r => setTimeout(r, SETTLE_POLL_MS));
    }
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    if (lastReady === expected.length) {
      appendLog(`✅ All ${expected.length} services active after ${elapsed}s.`);
    } else {
      appendLog(
        `⚠️ ${lastReady}/${expected.length} services active after ${elapsed}s — slow image pulls or a real failure. Self-diagnose below will tell you which.`,
      );
    }
  }, [stackSelectedNode]);

  /**
   * Shared install engine — owns the configure / installing / done state
   * machine, variable resolution, streaming deploys, and post-install
   * pipeline. The wizard provides the digital-twin settle-wait via
   * onBeforeDone so the credentials banner renders only after the
   * services actually came up. See `useStackInstall.ts` and #341.
   */
  const installFlow = useStackInstall({
    templateSource: selectedStack?.source || 'Built-in',
    onBeforeDone: settleWait,
  });

  // Configure-step tab. Variables are categorised so the operator isn't
  // staring at a 50-line flat list — the "subdomains" tab shows the
  // user-meaningful per-service URLs, "settings" shows the misc
  // text/select/secret inputs, "ports" shows host-port mappings (most
  // operators never touch these).
  type ConfigureTab = 'subdomains' | 'settings' | 'ports';
  // null = "auto-pick the first non-empty tab"; user click locks the choice.
  const [configureTab, setConfigureTab] = useState<ConfigureTab | null>(null);

  // Post-install self-test — auto-runs once the install pipeline reaches
  // 'done' so the user immediately sees a green/yellow/red verdict on
  // their fresh deployment instead of having to navigate to Settings.
  type ProbeStatus = 'ok' | 'warn' | 'fail' | 'info';
  interface DiagnoseProbe { id: string; label: string; status: ProbeStatus; detail: string; hint?: string }
  const [diagnoseProbes, setDiagnoseProbes] = useState<DiagnoseProbe[] | null>(null);
  const [diagnoseRunning, setDiagnoseRunning] = useState(false);
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null);
  const [diagnoseRanOnce, setDiagnoseRanOnce] = useState(false);

  // Clean install + log state live in the install-flow controller now —
  // the local aliases below keep the JSX readable without touching every
  // call site.
  const cleanInstall = installFlow.cleanInstall;
  const cleanInstallConfirm = installFlow.cleanInstallConfirm;
  const setCleanInstall = installFlow.setCleanInstall;
  const setCleanInstallConfirm = installFlow.setCleanInstallConfirm;
  const stackVariables = installFlow.variables;
  const stackLogs = installFlow.logs;
  const installingNow = installFlow.installingNow;
  /** Display-only union that lets the existing JSX guards
   *  (`stackInstallStep === 'configure'` etc.) keep working without
   *  rewriting every site. Drives off the wizard's sub-step plus the
   *  controller's phase. */
  const stackInstallStep: 'select' | 'services' | 'configure' | 'installing' | 'done' =
    wizardSubStep === 'select' ? 'select'
    : wizardSubStep === 'services' ? 'services'
    : installFlow.phase === 'idle' ? 'select'
    : installFlow.phase === 'error' ? 'done'
    : installFlow.phase;

  useEffect(() => {
    fetch('/api/system/version')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.version) setAppVersion(d.version); })
      .catch(() => { /* version is informational; silent failure is fine */ });
  }, []);

  useEffect(() => {
    checkOnboardingStatus().then(s => {
      setStatus(s);
      // If a server-side install lock exists and we're NOT actively
      // running the install in this tab (we'd have set stackInstallStep
      // = 'installing' already and started heartbeating), show the
      // "another session is installing" gate so the operator doesn't
      // race two installs in parallel.
      if (s.installInProgress && stackInstallStep !== 'installing') {
         
        setIsOpen(true);
        return;
      }
      if (s.needsSetup) {
        setIsOpen(true);
        // Only seed selection from feature detection if we have no persisted draft —
        // otherwise the user's in-progress choices win.
        if (!persisted) {
          setSelection(prev => ({
              ...prev,
              gateway: !s.features.gateway,
              ssh: !s.features.ssh,
              updates: !s.features.updates,
              registries: !s.features.registries,
              email: !s.features.email,
              stacks: true
          }));
        } else if (typeof window !== 'undefined') {
          addToast(
            'info',
            'Setup resumed',
            'We restored your in-progress onboarding from the previous session.',
          );
        }
      } else if (s.stackSetupPending) {
        // Setup was completed by installer, but stacks haven't been chosen
        // yet. Land on the install-confirm screen — domain +
        // clean-install + preselected full-stack. Edit drops them into
        // the explicit machine + stacks flow.
        //
        // Self-heal: if the persisted draft is from a previous (broken)
        // install attempt — i.e. it points at any step BEFORE
        // install-confirm — the installer has since rewritten config
        // with `setupCompleted=true` and `stackSetupPending=true`, so
        // anything the operator had drafted (gateway? SSH? email?) is
        // either irrelevant or already provisioned. Drop the stale
        // draft and start fresh at install-confirm. Without this
        // guard, sessionStorage survives across reinstalls and the
        // operator gets stuck on the welcome step even though their
        // box is fully configured. See #341.
        const stepsBeforeInstallConfirm: WizardStep[] = ['welcome', 'network', 'email'];
        if (persisted && stepsBeforeInstallConfirm.includes(persisted.currentStep)) {
          clearPersistedWizardState();
        }
        // stacksOnlyMode still drives the finish action (we just
        // completeStackSetup vs full skipOnboarding) and the button
        // label on the last step — what we *don't* do anymore is let
        // it diverge the wizard's chrome.
        setStacksOnlyMode(true);
        setCurrentStep('install-confirm');
        setIsOpen(true);
      } else {
        // No setup needed — clear any stale draft.
        clearPersistedWizardState();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist non-secret state on every change so refresh / closed-tab resumes from the same step.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isOpen) return;
    const snapshot: PersistedWizardState = {
      currentStep,
      stepHistory,
      selection,
      gwHost,
      gwUser,
      emailHost: emailConfig.host,
      emailPort: emailConfig.port,
      emailSecure: emailConfig.secure,
      emailUser: emailConfig.user,
      emailFrom: emailConfig.from,
      emailRecipients: emailConfig.recipients,
    };
    try {
      window.sessionStorage.setItem(WIZARD_STATE_KEY, JSON.stringify(snapshot));
    } catch { /* quota / disabled storage */ }
  }, [isOpen, currentStep, stepHistory, selection, gwHost, gwUser, emailConfig.host, emailConfig.port, emailConfig.secure, emailConfig.user, emailConfig.from, emailConfig.recipients]);

  // Warn before unload if the user has progressed past Welcome.
  // Only block tab-close while we're actively installing — the API stream
  // is in flight and abandoning it leaves a half-deployed stack. Outside of
  // that window the prompt is just user-hostile (the wizard's state lives
  // in sessionStorage and survives reloads anyway).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isOpen) return;
    if (!(currentStep === 'stacks' && stackInstallStep === 'installing')) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isOpen, currentStep, stackInstallStep]);

  // Heartbeat the server-side install lock while the wizard is in
  // 'installing'. Other tabs / devices polling /api/onboarding will see
  // installInProgress and refuse to start a fresh install. The lock
  // auto-expires server-side at 30 min if heartbeats stop (covers crashed
  // installs / lost power).
  useEffect(() => {
    if (stackInstallStep !== 'installing') return;
    const tick = () => { void markInstallStarted('wizard'); };
    tick();
    const id = setInterval(tick, 20_000);
    return () => clearInterval(id);
  }, [stackInstallStep]);

  // Auto-run the self-diagnose once the install pipeline lands on 'done'.
  // Gated by `diagnoseRanOnce` so reopening the panel doesn't re-fire and
  // a manual "Run again" can override the auto-run.
  useEffect(() => {
    if (stackInstallStep !== 'done') return;
    if (diagnoseRanOnce) return;
     
    setDiagnoseRanOnce(true);
    setDiagnoseRunning(true);
    setDiagnoseError(null);
    fetch('/api/system/diagnose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(async r => {
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((data: { probes: DiagnoseProbe[] }) => setDiagnoseProbes(data.probes))
      .catch(e => setDiagnoseError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDiagnoseRunning(false));
  }, [stackInstallStep, diagnoseRanOnce]);

  // Load stacks when entering the stacks step
  const loadStacks = useCallback(async () => {
    setStacksLoading(true);
    try {
      const [templates, nodes] = await Promise.all([fetchTemplates(), getNodes()]);
      const stacks = templates.filter(t => t.type === 'stack');
      setAvailableStacks(stacks);
      // Cache per-template tier info so handleSelectStack can decorate
      // its parsed stackItems with `tier` lookups instead of re-fetching
      // each template.yml on stack-pick. Templates list is small (~10
      // entries), the lookup is one-off per install.
      const tiers = new Map<string, 'infrastructure' | 'feature'>();
      for (const t of templates.filter(t => t.type === 'template')) {
        tiers.set(t.name, t.tier ?? 'feature');
      }
      setTemplateTiers(tiers);
      setStackNodes(nodes);
      if (nodes.length === 1) setStackSelectedNode(nodes[0].Name);
      // Single-stack-only installs (the common case — only `full-stack`
      // ships built-in) should skip the picker step; the user has
      // nothing to choose. Auto-select it so they land directly in
      // the per-service checkbox grid.
      if (stacks.length === 1 && !selectedStack) {
        await handleSelectStack(stacks[0]);
      }
    } catch {
      // Stacks not available yet, that's OK
      setAvailableStacks([]);
    } finally {
      setStacksLoading(false);
    }
    // handleSelectStack + selectedStack referenced in the auto-select
    // branch — they don't change identity within a wizard run, so
    // omitting from deps is safe and avoids a re-loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Load stacks list eagerly on every install-related step — we need
    // the list to render the express confirm summary (preselected
    // full-stack), to drive /api/system/storage (single-node nodename),
    // and for the explicit stack picker. loadStacks() also seeds
    // stackSelectedNode for single-node setups.
    if (
        (currentStep === 'stacks' || currentStep === 'machine' || currentStep === 'install-confirm')
        && availableStacks.length === 0
        && !stacksLoading
    ) {
      loadStacks();
    }
  }, [currentStep, availableStacks.length, stacksLoading, loadStacks]);

  // On entering install-confirm, pre-fill the domain field from the
  // baked-in reverseProxy.publicDomain (set by the install script when
  // the operator passed --domain to the bootstrap). Same setting that
  // handleStackFetchVars reads later — pulling it eagerly here just
  // means the operator sees their domain rather than an empty input.
  //
  // Same call pre-fills `operatorEmail` from
  // `config.notifications.email.to[0]` — the operator already gave us
  // this during bootstrap so they don't have to retype.
  useEffect(() => {
    if (currentStep !== 'install-confirm') return;
    if (stackDomain && operatorEmail) return;
    let cancelled = false;
    fetch('/api/settings').then(r => r.ok ? r.json() : null).then(s => {
      if (cancelled) return;
      if (!stackDomain && !stackNoDomain) {
        const baked = s?.reverseProxy?.publicDomain;
        if (typeof baked === 'string' && baked.length > 0) {
          setStackDomain(baked);
        }
      }
      if (!operatorEmail) {
        const notifyTo = s?.notifications?.email?.to;
        const firstTo = Array.isArray(notifyTo) ? notifyTo[0] : undefined;
        if (typeof firstTo === 'string' && firstTo.includes('@')) {
          setOperatorEmail(firstTo);
        }
      }
    }).catch(() => { /* silent — operator can type the values */ });
    return () => { cancelled = true; };
  }, [currentStep, stackDomain, stackNoDomain, operatorEmail]);

  const navigateTo = (step: WizardStep) => {
      setStepHistory(prev => [...prev, currentStep]);
      setCurrentStep(step);
  };

  const handleBack = () => {
    const prev = stepHistory[stepHistory.length - 1];
    if (prev) {
        setStepHistory(h => h.slice(0, -1));
        setCurrentStep(prev);
    }
  };

  const getNextStep = (current: WizardStep): WizardStep => {
      const order: WizardStep[] = ['welcome', 'network', 'email', 'install-confirm', 'machine', 'stacks', 'finish'];

      // Two paths through the install region of the wizard:
      //   express mode  → welcome → network → email → install-confirm → finish
      //   edit mode     → welcome → network → email → machine → stacks → finish
      // Edit mode is entered when the operator clicks "Edit details"
      // on the confirm screen (jumps to 'machine'). Once they're in
      // either machine or stacks, we treat them as committed to the
      // verbose flow — install-confirm drops out of the activeSteps
      // and the existing machine → stacks → finish chain takes over.
      const inEditMode = current === 'machine' || current === 'stacks';
      const activeSteps = order.filter(step => {
         if (step === 'welcome' || step === 'finish') return true;
         if (step === 'network') return selection.gateway || selection.ssh;
         if (step === 'install-confirm') return selection.stacks && !inEditMode;
         if (step === 'machine' || step === 'stacks') return inEditMode;
         return selection[step as keyof typeof selection];
      });

      const currentIndex = activeSteps.indexOf(current);
      if (currentIndex === -1 || currentIndex === activeSteps.length - 1) return 'finish';
      return activeSteps[currentIndex + 1];
  };

  const handleNext = () => {
      navigateTo(getNextStep(currentStep));
  };


  const handleSkip = async () => {
    await skipOnboarding();
    clearPersistedWizardState();
    setIsOpen(false);
    addToast('info', 'Setup Skipped', 'You can configure settings later in the System menu.');
  };

  const saveAndNext = async (action: () => Promise<void>) => {
    setLoading(true);
    try {
        await action();
        handleNext(); // Move to next step if save success
    } catch {
        // Toast handled in action usually, or generic error here
        addToast('error', 'Error', 'Failed to save settings');
    } finally {
        setLoading(false);
    }
  };


  const handleFinish = async () => {
    if (stacksOnlyMode) {
      await completeStackSetup();
    } else {
      await skipOnboarding(); // Mark as complete
    }
    clearPersistedWizardState();
    setIsOpen(false);
    router.refresh();
    addToast('success', 'Setup Complete', 'Welcome to ServiceBay!');
  };
  
  // -- Specific Save Handlers --

  // Welcome → next: persist the cheap toggle-only decisions (auto-update,
  // template registries) inline so they don't need their own dedicated
  // pass-through steps. Gateway / SSH / email / stacks still gate their own
  // dedicated step because they need actual data or a confirmation action.
  const handleSaveWelcome = () => saveAndNext(async () => {
      const tasks: Promise<unknown>[] = [];
      if (selection.updates) tasks.push(saveAutoUpdateConfig(true));
      if (selection.registries) tasks.push(saveRegistriesConfig(true));
      if (tasks.length > 0) await Promise.all(tasks);
  });

  const handleSaveNetwork = () => saveAndNext(async () => {
      // Gateway and SSH key generation are conditional. Gateway needs the
      // form values; SSH key generation is its own button (handled inline).
      if (selection.gateway) {
          await saveGatewayConfig(gwHost, gwUser, gwPass);
          addToast('success', 'Gateway Saved');
      }
  });

  const handleSaveEmail = () => saveAndNext(async () => {
      await saveEmailConfig(emailConfig);
      addToast('success', 'Email Configured');
  });

  const handleGenerateKey = async () => {
    setLoading(true);
    try {
        const res = await generateLocalKey();
        if (res.success) {
            addToast('success', 'Success', 'SSH Key generated.');
            setStatus(prev => prev ? ({ ...prev, hasSshKey: true }) : null);
        } else {
             addToast('error', 'Error', res.error || 'Failed to generate key');
        }
    } catch {
        addToast('error', 'Error', 'Failed call');
    } finally {
        setLoading(false);
    }
  };

  // Fetch USB devices when node is selected and device-type variables exist.
  // Auto-pick when a path has exactly one device available — saves the
  // operator a click for the common Z-Wave/Zigbee single-stick case.
  useEffect(() => {
    if (!stackSelectedNode) return;
    const deviceVars = stackVariables.filter(v => v.meta?.type === 'device');
    if (deviceVars.length === 0) return;
    const paths = new Set(deviceVars.map(v => v.meta?.devicePath || '/dev/serial/by-id'));
    setStackLoadingDevices(true);
    Promise.all(
      Array.from(paths).map(async (devicePath) => {
        try {
          const res = await fetch(`/api/system/devices?node=${stackSelectedNode}&path=${encodeURIComponent(devicePath)}`);
          if (res.ok) {
            const data = await res.json();
            return { path: devicePath, devices: data.devices as string[] };
          }
        } catch { /* ignore */ }
        return { path: devicePath, devices: [] as string[] };
      })
    ).then(results => {
      const opts: Record<string, string[]> = {};
      for (const r of results) opts[r.path] = r.devices;
      setStackDeviceOptions(opts);
      setStackLoadingDevices(false);

      // Auto-pick the single device per path. Only fills variables that
      // are still empty — never overwrites an explicit operator choice.
      for (const v of stackVariables) {
        if (v.meta?.type !== 'device' || v.value) continue;
        const path = v.meta?.devicePath || '/dev/serial/by-id';
        const devices = opts[path] ?? [];
        if (devices.length === 1) installFlow.setVariableValue(v.name, devices[0]);
      }
    });
    // Depend on the specific stable callback, NOT the whole `installFlow`
    // object — the hook's return literal is recreated every render, which
    // would otherwise re-fire this effect on every appendLog during install
    // and saturate the browser's HTTP connection pool with
    // /api/system/devices polls.
  }, [stackSelectedNode, stackVariables, installFlow.setVariableValue]);

  // Detect unmounted RAID arrays when node is selected
  useEffect(() => {
    if (!stackSelectedNode || raidMounted) return;
    fetch(`/api/system/storage?node=${stackSelectedNode}`)
      .then(r => r.ok ? r.json() : { raids: [], drives: [] })
      .then(data => {
        setRaidArrays((data.raids || []).filter((r: { mountpoint: string | null }) => !r.mountpoint));
        setDetectedDrives(data.drives || []);
      })
      .catch(() => { setRaidArrays([]); setDetectedDrives([]); });
  }, [stackSelectedNode, raidMounted]);

  // -- Stack Handlers --

  // Returns the parsed items in addition to setting state. Express
  // install threads them into the next step directly because React
  // closures captured before the setStackItems can't see the new
  // value within the same async chain.
  const handleSelectStack = async (stack: Template): Promise<StackItem[]> => {
    setSelectedStack(stack);
    setWizardSubStep('services');
    setStacksLoading(true);

    try {
      const [readme, existing] = await Promise.all([
        fetchReadme(stack.name, 'stack', stack.source),
        fetchExistingServices(stackSelectedNode || undefined),
      ]);
      const lines = (readme || '').split('\n');
      const parsedItems: StackItem[] = [];
      // Captures `- [x] name — description` (em-dash, en-dash, hyphen, or colon).
      // Description part is optional so legacy stack READMEs without it still parse.
      const regex = /-\s*\[([ xX])\]\s*([\w\d_-]+)\s*(?:[—–\-:]\s*(.+))?$/;
      lines.forEach(line => {
        const match = line.match(regex);
        if (match) {
          const name = match[2].trim();
          const isInstalled = existing.has(name.toLowerCase());
          parsedItems.push({
            name,
            description: match[3]?.trim() || undefined,
            // Infrastructure-tier templates (adguard, nginx, auth) are
            // always installed — force-checked regardless of the
            // README's [x] / [ ] state. Users pick features; the
            // platform is non-negotiable. See #258 / #249.
            tier: templateTiers.get(name) ?? 'feature',
            checked: templateTiers.get(name) === 'infrastructure'
              ? !isInstalled
              : (!isInstalled && match[1].toLowerCase() === 'x'),
            alreadyInstalled: isInstalled,
          });
        }
      });
      setStackItems(parsedItems);
      return parsedItems;
    } catch {
      setStackItems([]);
      return [];
    } finally {
      setStacksLoading(false);
    }
  };

  // Pre-flow → configure transition. Delegates yaml/variable/config-file
  // hydration + secret/rsa/bcrypt fill to the shared engine. The wizard's
  // own pre-fills (PUBLIC_DOMAIN, NGINX_ADMIN_EMAIL) ride in via the
  // `prefilled` argument and end up marked `global` in the resolved set,
  // so they're hidden from the configure step's per-service tabs.
  //
  // itemsOverride: same closure-bypass story as before — express install
  // threads items in directly because the setStackItems from
  // handleSelectStack isn't visible to the next call's stale closure.
  const handleStackFetchVars = async (
      itemsOverride?: StackItem[],
  ): Promise<{ items: StackItem[]; variables: import('@/lib/stackInstall/useStackInstall').StackVariable[] }> => {
    setWizardSubStep('flow');
    setStacksLoading(true);
    try {
      // The install script can pre-bake reverseProxy.publicDomain into
      // config.json — pull it here so the wizard's domain prompt shows
      // it as default and the user doesn't have to retype it.
      try {
        const settingsRes = await fetch('/api/settings');
        if (settingsRes.ok) {
          const settings = await settingsRes.json();
          const bakedDomain = settings.reverseProxy?.publicDomain;
          if (bakedDomain && !stackDomain) setStackDomain(bakedDomain);
        }
      } catch { /* operator can type the values */ }

      const baseItems = itemsOverride ?? stackItems;
      const prefilled: Record<string, string> = {};
      if (stackDomain) prefilled.PUBLIC_DOMAIN = stackDomain;
      if (operatorEmail) prefilled.NGINX_ADMIN_EMAIL = operatorEmail;

      const result = await installFlow.startConfigure(
        baseItems.map(i => ({
          name: i.name,
          checked: i.checked,
          alreadyInstalled: i.alreadyInstalled,
        })),
        prefilled,
        { node: stackSelectedNode || undefined },
      );

      // Mirror yaml/configFiles back into the wizard's stackItems so the
      // status strip and dependency-display in the services step keep
      // working off the same data shape they had before.
      const merged = baseItems.map(i => {
        const hydrated = result.items.find(x => x.name === i.name);
        return hydrated ? { ...i, yaml: hydrated.yaml, configFiles: hydrated.configFiles } : i;
      });
      setStackItems(merged);
      return { items: merged, variables: result.variables };
    } finally {
      setStacksLoading(false);
    }
  };

  // Configure → installing → done. The shared engine owns variable
  // resolution, streaming deploys, post-install pipeline, and the NPM
  // credentials prompt; the wizard contributes the digital-twin settle-
  // wait via the `settleWait` callback passed to `useStackInstall`.
  //
  // itemsOverride / variablesOverride: closure-bypass story — the
  // express flow threads the freshly-computed items/variables through
  // because the controller.startConfigure setters aren't visible to
  // the next call's stale closure.
  const handleStackInstall = async (
      itemsOverride?: StackItem[],
      variablesOverride?: import('@/lib/stackInstall/useStackInstall').StackVariable[],
  ) => {
    await installFlow.runInstall({
      items: itemsOverride
        ? itemsOverride.map(i => ({
            name: i.name,
            checked: i.checked,
            yaml: i.yaml,
            configFiles: i.configFiles,
            alreadyInstalled: i.alreadyInstalled,
          }))
        : undefined,
      variables: variablesOverride,
      node: stackSelectedNode || undefined,
    });
  };

  // Express install path. Runs the same install steps the operator
  // would otherwise click through manually:
  //   0. Auto-mount the detected unmounted RAID (if any) so the data
  //      drive is in place before the install starts laying out
  //      /var/mnt/data/stacks/*
  //   1. Pick the full-stack template (handleSelectStack)
  //   2. Fetch service YAMLs and resolve all variables, using defaults
  //      and auto-fill secrets (handleStackFetchVars)
  //   3. Run the install (handleStackInstall)
  // Returns once the install transitions to its 'installing' substep —
  // log streaming + done-state handling continues in the existing
  // stacks-step render below.
  const handleExpressInstall = async () => {
    const fullStack = availableStacks.find(s => s.name === 'full-stack')
        ?? availableStacks[0];
    if (!fullStack) {
      addToast('error', 'No stack available', 'Could not find the full-stack template. Try Edit to pick a stack manually.');
      return;
    }

    // Auto-mount the data drive before the install begins. The detected
    // RAID is the most common shape on the FCoS install (mdadm-managed
    // mirror across the two largest disks); if there isn't one we just
    // continue and let services fall back to the rootfs.
    const raid = raidArrays[0];
    if (raid && !raidMounted && stackSelectedNode) {
      setRaidMounting(true);
      try {
        const res = await fetch(`/api/system/storage?node=${stackSelectedNode}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device: raid.device,
            mountpoint: '/var/mnt/data',
            label: raid.label,
            fstype: raid.fstype,
          }),
        });
        if (res.ok) {
          setRaidMounted(true);
          setRaidArrays([]);
        } else {
          addToast('warning', 'Auto-mount failed', `Could not mount ${raid.device}. Continuing — services will use local storage.`);
        }
      } catch {
        addToast('warning', 'Auto-mount failed', `Could not reach the agent to mount ${raid.device}. Continuing.`);
      } finally {
        setRaidMounting(false);
      }
    }

    // Thread the freshly-computed items + variables through both
    // helpers — calling them as a chain in the same render's closure
    // means the setStackItems / setStackVariables they make aren't
    // visible to the next call's stale closure. Without the explicit
    // hand-off, handleStackInstall used to read an empty stackItems
    // array and "Stack installation complete" appeared with nothing
    // actually deployed.
    const items = await handleSelectStack(fullStack);
    if (items.length === 0) {
      // handleSelectStack already nudged sub-step to 'services' — bring
      // it back to a clean state on install-confirm.
      setWizardSubStep('select');
      addToast('error', 'Stack readme empty', 'Could not parse any services from the full-stack README. Try Edit details.');
      return;
    }
    // Now that we know we have services to install, hand control to
    // the stacks step's install-progress UI.
    navigateTo('stacks');
    const fetched = await handleStackFetchVars(items);
    await handleStackInstall(fetched.items, fetched.variables);
  };

  const handleStackSkip = async () => {
    if (stacksOnlyMode) {
      // In stacks-only mode, skipping goes straight to finish
      await completeStackSetup();
      clearPersistedWizardState();
      setIsOpen(false);
      router.refresh();
      addToast('info', 'Stack Setup Skipped', 'You can install services later from the Registry.');
    } else {
      handleNext();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header. Same chrome regardless of whether we entered via
            full-setup or installer-completed-express mode (#341): one
            title, one icon, one step counter. Step skipping already
            handles "this is configured, skip it" via activeSteps
            filtering, so an express operator naturally sees a smaller
            denominator ("Step 1 of 2") without needing a separate UI. */}
        <div className="p-6 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
           <h2 className="text-xl font-bold flex items-center gap-2">
             <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30">
               <Monitor className="w-5 h-5 text-blue-600 dark:text-blue-400" />
             </div>
             ServiceBay Setup
             {appVersion && (
               <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400 align-middle">
                 v{appVersion}
               </span>
             )}
           </h2>
           {(() => {
             const order: WizardStep[] = ['welcome', 'network', 'email', 'install-confirm', 'machine', 'stacks', 'finish'];
             // Same two-path logic as getNextStep — see comment there.
             const inEditMode = currentStep === 'machine' || currentStep === 'stacks';
             const activeSteps = order.filter(step => {
               if (step === 'welcome' || step === 'finish') return true;
               if (step === 'network') return selection.gateway || selection.ssh;
               if (step === 'install-confirm') return selection.stacks && !inEditMode;
               if (step === 'machine' || step === 'stacks') return inEditMode;
               return selection[step as keyof typeof selection];
             });
             const currentIndex = activeSteps.indexOf(currentStep);
             const total = activeSteps.length;
             if (total <= 1) return null;
             return (
               <div className="flex items-center gap-3 mt-2">
                 <span className="text-sm text-gray-500 dark:text-gray-400">Step {currentIndex + 1} of {total}</span>
                 <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                   <div className="h-full bg-blue-600 rounded-full transition-all duration-300" style={{ width: `${((currentIndex + 1) / total) * 100}%` }} />
                 </div>
               </div>
             );
           })()}
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto">
            {/* Concurrent-install guard. Another browser tab / device /
                MCP session is currently running an install. Refuse to
                start a fresh one — racing two installs corrupts the
                Quadlet directory and the digital twin. Auto-clears
                30 min after the other session's last heartbeat. */}
            {status?.installInProgress && stackInstallStep !== 'installing' ? (
                <div className="space-y-4">
                    <div className="p-4 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20">
                        <p className="text-sm font-semibold text-amber-900 dark:text-amber-100 mb-1">
                            ⏳ Another session is installing
                        </p>
                        <p className="text-xs text-amber-800 dark:text-amber-200 mb-2">
                            An install pipeline is already running ({status.installInProgress.source ?? 'unknown source'}, started {new Date(status.installInProgress.startedAt).toLocaleString()}). Switch to that tab and let it finish, or wait for it to complete here.
                        </p>
                        <p className="text-xs text-amber-700 dark:text-amber-300">
                            If the other session crashed and the lock is stuck, the wizard will release it automatically after 30 minutes — or click below to force-clear.
                        </p>
                    </div>
                    <div className="flex justify-between">
                        <button
                            type="button"
                            onClick={async () => {
                                if (!confirm('Force-clear the install lock? Only do this if you are certain no other install is actually running — racing two installs will corrupt the Quadlet directory.')) return;
                                await forceClearInstallLock();
                                const fresh = await checkOnboardingStatus();
                                setStatus(fresh);
                            }}
                            className="px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300 hover:underline"
                        >
                            Force-clear stuck lock
                        </button>
                        <button
                            type="button"
                            onClick={async () => {
                                const fresh = await checkOnboardingStatus();
                                setStatus(fresh);
                            }}
                            className="px-3 py-1.5 text-xs rounded bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700"
                        >
                            Re-check
                        </button>
                    </div>
                </div>
            ) : currentStep === 'welcome' && (
                <div className="space-y-4">
                    <p className="text-gray-600 dark:text-gray-300">
                        Welcome to ServiceBay! Only a few steps to get your environment ready.
                    </p>
                    <p className="text-sm font-medium text-gray-500 uppercase tracking-wide">
                        What would you like to configure?
                    </p>
                    <div className="space-y-3">
                        {/* FEATURE TOGGLES */}
                        <Toggle 
                            checked={selection.gateway} 
                            onChange={(v: boolean) => setSelection(s => ({...s, gateway: v}))}
                            icon={Network} 
                            color="text-purple-500"
                            title="Internet Gateway" 
                            desc="Connect FRITZ!Box for device discovery"
                        />
                        <Toggle 
                            checked={selection.ssh} 
                            onChange={(v: boolean) => setSelection(s => ({...s, ssh: v}))}
                            icon={Key} 
                            color="text-amber-500"
                            title="Remote Access" 
                            desc="SSH keys for node management"
                        />
                        <Toggle 
                            checked={selection.updates} 
                            onChange={(v: boolean) => setSelection(s => ({...s, updates: v}))}
                            icon={RefreshCw} 
                            color="text-green-500"
                            title="Auto Updates" 
                            desc="Keep ServiceBay and containers updated"
                        />
                         <Toggle
                            checked={selection.registries}
                            onChange={(v: boolean) => setSelection(s => ({...s, registries: v}))}
                            icon={Box}
                            color="text-blue-500"
                            title="Templates"
                            desc="Enable GitHub template registries"
                        />
                        <Toggle
                            checked={selection.stacks}
                            onChange={(v: boolean) => setSelection(s => ({...s, stacks: v}))}
                            icon={Layers}
                            color="text-indigo-500"
                            title="Install Stack"
                            desc="Deploy a pre-configured service bundle"
                        />
                        <Toggle
                            checked={selection.email}
                            onChange={(v: boolean) => setSelection(s => ({...s, email: v}))}
                            icon={Mail}
                            color="text-red-500"
                            title="Notifications"
                            desc="Email alerts for service health"
                        />
                    </div>
                </div>
            )}

            {currentStep === 'network' && (
                <div className="space-y-6">
                    {selection.gateway && (
                        <section className="space-y-3">
                             <h3 className="font-semibold text-lg flex items-center gap-2"><Network className="w-5 h-5 text-purple-500"/> Internet Gateway</h3>
                             <p className="text-sm text-gray-500">
                                Enter your FRITZ!Box details to enable network scanning.
                             </p>
                             <div className="space-y-3">
                                <Input label="Hostname / IP" value={gwHost} onChange={setGwHost} placeholder="fritz.box" />
                                <Input label="Username" value={gwUser} onChange={setGwUser} placeholder="admin" />
                                <Input label="Password" type="password" value={gwPass} onChange={setGwPass} />
                             </div>
                        </section>
                    )}

                    {selection.gateway && selection.ssh && (
                        <hr className="border-gray-200 dark:border-gray-700" />
                    )}

                    {selection.ssh && (
                        <section className="space-y-3">
                            <h3 className="font-semibold text-lg flex items-center gap-2"><Key className="w-5 h-5 text-amber-500"/> Remote Access (SSH)</h3>
                            <p className="text-sm text-gray-600 dark:text-gray-300">
                                {status?.hasSshKey
                                  ? "We found an existing SSH key. You are good to go!"
                                  : "No SSH key found. Generate one now to enable management of remote nodes."}
                            </p>
                            {!status?.hasSshKey && (
                                 <Button onClick={handleGenerateKey} disabled={loading} className="w-full justify-center">
                                    {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Key className="w-4 h-4 mr-2" />}
                                    Generate SSH Key
                                 </Button>
                            )}
                        </section>
                    )}
                </div>
            )}

            {currentStep === 'email' && (
                <div className="space-y-4">
                    <h3 className="font-semibold text-lg flex items-center gap-2"><Mail className="w-5 h-5 text-red-500"/> Email Notifications</h3>
                    <p className="text-sm text-gray-500">Configure SMTP settings for alerts.</p>
                     <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                             <Input label="SMTP Host" value={emailConfig.host} onChange={(v: string) => setEmailConfig(c => ({...c, host: v}))} placeholder="smtp.gmail.com" />
                             <Input label="Port" value={String(emailConfig.port)} onChange={(v: string) => setEmailConfig(c => ({...c, port: parseInt(v) || 587}))} placeholder="587" type="number" hint="587 for TLS, 465 for SSL" />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                             <Input label="Username" value={emailConfig.user} onChange={(v: string) => setEmailConfig(c => ({...c, user: v}))} placeholder="user@example.com" />
                             <Input label="Password" type="password" value={emailConfig.pass} onChange={(v: string) => setEmailConfig(c => ({...c, pass: v}))} />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                             <Input
                               label="From Address"
                               value={emailConfig.from}
                               onChange={(v: string) => setEmailConfig(c => ({...c, from: v}))}
                               placeholder="servicebay@example.com"
                               error={emailConfig.from && !emailConfig.from.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/) ? 'Invalid email format' : undefined}
                             />
                             <div className="flex items-end pb-2">
                                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                                    <input type="checkbox" checked={emailConfig.secure} onChange={e => setEmailConfig(c => ({...c, secure: e.target.checked}))} className="rounded border-gray-300" />
                                    Use SSL/TLS
                                </label>
                             </div>
                        </div>
                        <Input label="Recipients (comma separated)" value={emailConfig.recipients} onChange={(v: string) => setEmailConfig(c => ({...c, recipients: v}))} placeholder="admin@example.com" />
                     </div>
                </div>
            )}

            {/* Express install confirm — compact summary of the
                defaults (preselected full-stack, auto-mount detected
                RAID, preserve data). Operator answers the two remaining
                questions inline (domain + clean-vs-preserve) and hits
                Install. Edit drops them into the explicit machine /
                stacks flow below. */}
            {currentStep === 'install-confirm' && (() => {
                const fullStack = availableStacks.find(s => s.name === 'full-stack') ?? availableStacks[0];
                const detectedRaid = raidArrays[0];
                const topDisks = detectedDrives.filter(d => d.type === 'disk' || /^raid/.test(d.type) || d.type === 'md');
                return (
                    <div className="space-y-4">
                        <h3 className="font-semibold text-lg flex items-center gap-2">
                            <CheckCircle className="w-5 h-5 text-indigo-500"/> Ready to install
                        </h3>
                        <p className="text-sm text-gray-500">
                            We&apos;ll install the recommended stack with sensible defaults. Adjust the two questions below or click <em>Edit details</em> for the full wizard.
                        </p>

                        {/* Domain — 2-mode picker per #249. Public is the
                            default; LAN is the explicit fallback. */}
                        <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 space-y-3">
                            <label className="flex items-center gap-2 text-sm font-medium text-blue-800 dark:text-blue-200">
                                <Globe className="w-4 h-4" /> How will you reach this server?
                            </label>
                            {/* Public option */}
                            <label className={`flex items-start gap-3 p-2 rounded cursor-pointer transition-colors ${installMode === 'public' ? 'bg-white dark:bg-gray-900 border border-blue-300 dark:border-blue-700' : 'hover:bg-blue-100/50 dark:hover:bg-blue-900/30'}`}>
                                <input
                                    type="radio"
                                    name="install-mode-confirm"
                                    checked={installMode === 'public'}
                                    onChange={() => setInstallMode('public')}
                                    className="mt-1"
                                />
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                                        <Globe className="w-4 h-4" /> Yes, I have a public domain <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300">recommended</span>
                                    </div>
                                    <input
                                        type="text"
                                        value={publicDomain}
                                        onChange={e => { setPublicDomain(e.target.value); if (e.target.value) setInstallMode('public'); }}
                                        onFocus={() => setInstallMode('public')}
                                        className="w-full mt-1.5 px-3 py-2 bg-white dark:bg-gray-900 border border-blue-300 dark:border-blue-700 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                                        placeholder="example.com"
                                    />
                                    <p className="text-[11px] text-blue-700 dark:text-blue-300 mt-1">
                                        Enables HTTPS via Let&apos;s Encrypt + external access. Services live at <span className="font-mono">vault.{publicDomain || 'example.com'}</span>, <span className="font-mono">photos.{publicDomain || 'example.com'}</span>, …
                                    </p>
                                    {/* Operator-email input (#365). NPM admin
                                        login + Let's Encrypt ACME registration.
                                        Pre-filled from notifications.email.to[0]
                                        so the operator doesn't retype. */}
                                    {installMode === 'public' && (
                                      <div className="mt-2">
                                        <label className="block text-[11px] font-medium text-blue-800 dark:text-blue-200 mb-1">
                                            Email for Let&apos;s Encrypt + NPM admin
                                        </label>
                                        <input
                                            type="email"
                                            value={operatorEmail}
                                            onChange={e => setOperatorEmail(e.target.value)}
                                            className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-blue-300 dark:border-blue-700 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                                            placeholder="you@example.com"
                                            autoComplete="email"
                                        />
                                        {operatorEmail && !isValidOperatorEmail(operatorEmail) && (
                                            <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1">
                                                {operatorEmailIssue(operatorEmail)}
                                            </p>
                                        )}
                                        {!operatorEmail && (
                                            <p className="text-[11px] text-blue-700 dark:text-blue-300 mt-1">
                                                Required so Let&apos;s Encrypt can issue certificates. Use a real address — <span className="font-mono">.local</span>/<span className="font-mono">.example</span>/<span className="font-mono">.test</span> are rejected.
                                            </p>
                                        )}
                                      </div>
                                    )}
                                </div>
                            </label>
                            {/* LAN option */}
                            <label className={`flex items-start gap-3 p-2 rounded cursor-pointer transition-colors ${installMode === 'lan' ? 'bg-white dark:bg-gray-900 border border-amber-300 dark:border-amber-700' : 'hover:bg-blue-100/50 dark:hover:bg-blue-900/30'}`}>
                                <input
                                    type="radio"
                                    name="install-mode-confirm"
                                    checked={installMode === 'lan'}
                                    onChange={() => setInstallMode('lan')}
                                    className="mt-1"
                                />
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                                        <Home className="w-4 h-4" /> No, internal only for now
                                    </div>
                                    <p className="text-[11px] text-blue-700 dark:text-blue-300 mt-1">
                                        Services live at <span className="font-mono">vault.home.arpa</span> via AdGuard DNS rewrites. HTTP-only on the LAN; no external access. You can switch to a public domain later in Settings.
                                    </p>
                                </div>
                            </label>
                        </div>

                        {/* Storage summary */}
                        {(detectedRaid || topDisks.length > 0) && (
                            <div className="p-3 bg-gray-50 dark:bg-gray-800/40 rounded-lg border border-gray-200 dark:border-gray-700">
                                <div className="flex items-center justify-between mb-1">
                                    <span className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
                                        <HardDrive className="w-4 h-4" /> Storage
                                    </span>
                                    <button type="button" onClick={() => navigateTo('machine')} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
                                </div>
                                {detectedRaid && !raidMounted && (
                                    <p className="text-xs text-gray-600 dark:text-gray-300">
                                        Will auto-mount <span className="font-mono">{detectedRaid.device}</span>{detectedRaid.size && <> ({detectedRaid.size})</>} to <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">/var/mnt/data</code>{detectedRaid.degraded && <> · <span className="text-amber-600 dark:text-amber-400">degraded — 1 disk missing</span></>}.
                                    </p>
                                )}
                                {raidMounted && (
                                    <p className="text-xs text-green-700 dark:text-green-300">
                                        Data drive mounted at <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">/var/mnt/data</code>.
                                    </p>
                                )}
                                {!detectedRaid && !raidMounted && topDisks.length > 0 && (
                                    <p className="text-xs text-gray-600 dark:text-gray-300">
                                        Using local storage — {topDisks.map(d => `${d.path}${d.size ? ` (${d.size})` : ''}`).join(', ')}.
                                    </p>
                                )}
                            </div>
                        )}

                        {/* Stack summary */}
                        <div className="p-3 bg-gray-50 dark:bg-gray-800/40 rounded-lg border border-gray-200 dark:border-gray-700">
                            <div className="flex items-center justify-between">
                                <span className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
                                    <Layers className="w-4 h-4" /> Stack
                                </span>
                                <button type="button" onClick={() => navigateTo('stacks')} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
                            </div>
                            <p className="text-xs text-gray-600 dark:text-gray-300 mt-1">
                                {fullStack
                                    ? <><span className="font-mono">{fullStack.name}</span> from <span className="font-mono">{fullStack.source}</span> — install all services with their defaults.</>
                                    : 'Loading available stacks…'}
                            </p>
                        </div>

                        {/* Existing data — explicit choice, no default */}
                        <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-300 dark:border-amber-700 space-y-2">
                            <span className="flex items-center gap-2 text-sm font-medium text-amber-900 dark:text-amber-100">
                                Existing service data
                            </span>
                            <div className="flex flex-col gap-1">
                                <label className="flex items-start gap-2 cursor-pointer text-xs text-amber-900 dark:text-amber-100">
                                    <input
                                        type="radio"
                                        name="data-policy"
                                        checked={!cleanInstall}
                                        onChange={() => { setCleanInstall(false); setCleanInstallConfirm(''); }}
                                        className="mt-0.5"
                                    />
                                    <span><strong>Preserve data</strong> — keep anything already in <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">/mnt/data/stacks/*</code>. Failed installs of the same service will reuse old volumes.</span>
                                </label>
                                <label className="flex items-start gap-2 cursor-pointer text-xs text-amber-900 dark:text-amber-100">
                                    <input
                                        type="radio"
                                        name="data-policy"
                                        checked={cleanInstall}
                                        onChange={() => setCleanInstall(true)}
                                        className="mt-0.5"
                                    />
                                    <span><strong>Clean install</strong> — wipe <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">/mnt/data/stacks/*</code> first. Use for true fresh-installs or re-testing from scratch.</span>
                                </label>
                            </div>
                            {cleanInstall && (
                                <div className="pt-2">
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
                            )}
                        </div>
                    </div>
                );
            })()}

            {/* Machine prep — host-side decisions (domain, drives, fresh
                install) the operator should answer before picking the
                stack. Pulled out of the 'services' / 'configure' install
                sub-steps so the long service list isn't competing for
                attention. */}
            {currentStep === 'machine' && (
                <div className="space-y-4">
                    <h3 className="font-semibold text-lg flex items-center gap-2"><HardDrive className="w-5 h-5 text-indigo-500"/> Machine Setup</h3>
                    <p className="text-sm text-gray-500">
                        Before installing services, decide how this machine should be reachable, whether to wipe any existing service data, and confirm the storage we plan to use.
                    </p>

                    {/* Domain — 2-mode picker per #249. Public is the
                        default; LAN is the explicit fallback. */}
                    <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 space-y-3">
                        <label className="flex items-center gap-2 text-sm font-medium text-blue-800 dark:text-blue-200">
                            <Globe className="w-4 h-4" /> How will you reach this server?
                        </label>
                        {/* Public option */}
                        <label className={`flex items-start gap-3 p-2 rounded cursor-pointer transition-colors ${installMode === 'public' ? 'bg-white dark:bg-gray-900 border border-blue-300 dark:border-blue-700' : 'hover:bg-blue-100/50 dark:hover:bg-blue-900/30'}`}>
                            <input
                                type="radio"
                                name="install-mode-machine"
                                checked={installMode === 'public'}
                                onChange={() => setInstallMode('public')}
                                className="mt-1"
                            />
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                                    <Globe className="w-4 h-4" /> Yes, I have a public domain <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300">recommended</span>
                                </div>
                                <input
                                    type="text"
                                    value={publicDomain}
                                    onChange={e => { setPublicDomain(e.target.value); if (e.target.value) setInstallMode('public'); }}
                                    onFocus={() => setInstallMode('public')}
                                    className="w-full mt-1.5 px-3 py-2 bg-white dark:bg-gray-900 border border-blue-300 dark:border-blue-700 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                                    placeholder="example.com"
                                />
                                <p className="text-[11px] text-blue-700 dark:text-blue-300 mt-1">
                                    Enables HTTPS via Let&apos;s Encrypt + external access. Services live at <span className="font-mono">vault.{publicDomain || 'example.com'}</span>, <span className="font-mono">photos.{publicDomain || 'example.com'}</span>, …
                                </p>
                                {installMode === 'public' && (
                                  <div className="mt-2">
                                    <label className="block text-[11px] font-medium text-blue-800 dark:text-blue-200 mb-1">
                                        Email for Let&apos;s Encrypt + NPM admin
                                    </label>
                                    <input
                                        type="email"
                                        value={operatorEmail}
                                        onChange={e => setOperatorEmail(e.target.value)}
                                        className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-blue-300 dark:border-blue-700 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                                        placeholder="you@example.com"
                                        autoComplete="email"
                                    />
                                    {operatorEmail && !isValidOperatorEmail(operatorEmail) && (
                                        <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1">
                                            {operatorEmailIssue(operatorEmail)}
                                        </p>
                                    )}
                                    {!operatorEmail && (
                                        <p className="text-[11px] text-blue-700 dark:text-blue-300 mt-1">
                                            Required so Let&apos;s Encrypt can issue certificates. Use a real address — <span className="font-mono">.local</span>/<span className="font-mono">.example</span>/<span className="font-mono">.test</span> are rejected.
                                        </p>
                                    )}
                                  </div>
                                )}
                            </div>
                        </label>
                        {/* LAN option */}
                        <label className={`flex items-start gap-3 p-2 rounded cursor-pointer transition-colors ${installMode === 'lan' ? 'bg-white dark:bg-gray-900 border border-amber-300 dark:border-amber-700' : 'hover:bg-blue-100/50 dark:hover:bg-blue-900/30'}`}>
                            <input
                                type="radio"
                                name="install-mode-machine"
                                checked={installMode === 'lan'}
                                onChange={() => setInstallMode('lan')}
                                className="mt-1"
                            />
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                                    <Home className="w-4 h-4" /> No, internal only for now
                                </div>
                                <p className="text-[11px] text-blue-700 dark:text-blue-300 mt-1">
                                    Services live at <span className="font-mono">vault.home.arpa</span> via AdGuard DNS rewrites. HTTP-only on the LAN; no external access. You can switch to a public domain later in Settings → Reverse Proxy.
                                </p>
                            </div>
                        </label>
                    </div>

                    {/* Detected drives */}
                    {detectedDrives.filter(d => d.type === 'disk' || /^raid/.test(d.type) || d.type === 'md').length > 0 && (
                        <div className="p-3 bg-gray-50 dark:bg-gray-800/40 rounded-lg border border-gray-200 dark:border-gray-700">
                            <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
                                <HardDrive className="w-4 h-4" /> Detected Drives
                            </label>
                            <div className="space-y-1">
                                {detectedDrives
                                    .filter(d => d.type === 'disk' || /^raid/.test(d.type) || d.type === 'md')
                                    .map(d => (
                                        <div key={d.path} className="text-xs text-gray-600 dark:text-gray-300 font-mono">
                                            <span className="text-gray-900 dark:text-gray-100">{d.path}</span>
                                            {d.size && <> &middot; {d.size}</>}
                                            {d.model && <> &middot; <span className="text-gray-500">{d.model.trim()}</span></>}
                                            {typeof d.rota === 'boolean' && <> &middot; <span className="text-gray-500">{d.rota ? 'HDD' : 'SSD/NVMe'}</span></>}
                                            {d.mountpoint && <> &middot; mounted: <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">{d.mountpoint}</code></>}
                                            {d.fsAvail && <> &middot; free: {d.fsAvail}{d.fsUsedPct ? ` (${d.fsUsedPct} used)` : ''}</>}
                                            {!d.mountpoint && d.fstype && <> &middot; {d.fstype} (unmounted)</>}
                                            {d.children && d.children.length > 0 && (
                                                <div className="ml-4 text-[11px] text-gray-500 dark:text-gray-400">
                                                    {d.children.map(c => (
                                                        <div key={c.path}>
                                                            └ {c.path}
                                                            {c.size && <> &middot; {c.size}</>}
                                                            {c.fstype && <> &middot; {c.fstype}</>}
                                                            {c.mountpoint && <> &middot; <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">{c.mountpoint}</code></>}
                                                            {c.fsAvail && <> &middot; free: {c.fsAvail}</>}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                            </div>
                        </div>
                    )}

                    {/* RAID / data drive mount */}
                    {raidArrays.length > 0 && !raidMounted && (
                        <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
                            <label className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-200 mb-2">
                                <HardDrive className="w-4 h-4" /> Unmounted RAID Detected
                            </label>
                            {raidArrays.map(raid => (
                                <div key={raid.device} className="text-xs text-amber-700 dark:text-amber-300 mb-2">
                                    <span className="font-mono">{raid.device}</span>
                                    {raid.label && <> &middot; label: <strong>{raid.label}</strong></>}
                                    {raid.size && <> &middot; {raid.size}</>}
                                    {raid.degraded && <span className="text-amber-600 dark:text-amber-400"> (degraded — 1 disk missing, still usable)</span>}
                                </div>
                            ))}
                            <p className="text-xs text-amber-600 dark:text-amber-400 mb-2">
                                This looks like your data drive. Mount it to <code className="bg-amber-100 dark:bg-amber-800/50 px-1 rounded">/var/mnt/data</code> so services can store data on it?
                            </p>
                            <button
                                type="button"
                                disabled={raidMounting}
                                onClick={async () => {
                                    setRaidMounting(true);
                                    try {
                                        const raid = raidArrays[0];
                                        const res = await fetch(`/api/system/storage?node=${stackSelectedNode}`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({
                                                device: raid.device,
                                                mountpoint: '/var/mnt/data',
                                                label: raid.label,
                                                fstype: raid.fstype,
                                            }),
                                        });
                                        if (res.ok) {
                                            setRaidMounted(true);
                                            setRaidArrays([]);
                                        }
                                    } catch { /* ignore */ }
                                    setRaidMounting(false);
                                }}
                                className="px-3 py-1.5 bg-amber-600 text-white rounded-md text-sm font-medium hover:bg-amber-700 disabled:opacity-50 transition-colors"
                            >
                                {raidMounting ? <><Loader2 className="w-3 h-3 animate-spin inline mr-1" /> Mounting...</> : 'Mount & persist across reboots'}
                            </button>
                        </div>
                    )}
                    {raidMounted && (
                        <div className="p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
                            <p className="text-sm text-green-800 dark:text-green-200 flex items-center gap-2">
                                <CheckCircle className="w-4 h-4" /> RAID mounted at <code className="bg-green-100 dark:bg-green-800/50 px-1 rounded">/var/mnt/data</code> and will persist across reboots.
                            </p>
                        </div>
                    )}

                    {/* Clean install / reset */}
                    <div className="border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3">
                        <label className="flex items-start gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={cleanInstall}
                                onChange={(e) => { setCleanInstall(e.target.checked); if (!e.target.checked) setCleanInstallConfirm(''); }}
                                className="mt-0.5"
                            />
                            <div className="text-sm text-amber-900 dark:text-amber-100">
                                <strong>Clean install</strong> — wipe existing service data first.
                                <p className="text-xs text-amber-800 dark:text-amber-200/80 mt-1">
                                    Stops every stack service, deletes their Quadlet definitions and the contents of <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">/mnt/data/stacks/*</code>. ServiceBay itself is not affected. Use for true fresh-installs or when re-testing from scratch.
                                </p>
                            </div>
                        </label>
                        {cleanInstall && (
                            <div className="mt-3 pt-3 border-t border-amber-300 dark:border-amber-700">
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
                        )}
                    </div>
                </div>
            )}

            {currentStep === 'stacks' && (
                <div className="space-y-4">
                    <h3 className="font-semibold text-lg flex items-center gap-2"><Layers className="w-5 h-5 text-indigo-500"/> Install services</h3>

                    {stackInstallStep === 'select' && (
                        <>
                            <p className="text-sm text-gray-500">
                                Pick a curated set of services to install. You&apos;ll choose which ones from the set on the next step. (Or skip and install individual services later from the Registry.)
                            </p>
                            {stacksLoading ? (
                                <div className="flex items-center justify-center py-8 text-gray-400">
                                    <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading stacks...
                                </div>
                            ) : availableStacks.length === 0 ? (
                                <div className="text-sm text-gray-500 py-4">
                                    No stacks available. Enable template registries first, or install services manually later.
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {availableStacks.map(stack => (
                                        <div
                                            key={stack.name}
                                            onClick={() => handleSelectStack(stack)}
                                            className="flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:border-blue-200 dark:hover:border-blue-800"
                                        >
                                            <div className="mt-0.5 text-indigo-500">
                                                {stack.type === 'stack' ? <Layers className="w-5 h-5" /> : <Package className="w-5 h-5" />}
                                            </div>
                                            <div className="flex-1">
                                                <div className="font-medium text-sm text-gray-900 dark:text-gray-100">{stack.name}</div>
                                                <div className="text-xs text-gray-500">{stack.source}</div>
                                            </div>
                                            <ArrowRight className="w-4 h-4 text-gray-400 mt-1" />
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}

                    {stackInstallStep === 'services' && (
                        <>
                            {/* Domain / drives / clean-install moved to the
                                Machine step (currentStep === 'machine'). Show
                                a small reminder of the domain choice the
                                operator made there so this screen stays
                                self-explanatory. */}
                            <div className="p-2 bg-blue-50 dark:bg-blue-900/20 rounded border border-blue-200 dark:border-blue-800 text-xs text-blue-800 dark:text-blue-200 flex items-center gap-2">
                                <Globe className="w-3 h-3" />
                                {stackNoDomain
                                    ? 'LAN-only install (no public domain — access services by IP:port).'
                                    : stackDomain
                                        ? <>Public domain: <span className="font-mono">{stackDomain}</span></>
                                        : 'No domain set — go back to Machine to choose.'}
                            </div>

                            <p className="text-sm text-gray-500 mb-2 mt-3">Select which services to install from <span className="font-medium">{selectedStack?.name}</span>:</p>
                            {/* Hard-dependency warning: surface any required
                                deps that the operator has unchecked.
                                Auto-include happens on check, but operator
                                can still uncheck a dep manually after — at
                                which point we shout. */}
                            {(() => {
                                const checked = stackItems.filter(i => i.checked && !i.alreadyInstalled);
                                const checkedNames = new Set(checked.map(i => i.name));
                                const installedNames = new Set(stackItems.filter(i => i.alreadyInstalled).map(i => i.name));
                                const missing: { from: string; needs: string; reason?: string }[] = [];
                                for (const item of checked) {
                                    for (const dep of SERVICE_DEPS[item.name]?.requires ?? []) {
                                        if (!checkedNames.has(dep) && !installedNames.has(dep)) {
                                            missing.push({ from: item.name, needs: dep, reason: SERVICE_DEPS[item.name]?.reason });
                                        }
                                    }
                                }
                                // nginx is implicitly required as soon as the operator commits
                                // to a public domain — every other service publishes via a
                                // *_SUBDOMAIN variable that needs the proxy to reach the host. We
                                // don't put this in SERVICE_DEPS because it would mean adding
                                // `requires: ['nginx']` to ~10 services and cluttering each row
                                // with a redundant red badge. Surface it once here instead.
                                const wantsDomain = stackDomain.trim().length > 0 && !stackNoDomain;
                                const hasPublishedService = checked.some(i => i.name !== 'nginx');
                                const nginxAvailable = stackItems.some(i => i.name === 'nginx');
                                if (
                                    wantsDomain &&
                                    nginxAvailable &&
                                    hasPublishedService &&
                                    !checkedNames.has('nginx') &&
                                    !installedNames.has('nginx')
                                ) {
                                    missing.push({
                                        from: 'public domain',
                                        needs: 'nginx',
                                        reason: 'Nginx Proxy Manager terminates HTTPS for every <subdomain>.' + stackDomain.trim() + ' route',
                                    });
                                }
                                if (missing.length === 0) return null;
                                return (
                                    <div className="mb-2 p-2 rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-xs text-red-800 dark:text-red-200 space-y-1">
                                        <div className="font-semibold">Required dependencies are not selected:</div>
                                        {missing.map(m => (
                                            <div key={`${m.from}-${m.needs}`}>
                                                <span className="font-mono">{m.from}</span> requires <span className="font-mono">{m.needs}</span>
                                                {m.reason && <span className="opacity-80"> — {m.reason}</span>}
                                            </div>
                                        ))}
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const next = [...stackItems];
                                                for (const m of missing) {
                                                    const j = next.findIndex(x => x.name === m.needs);
                                                    if (j >= 0) next[j].checked = true;
                                                }
                                                setStackItems(next);
                                            }}
                                            className="mt-1 px-2 py-1 text-xs rounded bg-red-600 hover:bg-red-700 text-white"
                                        >
                                            Add the missing dependencies
                                        </button>
                                    </div>
                                );
                            })()}
                            {stacksLoading ? (
                                <div className="flex items-center justify-center py-4 text-gray-400">
                                    <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {/* Platform-tier templates render as a small
                                        read-only block above the feature checkboxes —
                                        users always get DNS / proxy / auth and can't
                                        opt out. Per the design conversation in #249. */}
                                    {stackItems.some(i => i.tier === 'infrastructure') && (
                                        <div className="p-3 border border-indigo-200 dark:border-indigo-800/60 bg-indigo-50 dark:bg-indigo-900/10 rounded">
                                            <div className="text-[11px] uppercase font-bold text-indigo-700 dark:text-indigo-300 mb-1.5">
                                                Platform · always installed
                                            </div>
                                            <div className="flex flex-wrap gap-1.5">
                                                {stackItems.filter(i => i.tier === 'infrastructure').map(item => (
                                                    <span
                                                        key={item.name}
                                                        className="text-xs font-medium px-2 py-0.5 rounded bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-indigo-200 dark:border-indigo-800/60"
                                                        title={item.description ?? ''}
                                                    >
                                                        {item.name}
                                                    </span>
                                                ))}
                                            </div>
                                            <p className="text-[11px] text-indigo-700/80 dark:text-indigo-300/70 mt-1.5">
                                                DNS, reverse proxy, and SSO are part of every install. Pick your features below.
                                            </p>
                                        </div>
                                    )}
                                    {stackItems.filter(i => i.tier !== 'infrastructure').map((item) => {
                                        // Find this item's index in the master array
                                        // so the checkbox onChange mutates the right
                                        // entry. Filtering only changes render order.
                                        const i = stackItems.findIndex(x => x.name === item.name);
                                        return (
                                        <label key={item.name} className={`flex items-start gap-3 p-3 border rounded transition-colors ${
                                            item.alreadyInstalled
                                                ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/10'
                                                : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer'
                                        }`}>
                                            <input
                                                type="checkbox"
                                                checked={item.checked}
                                                disabled={item.alreadyInstalled}
                                                onChange={() => {
                                                    if (item.alreadyInstalled) return;
                                                    const newItems = [...stackItems];
                                                    newItems[i].checked = !newItems[i].checked;
                                                    // Auto-include hard deps when the operator
                                                    // turns a service ON. Don't auto-uncheck
                                                    // deps when turning OFF — the dep might
                                                    // also be needed by another checked
                                                    // service, and "you unchecked X so Y
                                                    // also went away" is surprising.
                                                    if (newItems[i].checked) {
                                                        const required = SERVICE_DEPS[item.name]?.requires ?? [];
                                                        for (const dep of required) {
                                                            const j = newItems.findIndex(x => x.name === dep);
                                                            if (j >= 0 && !newItems[j].checked && !newItems[j].alreadyInstalled) {
                                                                newItems[j].checked = true;
                                                            }
                                                        }
                                                    }
                                                    setStackItems(newItems);
                                                }}
                                                className="w-5 h-5 mt-0.5 text-blue-600 rounded focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600"
                                            />
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className={`font-medium text-sm ${item.alreadyInstalled ? 'text-gray-400' : 'text-gray-900 dark:text-gray-200'}`}>{item.name}</span>
                                                    {item.alreadyInstalled && (
                                                        <span className="text-xs text-green-600 dark:text-green-400">already installed</span>
                                                    )}
                                                    {/* Static role hint for nginx — every other
                                                        service routes through it for HTTPS subdomain
                                                        access, but spelling that out as a per-service
                                                        "with nginx" badge would clutter ~10 rows.
                                                        Surface the role here instead. */}
                                                    {item.name === 'nginx' && (
                                                        <span
                                                            className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800/60"
                                                            title="Required for HTTPS subdomain access. Every service with a *.<your-domain> subdomain proxies through here."
                                                        >
                                                            public-domain gateway
                                                        </span>
                                                    )}
                                                    {/* Dependency badges. Hard deps in red so the
                                                        operator notices; soft deps muted blue.
                                                        Both labels link explicitly to the dep
                                                        service name so it's obvious what's
                                                        required. */}
                                                    {(SERVICE_DEPS[item.name]?.requires ?? []).map(dep => (
                                                        <span
                                                            key={`req-${dep}`}
                                                            className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800"
                                                            title={`Required dependency: ${dep}${SERVICE_DEPS[item.name]?.reason ? ' — ' + SERVICE_DEPS[item.name]?.reason : ''}`}
                                                        >
                                                            requires {dep}
                                                        </span>
                                                    ))}
                                                    {(SERVICE_DEPS[item.name]?.recommendedWith ?? []).map(dep => (
                                                        <span
                                                            key={`rec-${dep}`}
                                                            className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800/60"
                                                            title={`Optional integration: ${dep}${SERVICE_DEPS[item.name]?.reason ? ' — ' + SERVICE_DEPS[item.name]?.reason : ''}`}
                                                        >
                                                            with {dep}
                                                        </span>
                                                    ))}
                                                </div>
                                                {item.description && (
                                                    <p className={`text-xs mt-0.5 ${item.alreadyInstalled ? 'text-gray-400' : 'text-gray-500 dark:text-gray-400'}`}>
                                                        {item.description}
                                                    </p>
                                                )}
                                            </div>
                                        </label>
                                        );
                                    })}
                                </div>
                            )}

                            {/* Domain prompt is now at the TOP of this step
                                so the operator answers it before scrolling
                                through services. See the block above. */}

                            {/* Detected drives + RAID prompt + clean-install
                                toggle have all moved to the Machine step. */}
                        </>
                    )}

                    {stackInstallStep === 'configure' && (
                        <>
                            {stackNodes.length > 1 && (
                                <div className="mb-4">
                                    <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Target Node</label>
                                    <select
                                        value={stackSelectedNode}
                                        onChange={(e) => setStackSelectedNode(e.target.value)}
                                        className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                                    >
                                        <option value="" disabled>Select a node</option>
                                        {stackNodes.map(n => <option key={n.Name} value={n.Name}>{n.Name}</option>)}
                                    </select>
                                </div>
                            )}

                            {/* Clean-install toggle moved to the Machine
                                step. Show a small reminder if RESET is
                                staged so the operator knows what's about
                                to happen on Install. */}
                            {cleanInstall && cleanInstallConfirm === 'RESET' && (
                                <div className="mb-4 p-2 bg-amber-50 dark:bg-amber-900/20 rounded border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-200">
                                    🧹 Clean install staged: existing service data will be wiped before the new services are deployed.
                                </div>
                            )}
                            {stacksLoading ? (
                                <div className="flex items-center justify-center py-4 text-gray-400">
                                    <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading variables...
                                </div>
                            ) : groupVariablesByTemplate(stackVariables).filter(g => g.key !== '_global').length === 0 ? (
                                <div className="p-3 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 rounded text-sm">
                                    No configuration needed. Ready to install.
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    {/* Tab strip — categorise variables so
                                        the operator isn't staring at a
                                        50-line flat list. Subdomains first
                                        (almost everyone touches them),
                                        Settings second, Ports last (most
                                        operators never touch ports). */}
                                    {(() => {
                                        const groups = groupVariablesByTemplate(stackVariables).filter(g => g.key !== '_global');
                                        const isPortVar = (name: string) => /_PORT$/i.test(name);
                                        const counts = {
                                            subdomains: 0, settings: 0, ports: 0,
                                        };
                                        for (const g of groups) {
                                            for (const v of g.variables) {
                                                if (v.meta?.type === 'subdomain') counts.subdomains++;
                                                else if (isPortVar(v.name)) counts.ports++;
                                                else counts.settings++;
                                            }
                                        }
                                        const tabs = ([
                                            { id: 'subdomains' as ConfigureTab, label: 'Subdomains', count: counts.subdomains },
                                            { id: 'settings' as ConfigureTab,   label: 'Settings',   count: counts.settings },
                                            { id: 'ports' as ConfigureTab,      label: 'Ports',      count: counts.ports },
                                        ] as const).filter(t => t.count > 0);
                                        // If the user hasn't picked a tab yet, default to the first
                                        // tab that actually has variables (so a stack with no
                                        // subdomains lands on Settings, not an empty Subdomains).
                                        const activeTab: ConfigureTab = configureTab ?? (tabs[0]?.id ?? 'settings');
                                        return (
                                            <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
                                                {tabs.map(t => (
                                                    <button
                                                        key={t.id}
                                                        type="button"
                                                        onClick={() => setConfigureTab(t.id)}
                                                        className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
                                                            activeTab === t.id
                                                                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                                                                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                                                        }`}
                                                    >
                                                        {t.label}
                                                        <span className="ml-1.5 text-xs opacity-70">{t.count}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        );
                                    })()}
                                    {(configureTab ?? (groupVariablesByTemplate(stackVariables).filter(g => g.key !== '_global').some(g => g.variables.some(v => v.meta?.type === 'subdomain')) ? 'subdomains' : 'settings')) === 'ports' && (
                                        <p className="text-xs text-gray-500 dark:text-gray-400 italic px-1">
                                            Host-port mappings. Defaults are usually fine — change only if you have a port collision with another service.
                                        </p>
                                    )}
                                <div className="space-y-5 max-h-[50vh] overflow-y-auto">
                                    {groupVariablesByTemplate(stackVariables).filter(g => g.key !== '_global').map(group => {
                                      // Filter group variables by active tab.
                                      const isPortVar = (name: string) => /_PORT$/i.test(name);
                                      const subdomainCountAll = groupVariablesByTemplate(stackVariables).filter(g => g.key !== '_global').reduce((acc, g) => acc + g.variables.filter(v => v.meta?.type === 'subdomain').length, 0);
                                      const tab = configureTab ?? (subdomainCountAll > 0 ? 'subdomains' : 'settings');
                                      const filtered = group.variables.filter(v => {
                                          if (tab === 'subdomains') return v.meta?.type === 'subdomain';
                                          if (tab === 'ports') return isPortVar(v.name);
                                          return v.meta?.type !== 'subdomain' && !isPortVar(v.name);
                                      });
                                      if (filtered.length === 0) return null;
                                      return (
                                      <div key={group.key} className="space-y-3">
                                        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-gray-700 pb-1">{group.label}</h4>
                                        {filtered.map((v) => {
                                            // Humanise the visible label so the operator sees
                                            // "Subdomain" inside "Immich (Photos)" instead of
                                            // SCREAMING_SNAKE_CASE. Strip the group-key prefix
                                            // when it matches, _ → space, lowercase, then
                                            // capitalise the first word. Common abbreviations
                                            // stay uppercase. The raw env-var name still shows
                                            // muted on the right for power users.
                                            const groupPrefix = group.key.toUpperCase().replace(/-/g, '_') + '_';
                                            const stripped = v.name.startsWith(groupPrefix) ? v.name.slice(groupPrefix.length) : v.name;
                                            const KEEP_UPPER = new Set(['DB', 'URL', 'API', 'SSH', 'TLS', 'SSL', 'OIDC', 'DNS', 'IP', 'ID', 'JWT', 'SMTP', 'CSV', 'CSRF', 'NPM', 'LDAP']);
                                            const displayLabel = stripped.split('_').map((w, i) =>
                                                KEEP_UPPER.has(w) ? w : (i === 0 ? w[0] + w.slice(1).toLowerCase() : w.toLowerCase())
                                            ).join(' ');
                                            // Hide redundant descriptions like "Subdomain for
                                            // Immich" when the group label already says Immich.
                                            // Short desc + contains a non-trivial token from
                                            // the group label = redundant.
                                            const groupTokens = (group.label.toLowerCase().match(/[a-z]+/g) ?? []).filter(t => t.length > 3);
                                            const desc = v.meta?.description ?? '';
                                            const isRedundant = desc.length <= 60 && groupTokens.some(t => desc.toLowerCase().includes(t));
                                            return (
                                            <div key={v.name}>
                                                <div className="flex items-baseline justify-between gap-2 mb-1">
                                                    <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 truncate" title={v.name}>
                                                        {displayLabel}
                                                    </label>
                                                    <span className="text-[10px] font-mono text-gray-400 dark:text-gray-500 opacity-50 shrink-0" title="Underlying environment variable">
                                                        {v.name}
                                                    </span>
                                                </div>
                                                {desc && !isRedundant && <p className="text-xs text-gray-500 mb-1">{desc}</p>}
                                                {/* Variable input dispatch — type-specific UI lives in
                                                    <StackVariableField>, shared with InstallerModal since #341. */}
                                                <StackVariableField
                                                    variable={v}
                                                    onChange={(value) => installFlow.setVariableValue(v.name, value)}
                                                    onExposureChange={(exposure) => installFlow.setVariableExposure(v.name, exposure)}
                                                    publicDomain={stackVariables.find(x => x.name === 'PUBLIC_DOMAIN')?.value}
                                                    inputClassName="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md text-sm"
                                                    deviceContext={{
                                                        deviceOptions: stackDeviceOptions,
                                                        loadingDevices: stackLoadingDevices,
                                                        canRefresh: !!stackSelectedNode,
                                                        onRefresh: (devPath) => {
                                                            setStackLoadingDevices(true);
                                                            fetch(`/api/system/devices?node=${stackSelectedNode}&path=${encodeURIComponent(devPath)}`)
                                                                .then(r => r.json())
                                                                .then(data => { setStackDeviceOptions(prev => ({ ...prev, [devPath]: data.devices || [] })); setStackLoadingDevices(false); })
                                                                .catch(() => setStackLoadingDevices(false));
                                                        },
                                                    }}
                                                />
                                            </div>
                                            );
                                        })}
                                      </div>
                                      );
                                    })}
                                </div>
                                </div>
                            )}
                        </>
                    )}

                    {(stackInstallStep === 'installing' || stackInstallStep === 'done') && (() => {
                        // Per-service status strip — REAL state from the digital twin,
                        // not log parsing. Service counts as "deployed" only when its
                        // systemd unit reports active; "installing" comes from the
                        // hook's `installingNow` + log parsing for "Installing X..."
                        // until the twin catches up; "failed" if either the deploy
                        // log says ❌ or the twin reports the unit inactive after
                        // deploy completed.
                        const installItems = stackItems.filter(i => i.checked && !i.alreadyInstalled);
                        const joined = stackLogs.join('\n');
                        const node = stackSelectedNode || 'Local';
                        const twinNode = digitalTwin?.nodes?.[node];
                        const twinServices = twinNode?.services ?? [];
                        const findService = (name: string) =>
                            twinServices.find(s => s.name === name || s.name === `${name}.service` || s.name?.replace(/\.service$/, '') === name);
                        const statusOf = (name: string): 'pending' | 'installing' | 'deployed' | 'failed' => {
                            const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            if (installingNow === name) return 'installing';
                            if (new RegExp(`(?:❌|✗|Failed to install)\\s+${esc}\\b`, 'i').test(joined)) return 'failed';
                            const svc = findService(name);
                            if (svc) {
                                if (svc.active) return 'deployed';
                                if (new RegExp(`Installing\\s+${esc}\\.\\.\\.`, 'i').test(joined)) return 'installing';
                                if (new RegExp(`✅\\s+${esc}\\s+deployed\\b`, 'i').test(joined)) return 'installing';
                                return 'pending';
                            }
                            if (new RegExp(`(?:Installing\\s+|✅\\s+)${esc}`, 'i').test(joined)) return 'installing';
                            return 'pending';
                        };
                        const dotClass: Record<string, string> = {
                            pending:    'bg-gray-300 dark:bg-gray-600',
                            installing: 'bg-blue-500 animate-pulse',
                            deployed:   'bg-emerald-500',
                            failed:     'bg-red-500',
                        };
                        const counts = installItems.reduce<Record<string, number>>((a, i) => {
                            const s = statusOf(i.name);
                            a[s] = (a[s] ?? 0) + 1;
                            return a;
                        }, {});
                        const statusStrip = installItems.length === 0 ? null : (
                            <div className="mb-3 p-3 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-900/40">
                                <div className="flex items-center justify-between mb-2">
                                    <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Service status</p>
                                    <p className="text-[11px] text-gray-500 dark:text-gray-400">
                                        {counts.deployed ?? 0}/{installItems.length} deployed
                                        {counts.failed ? ` · ${counts.failed} failed` : ''}
                                    </p>
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    {installItems.map(item => {
                                        const s = statusOf(item.name);
                                        return (
                                            <span
                                                key={item.name}
                                                className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border ${
                                                    s === 'pending'
                                                        ? 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 opacity-70'
                                                        : s === 'failed'
                                                            ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
                                                            : s === 'deployed'
                                                                ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300'
                                                                : 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                                                }`}
                                                title={`${item.name}: ${s}`}
                                            >
                                                <span className={`w-2 h-2 rounded-full ${dotClass[s]}`}></span>
                                                {item.name}
                                            </span>
                                        );
                                    })}
                                </div>
                            </div>
                        );

                        // Done-screen extras: self-test verdict (auto-runs on
                        // phase=done, see effect above) + DNS/SSL/access-list
                        // next-step panels when the install produced any proxy
                        // routes. Rendered via the StackInstallSummary slot below.
                        const domain = stackVariables.find(v => v.name === 'PUBLIC_DOMAIN')?.value;
                        const subdomains = stackVariables.filter(v => v.meta?.type === 'subdomain' && v.value);
                        const hasProxyRoutes = !!domain && subdomains.length > 0;
                        const diagCounts = (diagnoseProbes ?? []).reduce<Record<ProbeStatus, number>>(
                            (a, p) => { a[p.status] = (a[p.status] ?? 0) + 1; return a; },
                            { ok: 0, warn: 0, fail: 0, info: 0 },
                        );
                        const overall: ProbeStatus = diagCounts.fail > 0 ? 'fail' : diagCounts.warn > 0 ? 'warn' : diagCounts.ok > 0 ? 'ok' : 'info';
                        const overallStyle = {
                            ok:   { bg: 'bg-emerald-50 dark:bg-emerald-900/20', border: 'border-emerald-200 dark:border-emerald-800', text: 'text-emerald-800 dark:text-emerald-200', label: 'Self-test passed' },
                            warn: { bg: 'bg-amber-50 dark:bg-amber-900/20',     border: 'border-amber-200 dark:border-amber-800',     text: 'text-amber-800 dark:text-amber-200',     label: 'Self-test: warnings' },
                            fail: { bg: 'bg-red-50 dark:bg-red-900/20',         border: 'border-red-200 dark:border-red-800',         text: 'text-red-800 dark:text-red-200',         label: 'Self-test: failures' },
                            info: { bg: 'bg-gray-50 dark:bg-gray-900/40',       border: 'border-gray-200 dark:border-gray-800',       text: 'text-gray-700 dark:text-gray-200',       label: 'Self-test: indeterminate' },
                        }[overall];
                        const doneFooter = (
                            <>
                                <div className={`p-3 rounded border text-sm ${overallStyle.bg} ${overallStyle.border}`}>
                                    <div className="flex items-center justify-between mb-1.5">
                                        <p className={`font-medium ${overallStyle.text}`}>
                                            {diagnoseRunning
                                                ? '⏳ Running self-test…'
                                                : diagnoseError
                                                    ? '⚠️ Self-test failed to run'
                                                    : `${overall === 'ok' ? '✅' : overall === 'warn' ? '⚠️' : overall === 'fail' ? '❌' : 'ℹ️'} ${overallStyle.label}${diagnoseProbes ? ` — ${diagCounts.ok} ok · ${diagCounts.warn} warn · ${diagCounts.fail} fail` : ''}`}
                                        </p>
                                        <button
                                            type="button"
                                            onClick={() => { setDiagnoseRanOnce(false); }}
                                            disabled={diagnoseRunning}
                                            className="text-xs px-2 py-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                                            title="Re-run self-test"
                                        >
                                            {diagnoseRunning ? 'Running…' : 'Run again'}
                                        </button>
                                    </div>
                                    {diagnoseError && (
                                        <p className="text-xs text-red-700 dark:text-red-300">{diagnoseError}</p>
                                    )}
                                    {diagnoseProbes && (diagCounts.warn > 0 || diagCounts.fail > 0) && (
                                        <details className="mt-1 text-xs">
                                            <summary className={`cursor-pointer ${overallStyle.text}`}>Details ({diagCounts.warn + diagCounts.fail} issue{diagCounts.warn + diagCounts.fail === 1 ? '' : 's'})</summary>
                                            <ul className="mt-1 space-y-1.5">
                                                {diagnoseProbes.filter(p => p.status === 'warn' || p.status === 'fail').map(p => (
                                                    <li key={p.id} className="border-l-2 border-current pl-2 opacity-90">
                                                        <div className="font-semibold">{p.status === 'fail' ? '❌' : '⚠️'} {p.label}</div>
                                                        <div className="font-mono whitespace-pre-wrap break-words">{p.detail}</div>
                                                        {p.hint && <div className="italic mt-0.5 opacity-90">💡 {p.hint}</div>}
                                                    </li>
                                                ))}
                                            </ul>
                                        </details>
                                    )}
                                    <p className={`text-xs mt-1 ${overallStyle.text} opacity-70`}>
                                        Re-run any time at <span className="font-mono">Health → Self-Diagnose</span>.
                                    </p>
                                </div>
                                {hasProxyRoutes && (
                                    <>
                                        <div className="p-2.5 bg-blue-50 dark:bg-blue-900/20 rounded border border-blue-200 dark:border-blue-800 text-sm space-y-1.5">
                                            <p className="font-medium text-blue-800 dark:text-blue-200">1. Configure DNS</p>
                                            <p className="text-xs text-blue-700 dark:text-blue-300">
                                                Create A records pointing to your server IP:
                                            </p>
                                            <div className="font-mono text-xs text-blue-600 dark:text-blue-400 space-y-0.5">
                                                {subdomains.map(sv => (
                                                    <div key={sv.name}>{sv.value}.{domain} &rarr; {'<SERVER-IP>'}</div>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="p-2.5 bg-amber-50 dark:bg-amber-900/20 rounded border border-amber-200 dark:border-amber-800 text-sm space-y-1.5">
                                            <p className="font-medium text-amber-800 dark:text-amber-200">2. SSL Certificates</p>
                                            <p className="text-xs text-amber-700 dark:text-amber-300">
                                                Open Nginx Proxy Manager and request Let&apos;s Encrypt SSL certificates for each proxy host.
                                            </p>
                                        </div>
                                        <div className="p-2.5 bg-gray-50 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 text-sm space-y-1.5">
                                            <p className="font-medium text-gray-800 dark:text-gray-200">3. Access Restrictions (recommended)</p>
                                            <p className="text-xs text-gray-600 dark:text-gray-400">
                                                In NPM, add IP-based access lists for admin services (Nginx Admin, AdGuard) to restrict LAN-only access.
                                            </p>
                                        </div>
                                    </>
                                )}
                                {!hasProxyRoutes && installFlow.credentialsManifest.length === 0 && (
                                    <p className="text-sm text-green-600 dark:text-green-400 font-medium">
                                        Stack installation complete.
                                    </p>
                                )}
                            </>
                        );
                        return (
                            <div>
                                <StackInstallProgress controller={installFlow} beforeLog={statusStrip} />
                                {stackInstallStep === 'done' && (
                                    <StackInstallSummary controller={installFlow} doneFooter={doneFooter} />
                                )}
                            </div>
                        );
                    })()}
                </div>
            )}

            {currentStep === 'finish' && (
                 <div className="text-center py-8 space-y-4">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 mb-4">
                        <CheckCircle className="w-8 h-8" />
                    </div>
                    <h3 className="text-2xl font-bold">You&apos;re all set!</h3>
                    <p className="text-gray-600 dark:text-gray-300 max-w-sm mx-auto">
                        ServiceBay is configured and ready to use. Any settings can be changed later in the Settings menu.
                    </p>
                 </div>
            )}

        </div>

        {/* Footer */}
        <div className="p-4 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 flex justify-between items-center">
            {stacksOnlyMode ? (
                // Stacks-only mode: left side is empty (sub-step back buttons are in the right side)
                <div />
            ) : currentStep === 'welcome' ? (
                showSkipConfirm ? (
                    <div className="flex items-center gap-2">
                        <button
                          onClick={handleSkip}
                          className="px-3 py-1.5 text-sm text-red-600 hover:text-red-700 dark:text-red-400 font-medium"
                        >
                            Yes, skip
                        </button>
                        <button
                          onClick={() => setShowSkipConfirm(false)}
                          className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                        >
                            Back
                        </button>
                        <span className="text-xs text-gray-400">You can configure later in Settings.</span>
                    </div>
                ) : (
                    <button
                      onClick={() => setShowSkipConfirm(true)}
                      className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 flex items-center gap-1"
                    >
                        <SkipForward className="w-4 h-4" /> Skip Setup
                    </button>
                )
            ) : (
                <button
                  onClick={handleBack}
                  className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                >
                    Back
                </button>
            )}

            {currentStep === 'welcome' && (
                <Button onClick={handleSaveWelcome} disabled={loading}>
                    {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    Next <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
            )}

            {/* Step specific primary actions */}
            {currentStep === 'network' && <Button onClick={handleSaveNetwork} disabled={loading}>{loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} {selection.gateway ? 'Save & Next' : 'Continue'}</Button>}
            {currentStep === 'email' && <Button onClick={handleSaveEmail} disabled={loading}>{loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save Email</Button>}

            {/* Express install footer: Install kicks off the full
                pipeline (full-stack defaults), Edit drops into the
                explicit machine step for per-row control. */}
            {currentStep === 'install-confirm' && (
                <div className="flex gap-2 items-center">
                    <button
                        type="button"
                        onClick={() => navigateTo('machine')}
                        className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                    >
                        Edit details
                    </button>
                    {!stackDomain.trim() && !stackNoDomain && (
                        <span className="text-xs text-amber-700 dark:text-amber-300">Enter a domain or check LAN-only.</span>
                    )}
                    {installMode === 'public' && stackDomain.trim() && !isValidOperatorEmail(operatorEmail) && (
                        <span className="text-xs text-amber-700 dark:text-amber-300">{operatorEmailIssue(operatorEmail)}.</span>
                    )}
                    {cleanInstall && cleanInstallConfirm !== 'RESET' && (
                        <span className="text-xs text-amber-700 dark:text-amber-300">Type RESET to confirm clean install.</span>
                    )}
                    <Button
                        onClick={handleExpressInstall}
                        disabled={
                            (!stackDomain.trim() && !stackNoDomain)
                            || (installMode === 'public' && !isValidOperatorEmail(operatorEmail))
                            || (cleanInstall && cleanInstallConfirm !== 'RESET')
                            || availableStacks.length === 0
                        }
                    >
                        {cleanInstall ? 'Reset & Install' : 'Install Stack'}
                    </Button>
                </div>
            )}

            {/* Machine step gates Continue on the same domain choice the
                services sub-step used to gate, plus a RESET-typed
                confirmation if clean install is checked. */}
            {currentStep === 'machine' && (
                <div className="flex gap-2 items-center">
                    {!stackDomain.trim() && !stackNoDomain && (
                        <span className="text-xs text-amber-700 dark:text-amber-300">Set a public domain (or check the LAN-only box) to continue.</span>
                    )}
                    {installMode === 'public' && stackDomain.trim() && !isValidOperatorEmail(operatorEmail) && (
                        <span className="text-xs text-amber-700 dark:text-amber-300">{operatorEmailIssue(operatorEmail)}.</span>
                    )}
                    {cleanInstall && cleanInstallConfirm !== 'RESET' && (
                        <span className="text-xs text-amber-700 dark:text-amber-300">Type RESET to confirm the clean install.</span>
                    )}
                    <Button
                        onClick={handleNext}
                        disabled={
                            (!stackDomain.trim() && !stackNoDomain)
                            || (installMode === 'public' && !isValidOperatorEmail(operatorEmail))
                            || (cleanInstall && cleanInstallConfirm !== 'RESET')
                        }
                    >
                        Continue <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                </div>
            )}

            {currentStep === 'stacks' && stackInstallStep === 'select' && (
                <Button onClick={handleStackSkip}>Skip <ArrowRight className="w-4 h-4 ml-2" /></Button>
            )}
            {currentStep === 'stacks' && stackInstallStep === 'services' && (
                <div className="flex gap-2 items-center">
                    <button onClick={() => { setWizardSubStep('select'); setSelectedStack(null); installFlow.reset(); }} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Back</button>
                    <Button
                        onClick={() => { void handleStackFetchVars(); }}
                        disabled={
                            stackItems.filter(i => i.checked).length === 0
                            || stacksLoading
                        }
                    >
                        {stacksLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} Continue
                    </Button>
                </div>
            )}
            {currentStep === 'stacks' && stackInstallStep === 'configure' && (
                <div className="flex gap-2">
                    <button onClick={() => { setWizardSubStep('services'); installFlow.reset(); }} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Back</button>
                    <Button
                        onClick={() => { void handleStackInstall(); }}
                        disabled={(!stackSelectedNode && stackNodes.length > 1)}
                    >
                        {cleanInstall ? 'Reset & Install' : 'Install Stack'}
                    </Button>
                </div>
            )}
            {currentStep === 'stacks' && stackInstallStep === 'installing' && (
                <Button disabled><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Installing...</Button>
            )}
            {currentStep === 'stacks' && stackInstallStep === 'done' && (
                <Button onClick={stacksOnlyMode ? handleFinish : handleNext}>
                    {stacksOnlyMode ? <><CheckCircle className="w-4 h-4 mr-2" /> Finish</> : <>Continue <ArrowRight className="w-4 h-4 ml-2" /></>}
                </Button>
            )}

            {currentStep === 'finish' && (
                <Button onClick={handleFinish}>
                    <CheckCircle className="w-4 h-4 mr-2" />
                    Finish Setup
                </Button>
            )}
        </div>

      </div>
    </div>
  );
}

// -- Helper Components --

interface ToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    icon: React.ElementType;
    color: string;
    title: string;
    desc: string;
}

function Toggle({ checked, onChange, icon: Icon, color, title, desc }: ToggleProps) {
    return (
        <div 
            onClick={() => onChange(!checked)}
            className={`flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                checked 
                 ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800' 
                 : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
        >
            <div className={`mt-0.5 ${checked ? color : 'text-gray-400'}`}>
                <Icon className="w-5 h-5" />
            </div>
            <div className="flex-1">
                <div className={`font-medium text-sm ${checked ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500'}`}>{title}</div>
                <div className="text-xs text-gray-500">{desc}</div>
            </div>
            <div className={`w-5 h-5 rounded-full border flex items-center justify-center ${
                checked ? 'bg-blue-600 border-blue-600' : 'border-gray-300 dark:border-gray-600'
            }`}>
                {checked && <CheckCircle className="w-3.5 h-3.5 text-white" />}
            </div>
        </div>
    )
}

interface InputProps {
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    type?: string;
    hint?: string;
    error?: string;
}

function Input({ label, value, onChange, placeholder, type = 'text', hint, error }: InputProps) {
   return (
      <div>
        <label className="block text-xs font-medium text-gray-500 uppercase mb-1">{label}</label>
        <input
            type={type}
            className={`w-full px-3 py-2 bg-white dark:bg-gray-900 border rounded-md focus:ring-2 focus:ring-blue-500 outline-none text-sm ${
                error ? 'border-red-400 dark:border-red-600' : 'border-gray-300 dark:border-gray-700'
            }`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
        />
        {hint && !error && <p className="text-[11px] text-gray-400 mt-1">{hint}</p>}
        {error && <p className="text-[11px] text-red-500 mt-1">{error}</p>}
    </div>
   )
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

function Button({ children, onClick, disabled, className, ...props }: ButtonProps) {
    return (
        <button 
            onClick={onClick} 
            disabled={disabled}
            className={`px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-medium text-sm flex items-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
            {...props}
        >
            {children}
        </button>
    )
}


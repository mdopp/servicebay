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
import { fetchTemplates, fetchReadme, fetchTemplateYaml, fetchTemplateVariables, fetchTemplateConfigFiles, fetchTemplatePostDeployScript } from '@/app/actions';
import { getNodes } from '@/app/actions/system';
import { Template, VariableMeta } from '@/lib/registry';
import {
  runPostInstall,
  configureProxyRoutes as sharedConfigureProxyRoutes,
} from '@/lib/stackInstall/postInstall';
import { groupVariablesByTemplate } from '@/lib/stackInstall/groupVariables';
import { buildCredentialsManifest, buildBitwardenCsv } from '@/lib/stackInstall/credentialsManifest';
import Mustache from 'mustache';

import { Loader2, Monitor, Network, Key, CheckCircle, ArrowRight, SkipForward, RefreshCw, Box, Mail, Layers, Package, Globe, HardDrive } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import { useDigitalTwin } from '@/hooks/useDigitalTwin';

// Steps definition
type WizardStep = 'welcome' | 'network' | 'stacks' | 'email' | 'finish';

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

interface Variable {
  name: string;
  value: string;
  global?: boolean;
  meta?: VariableMeta;
}

function generateSecret(length = 32): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
    .map(b => chars[b % chars.length])
    .join('');
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
  const [selectedStack, setSelectedStack] = useState<Template | null>(null);
  const [stackItems, setStackItems] = useState<StackItem[]>([]);
  const [stackVariables, setStackVariables] = useState<Variable[]>([]);
  const [stackInstallStep, setStackInstallStep] = useState<'select' | 'services' | 'configure' | 'installing' | 'done'>('select');
  const [stackLogs, setStackLogs] = useState<string[]>([]);
  const [stackNodes, setStackNodes] = useState<{ Name: string; URI: string }[]>([]);
  const [stackSelectedNode, setStackSelectedNode] = useState('');
  const [stacksLoading, setStacksLoading] = useState(false);
  const [stackDomain, setStackDomain] = useState('');
  // Operator can opt out of providing a public domain. When true, services
  // are deployed in LAN-only mode (no SSL, accessible only by IP+port). The
  // wizard's "Continue" button is gated until either a domain is set or
  // this flag is checked, so the operator can't accidentally finish without
  // making a deliberate choice.
  const [stackNoDomain, setStackNoDomain] = useState(false);
  const [stackDeviceOptions, setStackDeviceOptions] = useState<Record<string, string[]>>({});
  const [stackLoadingDevices, setStackLoadingDevices] = useState(false);

  // RAID detection
  const [raidArrays, setRaidArrays] = useState<{ device: string; label: string; fstype: string; size: string; mountpoint: string | null; degraded: boolean }[]>([]);
  const [raidMounting, setRaidMounting] = useState(false);
  const [raidMounted, setRaidMounted] = useState(false);

  // Track whether we're in stacks-only mode (post-install first boot)
  const [stacksOnlyMode, setStacksOnlyMode] = useState(false);

  // NPM credentials (shown when default auth fails during proxy setup).
  // Empty defaults — the prompt pre-fills from stackVariables when it opens.
  const [npmCredPrompt, setNpmCredPrompt] = useState(false);
  const [npmEmail, setNpmEmail] = useState('');
  const [npmPassword, setNpmPassword] = useState('');

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

  // Sentinel at the bottom of the install log. The single scrollbar lives on
  // the modal body, so when new log lines append we scrollIntoView this
  // anchor to bring the latest text under the user's eyes without their
  // having to manually scroll the modal.
  const logTailRef = useRef<HTMLDivElement | null>(null);

  // Track which service is currently mid-deploy. The deploy loop sets
  // this before the API call and clears after — the install-progress
  // strip below reads this to show "installing" while the API is in
  // flight, falling back to digital-twin live state for everything else.
  const [installingNow, setInstallingNow] = useState<string | null>(null);

  // Live container/service state from the agent. The status strip
  // ABOVE the log panel uses this — NOT log-parsing — so a service
  // counts as "deployed" only when its container is actually Up, not
  // when the deploy API just returned. (Earlier log-parsing version
  // showed "12/12 deployed" while NPM was still pulling its image.)
  const { data: digitalTwin } = useDigitalTwin();

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

  // Clean install — wipe existing service data before deploying.
  const [cleanInstall, setCleanInstall] = useState(false);
  const [cleanInstallConfirm, setCleanInstallConfirm] = useState('');

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
        // Setup was completed by installer, but stacks haven't been chosen yet
        setStacksOnlyMode(true);
        setCurrentStep('stacks');
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

  // Keep the install log tail in view as new lines arrive. Only fires while
  // the install is actually streaming — not during 'done' or other steps —
  // so the modal doesn't snap-jump on unrelated re-renders. Guard the call
  // because jsdom (and some older browsers) don't implement scrollIntoView.
  useEffect(() => {
    if (stackInstallStep !== 'installing') return;
    const el = logTailRef.current;
    if (typeof el?.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [stackLogs, stackInstallStep]);

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
      setStackNodes(nodes);
      if (nodes.length === 1) setStackSelectedNode(nodes[0].Name);
    } catch {
      // Stacks not available yet, that's OK
      setAvailableStacks([]);
    } finally {
      setStacksLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentStep === 'stacks' && availableStacks.length === 0 && !stacksLoading) {
      loadStacks();
    }
  }, [currentStep, availableStacks.length, stacksLoading, loadStacks]);

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
      const order: WizardStep[] = ['welcome', 'network', 'stacks', 'email', 'finish'];

      // network step covers both Gateway and Remote Access (SSH key) — show
      // it if either was selected on the welcome screen.
      const activeSteps = order.filter(step => {
         if (step === 'welcome' || step === 'finish') return true;
         if (step === 'network') return selection.gateway || selection.ssh;
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
      setStackVariables(prev => {
        let changed = false;
        const next = prev.map(v => {
          if (v.meta?.type !== 'device' || v.value) return v;
          const path = v.meta?.devicePath || '/dev/serial/by-id';
          const devices = opts[path] ?? [];
          if (devices.length === 1) {
            changed = true;
            return { ...v, value: devices[0] };
          }
          return v;
        });
        return changed ? next : prev;
      });
    });
  }, [stackSelectedNode, stackVariables]);

  // Detect unmounted RAID arrays when node is selected
  useEffect(() => {
    if (!stackSelectedNode || raidMounted) return;
    fetch(`/api/system/storage?node=${stackSelectedNode}`)
      .then(r => r.ok ? r.json() : { raids: [] })
      .then(data => setRaidArrays((data.raids || []).filter((r: { mountpoint: string | null }) => !r.mountpoint)))
      .catch(() => setRaidArrays([]));
  }, [stackSelectedNode, raidMounted]);

  // -- Stack Handlers --

  const handleSelectStack = async (stack: Template) => {
    setSelectedStack(stack);
    setStackInstallStep('services');
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
            checked: !isInstalled && match[1].toLowerCase() === 'x',
            alreadyInstalled: isInstalled,
          });
        }
      });
      setStackItems(parsedItems);
    } catch {
      setStackItems([]);
    } finally {
      setStacksLoading(false);
    }
  };

  const handleStackFetchVars = async () => {
    setStackInstallStep('configure');
    setStacksLoading(true);

    const selected = stackItems.filter(i => i.checked && !i.alreadyInstalled);
    const vars = new Set<string>();
    const newItems = [...stackItems];
    const allMeta: Record<string, VariableMeta> = {};

    let globalSettings: Record<string, string> = {};
    try {
      const settingsRes = await fetch('/api/settings');
      if (settingsRes.ok) {
        const settings = await settingsRes.json();
        globalSettings = settings.templateSettings || {};
        // The install script can pre-bake reverseProxy.publicDomain into
        // config.json — pull it here so the wizard's domain prompt shows
        // it as default and the user doesn't have to retype it.
        const bakedDomain = settings.reverseProxy?.publicDomain;
        if (bakedDomain && !stackDomain) {
          setStackDomain(bakedDomain);
        }
      }
    } catch { /* use empty defaults */ }

    for (const item of selected) {
      try {
        const yaml = await fetchTemplateYaml(item.name, selectedStack?.source || 'Built-in');
        if (!yaml) continue;
        const idx = newItems.findIndex(i => i.name === item.name);
        if (idx !== -1) newItems[idx].yaml = yaml;
        const matches = yaml.matchAll(/\{\{\s*([\w\d_]+)\s*\}\}/g);
        for (const match of matches) vars.add(match[1]);
        const meta = await fetchTemplateVariables(item.name, selectedStack?.source || 'Built-in');
        if (meta) {
          // First template that declares a variable owns it for grouping —
          // shared vars (LLDAP_ADMIN_PASSWORD, LLDAP_HOST, ...) live under
          // the originator and are inherited by other templates' YAMLs.
          for (const [key, value] of Object.entries(meta)) {
            if (!allMeta[key]) {
              allMeta[key] = { ...value, templateName: item.name };
            }
          }
        }

        // Fetch extra config files (.mustache) and resolve target paths from YAML volumes.
        // We parse the YAML properly so multi-container pods (e.g. file-share with
        // syncthing+samba+filebrowser) can map a config file to the correct
        // hostPath even when the same `/config` mountPath appears in multiple
        // volumeMounts. The previous index-based regex lined up only when each
        // volume had exactly one mount — fragile and broken for merged stacks.
        const cfgFiles = await fetchTemplateConfigFiles(item.name, selectedStack?.source || 'Built-in');
        if (cfgFiles.length > 0) {
          // Build name→hostPath map from the volumes section, then mountPath→hostPath
          // by chasing the `name` reference on each volumeMount across all containers.
          const nameToHostPath = new Map<string, string>();
          const mountPathToHostPath = new Map<string, string>();
          // YAML-parse the template so we can chase volume names instead of
          // doing fragile regex matching. Mustache placeholders need to be
          // pre-escaped (raw {{X}} isn't valid YAML in some positions like
          // `containerPort: {{X}}`), but we can't just substitute them with
          // junk values — earlier versions replaced `{{X}}` with `0`, which
          // poisoned the host-path strings: `path: {{DATA_DIR}}/auth/...`
          // became `path: 0/auth/...`, and the resolver then computed
          // targetPath = "0/auth/authelia-config/configuration.yml" — a
          // RELATIVE path the agent's mkdir resolved under ~, leaving the
          // actual /mnt/data/stacks/auth/authelia-config/ empty for
          // authelia to fill with its 71KB upstream-sample default. Live-
          // debugged this exact pathology twice.
          //
          // Round-trip the placeholders: encode `{{X}}` to a YAML-safe
          // sentinel that preserves the variable name, parse, then decode
          // back to `{{X}}` in the extracted strings. Mustache.render at
          // deploy time resolves them with the user's actual values.
          const SENTINEL_RE_OUT = /\{\{\s*([\w\d_]+)\s*\}\}/g;
          const SENTINEL_RE_IN = /__SBVAR_([\w\d_]+)__/g;
          const safeYaml = yaml.replace(SENTINEL_RE_OUT, (_m, n) => `__SBVAR_${n}__`);
          const restorePlaceholders = (s: string): string =>
            s.replace(SENTINEL_RE_IN, (_m, n) => `{{${n}}}`);
          // Multi-doc support — file-share ships Pod + PVC since 3.6.4.
          // js-yaml's `load()` throws on multi-doc, so use `loadAll`.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let docs: any[] = [];
          try {
            docs = (await import('js-yaml')).loadAll(safeYaml);
          } catch {
            docs = [];
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const doc = docs.find((d: any) => d?.kind === 'Pod') ?? docs[0];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const volumes: any[] = doc?.spec?.volumes ?? [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const containers: any[] = doc?.spec?.containers ?? [];
          const annotations: Record<string, string> = doc?.metadata?.annotations ?? {};
          for (const v of volumes) {
            if (typeof v?.name === 'string' && typeof v?.hostPath?.path === 'string') {
              // Restore {{VAR}} placeholders that we sentinel-encoded for
              // YAML parsing. The deploy step's Mustache.render then
              // expands them against the wizard's view.
              nameToHostPath.set(v.name, restorePlaceholders(v.hostPath.path));
            }
          }
          for (const c of containers) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const m of (c?.volumeMounts ?? []) as any[]) {
              if (typeof m?.mountPath === 'string' && typeof m?.name === 'string') {
                const hp = nameToHostPath.get(m.name);
                if (hp && !mountPathToHostPath.has(m.mountPath)) {
                  mountPathToHostPath.set(m.mountPath, hp);
                }
              }
            }
          }
          // Honour an explicit `servicebay.config-mount` annotation; templates
          // whose config dir isn't `/config` (e.g. AdGuard mounts
          // `/opt/adguardhome/conf`) declare their target this way.
          const explicitMount = annotations['servicebay.config-mount'];
          for (const cf of cfgFiles) {
            let hp: string | undefined;
            if (explicitMount) {
              hp = mountPathToHostPath.get(explicitMount);
            }
            if (!hp) {
              for (const [mp, h] of mountPathToHostPath.entries()) {
                if (mp === '/config' || mp.endsWith('/config') || mp.endsWith('/conf')) {
                  hp = h;
                  break;
                }
              }
            }
            if (hp) cf.targetPath = `${hp}/${cf.filename}`;
            // Also extract variables from config file templates
            const cfgMatches = cf.content.matchAll(/\{\{\s*([\w\d_]+)\s*\}\}/g);
            for (const m of cfgMatches) vars.add(m[1]);
          }
          if (idx !== -1) newItems[idx].configFiles = cfgFiles;
        }
      } catch { /* skip */ }
    }

    for (const key of Object.keys(allMeta)) vars.add(key);

    setStackItems(newItems);
    const resolvedVars = Array.from(vars).map(v => {
      const meta = allMeta[v];
      let value = globalSettings[v] || '';
      let isGlobal = !!globalSettings[v];
      // Pre-fill PUBLIC_DOMAIN from the domain prompt and hide it
      if (v === 'PUBLIC_DOMAIN' && stackDomain) { value = stackDomain; isGlobal = true; }
      // Auto-fill LLDAP_HOST — always localhost when installing in the same stack
      if (v === 'LLDAP_HOST') { value = 'localhost'; isGlobal = true; }
      if (!value && meta?.default) value = meta.default;
      if (!value && meta?.type === 'secret') value = generateSecret();
      return { name: v, value, global: isGlobal, meta };
    });
    // Async fill for rsa-private types — needs server-side crypto.generateKeyPair.
    // The PEM is pre-indented with 10 spaces so it can be dropped under a
    // YAML `key: |` block scalar without further mustache gymnastics.
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
      } catch { /* leave empty — install will fail with a clearer error */ }
    }));
    // Async fill for bcrypt types — derives from another variable's plaintext
    // (e.g. ADGUARD_ADMIN_PASSWORD_HASH ← bcrypt(ADGUARD_ADMIN_PASSWORD)).
    // Runs after the secret pass above so the source value is already populated.
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
    // Auto-derive VAULTWARDEN_DOMAIN from subdomain + PUBLIC_DOMAIN
    const pubDomain = resolvedVars.find(v => v.name === 'PUBLIC_DOMAIN')?.value;
    const vwSub = resolvedVars.find(v => v.name === 'VAULTWARDEN_SUBDOMAIN')?.value;
    if (pubDomain && vwSub) {
      const vwDomain = resolvedVars.find(v => v.name === 'VAULTWARDEN_DOMAIN');
      if (vwDomain) { vwDomain.value = `https://${vwSub}.${pubDomain}`; vwDomain.global = true; }
    }
    setStackVariables(resolvedVars);
    setStacksLoading(false);
  };

  const handleStackInstall = async () => {
    setStackInstallStep('installing');
    setStackLogs([]);

    // Optional: wipe existing service data before deploying.
    if (cleanInstall && cleanInstallConfirm === 'RESET') {
      setStackLogs(prev => [...prev, '🧹 Clean install — wiping existing service data...']);
      try {
        const res = await fetch('/api/system/stacks/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: 'RESET', node: stackSelectedNode || undefined }),
        });
        const data = await res.json();
        if (res.ok) {
          const removed = data.deleted?.length ?? 0;
          setStackLogs(prev => [...prev, `✅ Reset done — removed ${removed} service${removed === 1 ? '' : 's'}, wiped ${data.dataDir}.`]);
          if (data.failed?.length) {
            setStackLogs(prev => [...prev, `⚠️ Some services could not be cleanly removed: ${data.failed.map((f: { name: string }) => f.name).join(', ')}`]);
          }
        } else {
          setStackLogs(prev => [...prev, `⚠️ Reset failed: ${data.error || 'unknown error'}. Continuing with install — existing data may remain.`]);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown error';
        setStackLogs(prev => [...prev, `⚠️ Reset call failed: ${msg}. Continuing with install.`]);
      }
    }

    const selected = stackItems.filter(i => i.checked);

    // Track which services actually deployed cleanly. The post-install
    // pipeline (NPM bootstrap, LLDAP/ABS/Navidrome/FileBrowser admin
    // seeding, OIDC client registration) iterates this list instead of
    // the user's *intended* selection \u2014 without this, a failed deploy
    // (e.g. the wizard's defensive guard refusing a misconfigured
    // file-share) still kicked off the FileBrowser seeder which then
    // hung for 3 min on a container that was never going to start.
    const deployed: { name: string; checked: boolean }[] = [];

    // Templates that supplied a post-deploy.py \u2014 for those we skip the
    // hardcoded helpers in postInstall.ts (the script handles credentials,
    // admin seeding, etc. for that service). See templates/<name>/post-deploy.py
    // and the script-protocol comment in lib/registry.ts.
    const templatesWithScript = new Set<string>();

    // Credentials parsed from `__SB_CREDENTIAL__ {json}` markers the scripts
    // emit on stdout \u2014 appended to the SAVE-THESE-NOW banner at the end.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scriptCredentials: any[] = [];

    for (const item of selected) {
      // Skip already-installed services
      if (item.alreadyInstalled) {
        setStackLogs(prev => [...prev, `\u2705 ${item.name} already installed, skipping.`]);
        deployed.push({ name: item.name, checked: true });
        continue;
      }
      if (!item.yaml) continue;
      setStackLogs(prev => [...prev, `Installing ${item.name}...`]);
      setInstallingNow(item.name);

      const view = stackVariables.reduce((acc, v) => ({ ...acc, [v.name]: v.value }), {});
      // Disable HTML escaping for all Mustache renders (YAML + config files)
      const savedEscape = Mustache.escape;
      Mustache.escape = (text: string) => text;
      const content = Mustache.render(item.yaml, view);

      const kubeContent = `[Kube]\nYaml=${item.name}.yml\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target`;

      // Render extra config files (.mustache) with the same variables.
      // First sanity-check that every {{VAR}} the config references has a
      // value in the view — Mustache renders an undefined var as empty
      // string by default, which is exactly how the user's auth pod ended
      // up with a configuration.yml that loaded but had session.cookies
      // and storage.* collapsed to empty (authelia rejected it and the
      // pod crash-looped, with no breadcrumb back to the wizard step
      // that produced the broken config). Failing loudly here turns that
      // class of bug into a deploy-time error message instead.
      const refRe = /\{\{\s*[#^/{]?\s*([A-Z_][A-Z0-9_]*)\s*\}{1,3}/g;
      for (const cf of (item.configFiles || [])) {
        if (!cf.targetPath) continue;
        const refs = new Set<string>();
        for (const m of cf.content.matchAll(refRe)) refs.add(m[1]);
        const missing = [...refs].filter(r => !(r in view) || view[r as keyof typeof view] === '');
        if (missing.length > 0) {
          Mustache.escape = savedEscape;
          throw new Error(
            `Cannot deploy ${item.name}: ${cf.filename} references variable(s) with no value: ${missing.join(', ')}. ` +
            `Go back to the Configure step and fill them in (or check the template's variables.json defaults).`,
          );
        }
      }
      const extraFiles = (item.configFiles || [])
        .filter(cf => cf.targetPath)
        .map(cf => {
          const rendered = Mustache.render(cf.content, view);
          const resolvedPath = Mustache.render(cf.targetPath!, view);
          return { path: resolvedPath, content: rendered };
        });
      Mustache.escape = savedEscape;

      // Optional per-template post-deploy.py — rendered with the same view
      // and shipped to the agent inside the deploy POST. Server runs it
      // after the unit starts; output streams back as `progress` events
      // and gets parsed for `__SB_CREDENTIAL__ {json}` markers below.
      let postDeployScript: string | undefined;
      try {
        const raw = await fetchTemplatePostDeployScript(item.name, selectedStack?.source || 'Built-in');
        if (raw) {
          const savedEscape2 = Mustache.escape;
          Mustache.escape = (text: string) => text;
          postDeployScript = Mustache.render(raw, view);
          Mustache.escape = savedEscape2;
          templatesWithScript.add(item.name);
        }
      } catch { /* template ships no script — fall through to hardcoded helpers */ }

      // Variables exported as env vars to the script. Scoped to string-shaped
      // entries; the engine in ServiceManager handles bash-quote escaping.
      const postDeployEnv: Record<string, string> = {};
      for (const v of stackVariables) {
        if (typeof v.value === 'string') postDeployEnv[v.name] = v.value;
      }
      if (typeof window !== 'undefined') postDeployEnv.HOST = window.location.hostname || 'localhost';

      try {
        const query = stackSelectedNode ? `?node=${stackSelectedNode}&stream=1` : '?stream=1';
        const res = await fetch(`/api/services${query}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: item.name,
            kubeContent,
            yamlContent: content,
            yamlFileName: `${item.name}.yml`,
            extraFiles,
            postDeployScript,
            postDeployEnv: postDeployScript ? postDeployEnv : undefined,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Unknown error');
        }

        // Read streaming progress
        const reader = res.body?.getReader();
        if (reader) {
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
                  // Intercept `__SB_CREDENTIAL__ {json}` markers from the
                  // post-deploy.py script: park the parsed entry in
                  // scriptCredentials so it lands in the SAVE-THESE-NOW
                  // banner. Don't echo the raw marker to the install log.
                  if (typeof evt.message === 'string' && evt.message.startsWith('__SB_CREDENTIAL__ ')) {
                    try {
                      scriptCredentials.push(JSON.parse(evt.message.slice('__SB_CREDENTIAL__ '.length)));
                    } catch { /* malformed marker — drop it */ }
                    continue;
                  }
                  // In-place collapse — ONLY for image-pull progress lines
                  // (which tick once a second per layer and would otherwise
                  // bury everything else). Anything else — including
                  // post-deploy.py stdout — appends a new log entry so the
                  // operator can see what's actually happening.
                  //
                  // Earlier this collapsed every consecutive progress event
                  // indiscriminately. Once any line came through, every
                  // subsequent line replaced it, and the only visible trace
                  // of a post-deploy.py was the final summary line — so
                  // every script appeared to "exit 1" with no breadcrumb to
                  // the actual error.
                  const isPullProgress = /Pulling image \d+\/\d+|MB\s*\/\s*[\d.]+\s*MB/.test(evt.message ?? '');
                  if (isPullProgress && lastProgressLine && /Pulling image \d+\/\d+|MB\s*\/\s*[\d.]+\s*MB/.test(lastProgressLine)) {
                    setStackLogs(prev => {
                      const next = [...prev];
                      next[next.length - 1] = evt.message;
                      return next;
                    });
                  } else {
                    setStackLogs(prev => [...prev, evt.message]);
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
        }

        setStackLogs(prev => [...prev, `\u2705 ${item.name} deployed (containers may still be starting in background).`]);
        deployed.push({ name: item.name, checked: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStackLogs(prev => [...prev, `\u274c Failed to install ${item.name}: ${msg}`]);
        // Don't add to `deployed` \u2014 post-install will skip seeders /
        // proxy routes for this service.
      } finally {
        // Clear in-flight marker so the status strip switches from
        // "installing" to twin-derived state for the next render tick.
        setInstallingNow(null);
      }
    }

    // Post-install (LLDAP seed, ABS/Navidrome/FileBrowser admin seed, OIDC
    // client registration, NPM bootstrap, proxy-host creation) runs only
    // for services that actually deployed cleanly. A failed deploy is
    // dropped from `deployed` above so its post-install steps don't hang
    // on a container that was never going to start.
    //
    // `skipDefaults` lets per-template post-deploy.py scripts replace the
    // hardcoded helpers in postInstall.ts. `extraCredentials` are the
    // entries those scripts emitted via `__SB_CREDENTIAL__` markers, to
    // be appended to the final SAVE-THESE-NOW banner.
    const proxyResult = await runPostInstall({
      selected: deployed,
      variables: stackVariables,
      node: stackSelectedNode || undefined,
      onLog: (msg) => setStackLogs(prev => [...prev, msg]),
      skipDefaults: templatesWithScript,
      extraCredentials: scriptCredentials,
    });

    if (proxyResult === 'needs_credentials') {
      // Pre-fill the prompt with whatever the wizard configured — usually
      // the auto-generated values are correct but NPM rejected them
      // because of a stale data volume from a previous install. Showing
      // the user the values they meant to use lets them just hit "Retry"
      // (which will fail again) or paste a real password if they reset
      // NPM manually.
      const fallbackEmail = stackVariables.find(v => v.name === 'NGINX_ADMIN_EMAIL')?.value;
      const fallbackPassword = stackVariables.find(v => v.name === 'NGINX_ADMIN_PASSWORD')?.value;
      if (fallbackEmail) setNpmEmail(fallbackEmail);
      if (fallbackPassword) setNpmPassword(fallbackPassword);
      setNpmCredPrompt(true);
    } else {
      // Settle wait — don't transition to 'done' until each newly-deployed
      // service shows up as active in the digital twin. Previously we
      // declared 'done' the moment the deploy API + post-install pipeline
      // returned, then the auto self-diagnose ran ~immediately and saw
      // containers still pulling their images, flagging them as restart-
      // looping ghosts. Cap the wait at 3 minutes — long enough for
      // cold-start image pulls on a normal connection — then transition
      // either way and let the diagnose probe report what's genuinely stuck.
      //
      // Skip the wait entirely if there's no twin connection (tests, or a
      // disconnected agent — in either case hanging the wizard for 3 min
      // helps no one) or if nothing was deployed.
      // Same rationale as runPostInstall — wait only for services that
      // actually deployed. A failed deploy isn't going to become active
      // and a stuck "0/9 up" heartbeat is just noise.
      const expected = deployed.map(i => i.name);
      if (digitalTwin && expected.length > 0) {
        const SETTLE_TIMEOUT_MS = 3 * 60_000;
        const SETTLE_POLL_MS = 5_000;
        const startedAt = Date.now();
        let lastReady = -1;
        while (Date.now() - startedAt < SETTLE_TIMEOUT_MS) {
          const node = stackSelectedNode || 'Local';
          const twinNode = digitalTwin?.nodes?.[node];
          const services = twinNode?.services ?? [];
          const ready = expected.filter(name =>
            services.some(s => (s.name === name || s.name === `${name}.service`) && s.active),
          ).length;
          if (ready !== lastReady) {
            setStackLogs(prev => [...prev, `Waiting for services to become active... (${ready}/${expected.length} up)`]);
            lastReady = ready;
          }
          if (ready === expected.length) break;
          await new Promise(r => setTimeout(r, SETTLE_POLL_MS));
        }
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        if (lastReady === expected.length) {
          setStackLogs(prev => [...prev, `✅ All ${expected.length} services active after ${elapsed}s.`]);
        } else {
          setStackLogs(prev => [
            ...prev,
            `⚠️ ${lastReady}/${expected.length} services active after ${elapsed}s — slow image pulls or a real failure. Self-diagnose below will tell you which.`,
          ]);
        }
      }
      setStackInstallStep('done');
    }
  };

  /** Retry proxy route creation with user-provided NPM credentials. */
  const handleNpmCredentialSubmit = async () => {
    if (!npmEmail || !npmPassword) return;
    setNpmCredPrompt(false);
    setStackLogs(prev => [...prev, 'Retrying with provided credentials...']);
    const result = await sharedConfigureProxyRoutes({
      variables: stackVariables,
      node: stackSelectedNode || undefined,
      onLog: (msg) => setStackLogs(prev => [...prev, msg]),
      credentials: { email: npmEmail, password: npmPassword },
      skipWait: true,
    });
    if (result === 'needs_credentials') {
      setStackLogs(prev => [...prev, '❌ Authentication failed. Please check your credentials.']);
      setNpmCredPrompt(true);
      return;
    }
    // Persist the working creds so future installs don't prompt.
    try {
      await fetch('/api/system/nginx/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: npmEmail, password: npmPassword }),
      });
      setStackLogs(prev => [...prev, 'Saved NPM credentials for future installs.']);
    } catch {
      /* ignore — install succeeded, just won't auto-sync next time */
    }
    setStackInstallStep('done');
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
        
        {/* Header */}
        <div className="p-6 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
           <h2 className="text-xl font-bold flex items-center gap-2">
             <div className={`p-2 rounded-lg ${stacksOnlyMode ? 'bg-indigo-100 dark:bg-indigo-900/30' : 'bg-blue-100 dark:bg-blue-900/30'}`}>
                {stacksOnlyMode
                  ? <Layers className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                  : <Monitor className="w-5 h-5 text-blue-600 dark:text-blue-400" />}
             </div>
             {stacksOnlyMode ? 'Install Services' : 'ServiceBay Setup'}
             {appVersion && (
               <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400 align-middle">
                 v{appVersion}
               </span>
             )}
           </h2>
           {!stacksOnlyMode && (() => {
             const order: WizardStep[] = ['welcome', 'network', 'stacks', 'email', 'finish'];
             const activeSteps = order.filter(step => {
               if (step === 'welcome' || step === 'finish') return true;
               if (step === 'network') return selection.gateway || selection.ssh;
               return selection[step as keyof typeof selection];
             });
             const currentIndex = activeSteps.indexOf(currentStep);
             const total = activeSteps.length;
             return (
               <div className="flex items-center gap-3 mt-2">
                 <span className="text-sm text-gray-500 dark:text-gray-400">Step {currentIndex + 1} of {total}</span>
                 <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                   <div className="h-full bg-blue-600 rounded-full transition-all duration-300" style={{ width: `${((currentIndex + 1) / total) * 100}%` }} />
                 </div>
               </div>
             );
           })()}
           {stacksOnlyMode && (
             <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Choose a service stack to deploy on your new server.</p>
           )}
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

            {currentStep === 'stacks' && (
                <div className="space-y-4">
                    <h3 className="font-semibold text-lg flex items-center gap-2"><Layers className="w-5 h-5 text-indigo-500"/> Install a Stack</h3>

                    {stackInstallStep === 'select' && (
                        <>
                            <p className="text-sm text-gray-500">
                                Choose a pre-configured stack to install, or skip this step and install services later from the Registry.
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
                            {/* Domain prompt — moved to the TOP of the services
                                step so the operator answers it before scrolling
                                through the (potentially long) service list. The
                                Continue button below is gated until the domain
                                is set OR the "no domain" checkbox is ticked,
                                so finishing without a deliberate choice isn't
                                possible. */}
                            <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 space-y-2">
                                <label className="flex items-center gap-2 text-sm font-medium text-blue-800 dark:text-blue-200">
                                    <Globe className="w-4 h-4" /> Public Domain
                                </label>
                                <p className="text-xs text-blue-600 dark:text-blue-400">
                                    Your services will be reachable as subdomains (photos.{stackDomain || 'yourdomain.com'}, vault.{stackDomain || 'yourdomain.com'}, …) with automatic Let&apos;s Encrypt SSL.
                                </p>
                                <input
                                    type="text"
                                    value={stackDomain}
                                    onChange={(e) => { setStackDomain(e.target.value); if (e.target.value) setStackNoDomain(false); }}
                                    disabled={stackNoDomain}
                                    className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-blue-300 dark:border-blue-700 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50"
                                    placeholder="example.com"
                                />
                                <label className="flex items-center gap-2 text-xs text-blue-700 dark:text-blue-300 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={stackNoDomain}
                                        onChange={e => { setStackNoDomain(e.target.checked); if (e.target.checked) setStackDomain(''); }}
                                        className="rounded"
                                    />
                                    I don&apos;t have a public domain — install services in LAN-only mode (no SSL, no subdomains; access by IP:port).
                                </label>
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
                                // nginx-web is implicitly required as soon as the operator commits
                                // to a public domain — every other service publishes via a
                                // *_SUBDOMAIN variable that needs the proxy to reach the host. We
                                // don't put this in SERVICE_DEPS because it would mean adding
                                // `requires: ['nginx-web']` to ~10 services and cluttering each row
                                // with a redundant red badge. Surface it once here instead.
                                const wantsDomain = stackDomain.trim().length > 0 && !stackNoDomain;
                                const hasPublishedService = checked.some(i => i.name !== 'nginx-web');
                                const nginxAvailable = stackItems.some(i => i.name === 'nginx-web');
                                if (
                                    wantsDomain &&
                                    nginxAvailable &&
                                    hasPublishedService &&
                                    !checkedNames.has('nginx-web') &&
                                    !installedNames.has('nginx-web')
                                ) {
                                    missing.push({
                                        from: 'public domain',
                                        needs: 'nginx-web',
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
                                    {stackItems.map((item, i) => (
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
                                                    {/* Static role hint for nginx-web — every other
                                                        service routes through it for HTTPS subdomain
                                                        access, but spelling that out as a per-service
                                                        "with nginx-web" badge would clutter ~10 rows.
                                                        Surface the role here instead. */}
                                                    {item.name === 'nginx-web' && (
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
                                    ))}
                                </div>
                            )}

                            {/* Domain prompt is now at the TOP of this step
                                so the operator answers it before scrolling
                                through services. See the block above. */}

                            {/* RAID detection prompt */}
                            {raidArrays.length > 0 && !raidMounted && (
                                <div className="mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
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
                                <div className="mt-4 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
                                    <p className="text-sm text-green-800 dark:text-green-200 flex items-center gap-2">
                                        <CheckCircle className="w-4 h-4" /> RAID mounted at <code className="bg-green-100 dark:bg-green-800/50 px-1 rounded">/var/mnt/data</code> and will persist across reboots.
                                    </p>
                                </div>
                            )}
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

                            <div className="mb-4 border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3">
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
                                            const idx = stackVariables.findIndex(x => x.name === v.name);
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
                                                {v.meta?.type === 'password' ? (
                                                    <input
                                                        type="password"
                                                        value={v.value}
                                                        onChange={(e) => {
                                                            const newVars = [...stackVariables];
                                                            newVars[idx].value = e.target.value;
                                                            setStackVariables(newVars);
                                                        }}
                                                        className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md text-sm"
                                                        autoComplete="new-password"
                                                    />
                                                ) : v.meta?.type === 'secret' ? (
                                                    <div className="flex gap-2">
                                                        <input
                                                            type="text"
                                                            value={v.value}
                                                            onChange={(e) => { const nv = [...stackVariables]; nv[idx].value = e.target.value; setStackVariables(nv); }}
                                                            className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md text-xs font-mono flex-1"
                                                            spellCheck={false}
                                                            autoComplete="off"
                                                        />
                                                        <button type="button" onClick={() => { const nv = [...stackVariables]; nv[idx].value = generateSecret(); setStackVariables(nv); }} title="Regenerate" className="p-2 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-gray-700"><RefreshCw size={14} /></button>
                                                    </div>
                                                ) : v.meta?.type === 'select' && v.meta.options ? (
                                                    <select value={v.value} onChange={(e) => { const nv = [...stackVariables]; nv[idx].value = e.target.value; setStackVariables(nv); }} className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md text-sm">
                                                        <option value="" disabled>Select...</option>
                                                        {v.meta.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                                                    </select>
                                                ) : v.meta?.type === 'subdomain' ? (
                                                    <div className="flex items-center gap-0">
                                                        <input type="text" value={v.value} onChange={(e) => { const nv = [...stackVariables]; nv[idx].value = e.target.value; setStackVariables(nv); }} className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-l-md text-sm border-r-0" placeholder={v.meta.default || 'subdomain'} />
                                                        <span className="px-3 py-2 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-700 text-gray-500 text-xs rounded-r-md whitespace-nowrap">.{stackVariables.find(x => x.name === 'PUBLIC_DOMAIN')?.value || 'example.com'}</span>
                                                    </div>
                                                ) : v.meta?.type === 'device' ? (() => {
                                                    const devPath = v.meta?.devicePath || '/dev/serial/by-id';
                                                    const devices = stackDeviceOptions[devPath] || [];
                                                    return (
                                                        <div className="flex gap-2">
                                                            <select value={v.value} onChange={(e) => { const nv = [...stackVariables]; nv[idx].value = e.target.value; setStackVariables(nv); }} className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md text-sm flex-1">
                                                                <option value="" disabled>{stackLoadingDevices ? 'Loading devices...' : !stackSelectedNode ? 'Select a node first' : devices.length === 0 ? 'No devices found' : 'Select device...'}</option>
                                                                {devices.map(dev => <option key={dev} value={dev}>{dev.replace(`${devPath}/`, '')}</option>)}
                                                            </select>
                                                            {stackSelectedNode && (
                                                                <button type="button" onClick={() => {
                                                                    setStackLoadingDevices(true);
                                                                    fetch(`/api/system/devices?node=${stackSelectedNode}&path=${encodeURIComponent(devPath)}`)
                                                                        .then(r => r.json())
                                                                        .then(data => { setStackDeviceOptions(prev => ({ ...prev, [devPath]: data.devices || [] })); setStackLoadingDevices(false); })
                                                                        .catch(() => setStackLoadingDevices(false));
                                                                }} className="p-2 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-gray-700" title="Refresh device list">
                                                                    <RefreshCw size={14} className={stackLoadingDevices ? 'animate-spin' : ''} />
                                                                </button>
                                                            )}
                                                        </div>
                                                    );
                                                })() : (
                                                    <input
                                                        type="text"
                                                        value={v.value}
                                                        onChange={(e) => {
                                                            const newVars = [...stackVariables];
                                                            newVars[idx].value = e.target.value;
                                                            setStackVariables(newVars);
                                                        }}
                                                        className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md text-sm"
                                                        placeholder={v.meta?.default ? `Default: ${v.meta.default}` : `Value for ${v.name}`}
                                                    />
                                                )}
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

                    {(stackInstallStep === 'installing' || stackInstallStep === 'done') && (
                        <div>
                            {/* Per-service status strip — REAL state, not log parsing.
                                The previous version parsed install logs and marked
                                services "deployed" the moment the API call returned,
                                even while the container was still pulling its image.
                                Now we use the digital twin: a service counts as
                                "deployed" only when its systemd unit reports active.
                                "installing" comes from the in-flight deploy loop
                                via installingNow + log parsing for "Installing X..."
                                until the twin catches up. "failed" if either the
                                deploy log says ❌ or the twin reports the unit
                                inactive after deploy completed. */}
                            {stackItems.filter(i => i.checked && !i.alreadyInstalled).length > 0 && (() => {
                                const joined = stackLogs.join('\n');
                                const node = stackSelectedNode || 'Local';
                                const twinNode = digitalTwin?.nodes?.[node];
                                const twinServices = twinNode?.services ?? [];
                                const findService = (name: string) =>
                                    twinServices.find(s => s.name === name || s.name === `${name}.service` || s.name?.replace(/\.service$/, '') === name);
                                const statusOf = (name: string): 'pending' | 'installing' | 'deployed' | 'failed' => {
                                    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                                    // 1. Deploy loop is currently calling /api/services for this name.
                                    if (installingNow === name) return 'installing';
                                    // 2. Hard fail logged by the install pipeline.
                                    if (new RegExp(`(?:❌|✗|Failed to install)\\s+${esc}\\b`, 'i').test(joined)) return 'failed';
                                    // 3. Real state from the digital twin.
                                    const svc = findService(name);
                                    if (svc) {
                                        if (svc.active) return 'deployed';
                                        // Deploy returned + unit known to systemd but not active —
                                        // could be mid-pull (activating) or genuinely failed.
                                        // Treat as 'installing' until the deploy log declares
                                        // failure, so a fast-pulling stack doesn't flicker red.
                                        if (new RegExp(`Installing\\s+${esc}\\.\\.\\.`, 'i').test(joined)) return 'installing';
                                        if (new RegExp(`✅\\s+${esc}\\s+deployed\\b`, 'i').test(joined)) return 'installing';
                                        return 'pending';
                                    }
                                    // 4. Service not yet in twin. If the deploy log mentions it,
                                    // it's mid-deploy; otherwise it's still queued.
                                    if (new RegExp(`(?:Installing\\s+|✅\\s+)${esc}`, 'i').test(joined)) return 'installing';
                                    return 'pending';
                                };
                                const dotClass: Record<string, string> = {
                                    pending:    'bg-gray-300 dark:bg-gray-600',
                                    installing: 'bg-blue-500 animate-pulse',
                                    deployed:   'bg-emerald-500',
                                    failed:     'bg-red-500',
                                };
                                const items = stackItems.filter(i => i.checked && !i.alreadyInstalled);
                                const counts = items.reduce<Record<string, number>>((a, i) => {
                                    const s = statusOf(i.name);
                                    a[s] = (a[s] ?? 0) + 1;
                                    return a;
                                }, {});
                                return (
                                    <div className="mb-3 p-3 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-900/40">
                                        <div className="flex items-center justify-between mb-2">
                                            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Service status</p>
                                            <p className="text-[11px] text-gray-500 dark:text-gray-400">
                                                {counts.deployed ?? 0}/{items.length} deployed
                                                {counts.failed ? ` · ${counts.failed} failed` : ''}
                                            </p>
                                        </div>
                                        <div className="flex flex-wrap gap-1.5">
                                            {items.map(item => {
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
                            })()}
                            {/* Log panel grows with its content; the modal-level
                                scrollbar is the only one. Earlier this had its own
                                fixed height + overflow, which produced two stacked
                                vertical scrollbars (modal + log) — confusing and
                                fiddly to drive. The min-height keeps the box from
                                visually collapsing when the log is just a couple
                                of lines, and the bottom sentinel auto-scrolls the
                                modal so new lines stay visible without manual
                                scrolling. */}
                            <div className="bg-gray-900 text-gray-100 p-4 rounded-md font-mono text-xs min-h-[12rem] border border-gray-800">
                                {stackLogs.map((log, i) => <div key={i} className="mb-1">{log}</div>)}
                                {stackInstallStep === 'installing' && (
                                    <div className="flex items-center gap-2 text-gray-400 mt-2">
                                        <Loader2 size={14} className="animate-spin" /> Processing...
                                    </div>
                                )}
                                <div ref={logTailRef} />
                            </div>
                            {npmCredPrompt && (
                                <div className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
                                    <p className="text-sm font-medium text-amber-800 dark:text-amber-200 mb-2">NPM admin login required</p>
                                    <p className="text-xs text-amber-700 dark:text-amber-300 mb-3">
                                        We pre-filled the credentials this wizard generated, but Nginx Proxy Manager rejected them — usually because the data volume on this host carries an admin password from a previous install. Either click <span className="font-semibold">Authenticate &amp; Retry</span> with the values below, or paste the existing NPM admin password if you remember it. Skip to configure proxy routes manually later.
                                    </p>
                                    <div className="space-y-2">
                                        <input
                                            type="email"
                                            value={npmEmail}
                                            onChange={(e) => setNpmEmail(e.target.value)}
                                            className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-amber-300 dark:border-amber-700 rounded-md text-sm"
                                            placeholder="NPM admin email"
                                        />
                                        <input
                                            type="text"
                                            value={npmPassword}
                                            onChange={(e) => setNpmPassword(e.target.value)}
                                            className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-amber-300 dark:border-amber-700 rounded-md text-sm font-mono"
                                            placeholder="NPM admin password"
                                            autoComplete="off"
                                            spellCheck={false}
                                        />
                                        <div className="flex gap-2">
                                            <button
                                                onClick={handleNpmCredentialSubmit}
                                                disabled={!npmPassword}
                                                className="flex-1 px-3 py-2 bg-amber-600 text-white rounded-md text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
                                            >
                                                Authenticate &amp; Retry
                                            </button>
                                            <button
                                                onClick={() => { setNpmCredPrompt(false); setStackInstallStep('done'); }}
                                                className="px-3 py-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 text-sm"
                                            >
                                                Skip
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                            {stackInstallStep === 'done' && (() => {
                                const domain = stackVariables.find(v => v.name === 'PUBLIC_DOMAIN')?.value;
                                const subdomains = stackVariables.filter(v => v.meta?.type === 'subdomain' && v.value);
                                const hasProxyRoutes = domain && subdomains.length > 0;
                                const selected = stackItems.filter(i => i.checked && !i.alreadyInstalled);
                                const host = typeof window !== 'undefined' ? window.location.hostname : '<server-ip>';
                                const manifest = buildCredentialsManifest({ selected, variables: stackVariables, host });
                                const downloadCsv = () => {
                                    const blob = new Blob([buildBitwardenCsv(manifest)], { type: 'text/csv' });
                                    const a = document.createElement('a');
                                    a.href = URL.createObjectURL(blob);
                                    a.download = `servicebay-credentials-${new Date().toISOString().slice(0, 10)}.csv`;
                                    a.click();
                                    URL.revokeObjectURL(a.href);
                                };
                                const counts = (diagnoseProbes ?? []).reduce<Record<ProbeStatus, number>>(
                                    (a, p) => { a[p.status] = (a[p.status] ?? 0) + 1; return a; },
                                    { ok: 0, warn: 0, fail: 0, info: 0 },
                                );
                                const overall: ProbeStatus = counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : counts.ok > 0 ? 'ok' : 'info';
                                const overallStyle = {
                                    ok:   { bg: 'bg-emerald-50 dark:bg-emerald-900/20', border: 'border-emerald-200 dark:border-emerald-800', text: 'text-emerald-800 dark:text-emerald-200', label: 'Self-test passed' },
                                    warn: { bg: 'bg-amber-50 dark:bg-amber-900/20',     border: 'border-amber-200 dark:border-amber-800',     text: 'text-amber-800 dark:text-amber-200',     label: 'Self-test: warnings' },
                                    fail: { bg: 'bg-red-50 dark:bg-red-900/20',         border: 'border-red-200 dark:border-red-800',         text: 'text-red-800 dark:text-red-200',         label: 'Self-test: failures' },
                                    info: { bg: 'bg-gray-50 dark:bg-gray-900/40',       border: 'border-gray-200 dark:border-gray-800',       text: 'text-gray-700 dark:text-gray-200',       label: 'Self-test: indeterminate' },
                                }[overall];
                                return (
                                    <div className="mt-3 space-y-3 max-h-[60vh] overflow-y-auto">
                                        {/* Auto self-test verdict — first thing the operator
                                            sees on the Done screen. Same probes as
                                            Health → Self-Diagnose, run automatically against
                                            the just-deployed install. */}
                                        <div className={`p-3 rounded border text-sm ${overallStyle.bg} ${overallStyle.border}`}>
                                            <div className="flex items-center justify-between mb-1.5">
                                                <p className={`font-medium ${overallStyle.text}`}>
                                                    {diagnoseRunning
                                                        ? '⏳ Running self-test…'
                                                        : diagnoseError
                                                            ? '⚠️ Self-test failed to run'
                                                            : `${overall === 'ok' ? '✅' : overall === 'warn' ? '⚠️' : overall === 'fail' ? '❌' : 'ℹ️'} ${overallStyle.label}${diagnoseProbes ? ` — ${counts.ok} ok · ${counts.warn} warn · ${counts.fail} fail` : ''}`}
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
                                            {diagnoseProbes && (counts.warn > 0 || counts.fail > 0) && (
                                                <details className="mt-1 text-xs">
                                                    <summary className={`cursor-pointer ${overallStyle.text}`}>Details ({counts.warn + counts.fail} issue{counts.warn + counts.fail === 1 ? '' : 's'})</summary>
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

                                        {!hasProxyRoutes && manifest.length === 0 && (
                                            <p className="text-sm text-green-600 dark:text-green-400 font-medium">
                                                Stack installation complete.
                                            </p>
                                        )}
                                    </div>
                                );
                            })()}
                        </div>
                    )}
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

            {currentStep === 'stacks' && stackInstallStep === 'select' && (
                <Button onClick={handleStackSkip}>Skip <ArrowRight className="w-4 h-4 ml-2" /></Button>
            )}
            {currentStep === 'stacks' && stackInstallStep === 'services' && (
                <div className="flex gap-2 items-center">
                    <button onClick={() => { setStackInstallStep('select'); setSelectedStack(null); }} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Back</button>
                    {!stackDomain.trim() && !stackNoDomain && (
                        <span className="text-xs text-amber-700 dark:text-amber-300">Set a public domain (or check the LAN-only box) to continue.</span>
                    )}
                    <Button
                        onClick={handleStackFetchVars}
                        disabled={
                            stackItems.filter(i => i.checked).length === 0
                            || stacksLoading
                            || (!stackDomain.trim() && !stackNoDomain)
                        }
                    >
                        {stacksLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} Continue
                    </Button>
                </div>
            )}
            {currentStep === 'stacks' && stackInstallStep === 'configure' && (
                <div className="flex gap-2">
                    <button onClick={() => setStackInstallStep('services')} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Back</button>
                    <Button
                        onClick={handleStackInstall}
                        disabled={(!stackSelectedNode && stackNodes.length > 1) || (cleanInstall && cleanInstallConfirm !== 'RESET')}
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


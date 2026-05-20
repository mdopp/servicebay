'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
    checkOnboardingStatus,
    skipOnboarding,
    saveGatewayConfig,
    savePublicDomainConfig,
    saveAutoUpdateConfig,
    saveRegistriesConfig,
    saveEmailConfig,
    completeStackSetup,
    forceClearInstallLock,
    OnboardingStatus
} from '@/app/actions/onboarding';
import { generateLocalKey } from '@/app/actions/ssh';
import { fetchTemplates, fetchReadme } from '@/app/actions';
import { isValidOperatorEmail, operatorEmailIssue } from '@/lib/operatorEmail';
import { getNodes } from '@/app/actions/system';
import { Template } from '@/lib/registry';
import type { TemplateTier } from '@/lib/templateTier';
import { useStackInstall } from '@/hooks/useStackInstall';
import type { StackVariable } from '@/hooks/useStackInstall';
import { useToast } from '@/providers/ToastProvider';
import { useDigitalTwin } from '@/hooks/useDigitalTwin';
import type { DiagnoseProbe } from './DiagnoseProbeList';
import { Loader2, Monitor, CheckCircle, ArrowRight, Minimize2, AlertTriangle, Layers } from 'lucide-react';
import { Button } from './wizard/WizardUI';
import { WelcomeStep } from './wizard/steps/WelcomeStep';
import { NetworkStep } from './wizard/steps/NetworkStep';
import { EmailStep } from './wizard/steps/EmailStep';
import { MachineStep } from './wizard/steps/MachineStep';
import { StacksStep } from './wizard/steps/StacksStep';
import { FinishStep } from './wizard/steps/FinishStep';

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
  /**
   * Install-time hard deps from
   * `metadata.annotations['servicebay.dependencies']`. Drives the
   * "requires X" red badge, the auto-check on toggle-on, and the
   * uncheck-guard that prevents an operator from accidentally
   * removing something other selected services need.
   */
  dependencies?: string[];
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
  // #694: pinned active-step count, captured when operator commits at
  // welcome step. null while still at welcome so the count tracks toggles
  // live; populated once they continue so subsequent steps see a stable
  // denominator that doesn't wobble if they back up and re-toggle.
  const [committedStepCount, setCommittedStepCount] = useState<number | null>(null);

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
  /** name → hard-dependency list, parsed from each template's
   *  `servicebay.dependencies` annotation. Populated once in
   *  loadStacks and used by handleSelectStack to decorate each
   *  StackItem with its deps so the auto-check + uncheck-guard +
   *  "requires X" badge run off the same map. */
  const [templateDeps, setTemplateDeps] = useState<Map<string, string[]>>(new Map());
  // Multi-stack selection (#682-followup): the picker is now a
  // checkbox list, default-all-checked. The aggregated items[] from
  // all selected stacks flows through handleStackFetchVars →
  // handleStackInstall as if it came from a single stack. Pre-fix
  // this was a single `selectedStack` and the operator could only
  // ever install one bundle per wizard run — see
  // docs/WIZARD_UX_AUDIT.md.
  //
  // `selectedStacks` is the *committed* set (used by the
  // services/configure/installing path after the operator hits
  // Continue). `pickerChecked` is the *in-progress* set the
  // checkbox rows write to; it survives Back navigation so the
  // operator's selection isn't reset on round-trip.
  const [selectedStacks, setSelectedStacks] = useState<Template[]>([]);
  const [pickerChecked, setPickerChecked] = useState<Set<string>>(new Set());
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
  const [, setRaidMounting] = useState(false);
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

  // Live container/service state from the agent. The status strip ABOVE
  // the log panel uses this — NOT log-parsing — so a service counts as
  // "deployed" only when its container is actually Up. The settle-wait
  // logic that used to live here moved server-side (runner.ts) when the
  // deploy loop was extracted; the runner reads the same DigitalTwinStore
  // singleton directly, in-process.
  useDigitalTwin();

  /**
   * Shared install engine. The deploy loop now runs server-side via
   * runner.ts; this hook is the thin RPC + socket-subscription client.
   * The wizard tags every job with `source: 'wizard'` so the
   * install-in-progress banner can distinguish wizard installs from
   * single-template redeploys via the InstallerModal.
   */
  const installFlow = useStackInstall({
    // All bundled stacks share the same source. When the operator
    // picks multiple, we use the first one's source as the
    // representative — there's no per-stack source override anyway,
    // since the install runner doesn't consume `templateSource`.
    templateSource: selectedStacks[0]?.source || 'Built-in',
    source: 'wizard',
  });

  // Configure-step tab. Variables are categorised so the operator isn't
  // staring at a 50-line flat list — the "subdomains" tab shows the
  // user-meaningful per-service URLs, "settings" shows the misc
  // text/select/secret inputs, "ports" shows host-port mappings (most
  // operators never touch these).
  // null = "auto-pick the first non-empty tab"; user click locks the choice.
  // const [configureTab, setConfigureTab] = useState<ConfigureTab | null>(null);

  // Post-install self-test — auto-runs once the install pipeline reaches
  // 'done' so the user immediately sees a green/yellow/red verdict on
  // their fresh deployment instead of having to navigate to Settings.
  // `diagnoseNode` is captured from the response so the action-dispatch
  // calls in DiagnoseProbeList target the same node the suite probed.
  const [diagnoseProbes, setDiagnoseProbes] = useState<DiagnoseProbe[] | null>(null);
  const [, setDiagnoseNode] = useState<string>('Local');
  const [diagnoseRunning, setDiagnoseRunning] = useState(false);
  const [, setDiagnoseError] = useState<string | null>(null);
  const [diagnoseRanOnce, setDiagnoseRanOnce] = useState(false);

  // Clean install + log state live in the install-flow controller now —
  // the local aliases below keep the JSX readable without touching every
  // call site.
  const cleanInstall = installFlow.cleanInstall;
  const cleanInstallConfirm = installFlow.cleanInstallConfirm;
  const setCleanInstall = installFlow.setCleanInstall;
  const setCleanInstallConfirm = installFlow.setCleanInstallConfirm;
  const preserve = installFlow.preserve;
  const setPreserve = installFlow.setPreserve;
  const stackVariables = installFlow.variables;
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

  // Re-open the wizard when /setup (or any other page) requests it.
  // /setup is the non-blocking workspace shown while an install is
  // running — its "Open wizard" button dispatches this event so the
  // operator can come back to credential prompts / progress detail
  // without losing wizard state.
  useEffect(() => {
    const onOpen = () => setIsOpen(true);
    window.addEventListener('servicebay:open-wizard', onOpen);
    return () => window.removeEventListener('servicebay:open-wizard', onOpen);
  }, []);

  useEffect(() => {
    // We check two things in parallel: the wizard-onboarding status
    // (does setup need to start at all?) and the install-job status
    // (is there a *terminal* job sitting around that the operator
    // never acknowledged?). The second one decides whether to skip
    // the auto-open: if there's a finished install + stackSetupPending
    // we route the operator to /setup instead of slamming the modal
    // back over their screen on every reload (#wizard-pop-on-reload).
    Promise.all([
      checkOnboardingStatus(),
      fetch('/api/install/status', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(d => d as {
          job?: { phase?: string; startedAt?: string } | null;
          jobIsActive?: boolean;
          serverStartedAt?: string;
        } | null)
        .catch(() => null),
    ]).then(([s, installStatus]) => {
      setStatus(s);
      // A terminal job suppresses the wizard auto-open only when it
      // belongs to the current server process. After an OS re-install
      // the install-jobs dir survives on the RAID mount, so a stale
      // terminal job from the previous boot would otherwise gate the
      // wizard off and the operator never gets prompted to deploy
      // their stack. setup-config-merge.py wipes the dir post-merge;
      // this client-side check is defense-in-depth.
      const job = installStatus?.job;
      const jobIsFromThisBoot = !!job?.startedAt
        && !!installStatus?.serverStartedAt
        && job.startedAt >= installStatus.serverStartedAt;
      const hasTerminalJob = !!job && installStatus?.jobIsActive === false && jobIsFromThisBoot;

      // If the server reports an active install job and we're NOT
      // already tracking it locally, auto-attach to it. This is the
      // critical "operator reopened the tab mid-install" path: the
      // runner kept working on the server, and we just need to render
      // its progress instead of re-prompting from scratch. The job
      // shape on `installInProgress` carries the jobId for this.
      if (s.installInProgress && installFlow.jobId !== s.installInProgress.jobId) {
        setIsOpen(true);
        void installFlow.attachToJob(s.installInProgress.jobId);
        return;
      }
      if (s.needsSetup) {
        setIsOpen(true);
        // Only seed selection from feature detection if we have no persisted draft —
        // otherwise the user's in-progress choices win.
        // Always sync selection with server-side feature detection.
        // If a feature is already configured on the server, we uncheck it
        // in the wizard so the operator isn't prompted to re-configure it,
        // even if their browser draft (sessionStorage) had it checked.
        setSelection(prev => ({
            ...prev,
            gateway: !s.features.gateway,
            ssh: !s.features.ssh,
            updates: s.features.updates, // auto-update is a toggle, sync as-is
            registries: s.features.registries,
            email: !s.features.email,
            // stacks is the only one we don't auto-flip off if already
            // present, because "stacks" in the wizard means "re-deploy or
            // add more".
        }));

        if (persisted && typeof window !== 'undefined') {
          addToast(
            'info',
            'Setup resumed',
            'We restored your in-progress onboarding from the previous session.',
          );
        }
      } else if (s.stackSetupPending) {
        // If there's already a terminal install job on the server, the
        // operator has *started* an install; they just haven't clicked
        // "Finish" on /setup yet. Popping the modal back open on every
        // reload in this state is hostile — the operator is using
        // ServiceBay normally and gets a 90vh dialog shoved in their
        // face. The Sidebar Setup pill stays visible (and pulses) while
        // `stackSetupPending: true`, and /setup is one click away to
        // see credentials / DNS verify / Finish. So: skip auto-open.
        if (hasTerminalJob) {
          // Suppress the modal but keep `stacksOnlyMode` armed so if
          // the operator does open the wizard via the sidebar's
          // "Open wizard" affordance they land on install-confirm.
          setStacksOnlyMode(true);
          setCurrentStep('install-confirm');
          return;
        }
        // No prior install attempt yet: legitimate first-run auto-open.
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

  // #694: pin the activeSteps count at the moment the operator commits
  // their selection by leaving the welcome step. Welcome and edit-mode
  // keep the live count (those are the moments where the operator's own
  // action legitimately changes M); the express-flow steps use the pin.
  useEffect(() => {
    if (currentStep === 'welcome') {
      setCommittedStepCount(null);
      return;
    }
    if (currentStep === 'machine' || currentStep === 'stacks') return;
    const order: WizardStep[] = ['welcome', 'network', 'email', 'install-confirm', 'machine', 'stacks', 'finish'];
    const active = order.filter(step => {
      if (step === 'welcome' || step === 'finish' || step === 'network') return true;
      if (step === 'install-confirm') return selection.stacks;
      if (step === 'machine' || step === 'stacks') return false;
      return selection[step as keyof typeof selection];
    });
    setCommittedStepCount(active.length);
  }, [currentStep, selection]);

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

  // Heartbeat removed — the server-side runner now owns the install
  // lifecycle. checkOnboardingStatus reads the active job from
  // jobStore (replaces installLock); there's nothing for the client to
  // keep alive. A crashed install is recovered via markCrashedOnStartup
  // in server.ts, not via heartbeat expiry.

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
      .then((data: { node?: string; probes: DiagnoseProbe[] }) => {
        setDiagnoseProbes(data.probes);
        if (data.node) setDiagnoseNode(data.node);
      })
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
      const deps = new Map<string, string[]>();
      for (const t of templates.filter(t => t.type === 'template')) {
        tiers.set(t.name, t.tier ?? 'feature');
        deps.set(t.name, t.dependencies ?? []);
      }
      setTemplateTiers(tiers);
      setTemplateDeps(deps);
      setStackNodes(nodes);
      if (nodes.length === 1) setStackSelectedNode(nodes[0].Name);
      // Single-stack registries (downstream / external) skip the
      // picker step — nothing to choose, drop straight into the
      // checkbox grid. The bundled set ships 4 stacks so this branch
      // doesn't fire there; express install handles the multi-stack
      // case by iterating in handleExpressInstall.
      // Initialize picker checkbox state to all-checked on first
      // load. Pre-existing pickerChecked (operator returned via
      // Back from the services step) wins over the default — they
      // don't get their selection reset.
      setPickerChecked(prev => prev.size > 0 ? prev : new Set(stacks.map(s => s.name)));
      if (stacks.length === 1 && selectedStacks.length === 0) {
        await handleSelectStack([stacks[0]]);
      }
    } catch {
      // Stacks not available yet, that's OK
      setAvailableStacks([]);
    } finally {
      setStacksLoading(false);
    }
    // handleSelectStack + selectedStacks referenced in the auto-select
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
    // Network step prefill (#662 — S3): pull publicDomain so the
    // operator sees the install-script-baked or previously-saved value
    // rather than an empty box. Same source as install-confirm uses.
    if (currentStep !== 'network') return;
    if (publicDomain) return;
    let cancelled = false;
    fetch('/api/settings').then(r => r.ok ? r.json() : null).then(s => {
      if (cancelled) return;
      const baked = s?.reverseProxy?.publicDomain;
      if (typeof baked === 'string' && baked.length > 0) {
        setPublicDomain(baked);
      }
    }).catch(() => { /* silent — operator can type the value */ });
    return () => { cancelled = true; };
  }, [currentStep, publicDomain]);

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
    // Sub-step navigation within `stacks`: each services/configure step
    // should rewind one sub-state before popping the outer wizard
    // history. Without this the footer Back jumps all the way out to
    // `machine`, which surprised operators in #686 (they clicked Back
    // expecting to step one stage, got teleported to a different step).
    if (currentStep === 'stacks') {
      if (wizardSubStep === 'services') {
        // services → picker
        setSelectedStacks([]);
        setStackItems([]);
        setWizardSubStep('select');
        return;
      }
      if (wizardSubStep === 'flow') {
        // configure → services
        setWizardSubStep('services');
        return;
      }
      // sub-step === 'select' → fall through to the outer pop.
    }
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
         // network step is always active now — captures publicDomain
         // (#662) in addition to optional gateway/SSH config.
         if (step === 'network') return true;
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

  const handleFinish = async () => {
    if (stacksOnlyMode) {
      await completeStackSetup();
    } else {
      await skipOnboarding();
    }
    clearPersistedWizardState();
    setIsOpen(false);
    router.refresh();
    addToast('success', 'Setup Complete', 'Welcome to ServiceBay!');
  };

  const saveAndNext = async (fn: () => Promise<void>) => {
    setLoading(true);
    try {
      await fn();
      handleNext();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save configuration';
      addToast('error', 'Error', msg);
    } finally {
      setLoading(false);
    }
  };

  const handleSkip = async () => {
    setLoading(true);
    try {
      await skipOnboarding();
      clearPersistedWizardState();
      setIsOpen(false);
      router.refresh();
      addToast('success', 'Onboarding Skipped', 'You can finish setup later in Settings.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to skip onboarding';
      addToast('error', 'Error', msg);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveWelcome = () => saveAndNext(async () => {
      const tasks: Promise<unknown>[] = [];
      if (selection.updates) tasks.push(saveAutoUpdateConfig(true));
      if (selection.registries) tasks.push(saveRegistriesConfig(true));
      if (tasks.length > 0) await Promise.all(tasks);
  });

  const handleSaveNetwork = () => saveAndNext(async () => {
      if (selection.gateway) {
          await saveGatewayConfig(gwHost, gwUser, gwPass);
          addToast('success', 'Gateway Saved', 'Network configuration updated.');
      }
      await savePublicDomainConfig(publicDomain);
  });

  const handleSaveEmail = () => saveAndNext(async () => {
      await saveEmailConfig(emailConfig);
      addToast('success', 'Email Configured', 'Notification settings updated.');
  });

  // Device detection
  useEffect(() => {
    if (!stackSelectedNode) return;
    const fetchDevices = async () => {
      setStackLoadingDevices(true);
      try {
        const [storageRes, usbRes] = await Promise.all([
          fetch(`/api/system/storage?node=${stackSelectedNode}`),
          fetch(`/api/system/devices?node=${stackSelectedNode}&path=/dev/serial/by-id`)
        ]);

        if (storageRes.ok) {
          const { drives } = await storageRes.json();
          setDetectedDrives(drives || []);
        }

        const opts: Record<string, string[]> = {};
        if (usbRes.ok) {
          const usbDevices = await usbRes.json();
          opts['/dev/serial/by-id'] = usbDevices;
        }
        setStackDeviceOptions(opts);
      } catch (err) {
        console.error('Failed to fetch devices:', err);
      } finally {
        setStackLoadingDevices(false);
      }
    };
    fetchDevices();
  }, [stackSelectedNode]);

  // RAID detection
  useEffect(() => {
    if (!stackSelectedNode) return;
    const fetchRaid = async () => {
      try {
        const res = await fetch(`/api/system/storage?node=${stackSelectedNode}`);
        if (res.ok) {
          const { raids } = await res.json();
          setRaidArrays((raids || []).filter((r: { mountpoint: string | null }) => !r.mountpoint));
        }
      } catch (err) {
        console.error('Failed to fetch RAID:', err);
      }
    };
    fetchRaid();
  }, [stackSelectedNode]);

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
        addToast('error', 'Error', 'Failed to generate key');
    } finally {
        setLoading(false);
    }
  };

  const handleSelectStack = async (stacks: Template[]): Promise<StackItem[]> => {
    if (stacks.length === 0) {
      setSelectedStacks([]);
      setStackItems([]);
      setWizardSubStep('select');
      return [];
    }
    setSelectedStacks(stacks);
    setWizardSubStep('services');
    setStacksLoading(true);

    try {
      const existing = await fetchExistingServices(stackSelectedNode || undefined);
      const itemsByName = new Map<string, StackItem>();
      const regex = /-\s*\[([ xX])\]\s*([\w\d_-]+)\s*(?:[—–\-:]\s*(.+))?$/;

      for (const stack of stacks) {
        const readme = await fetchReadme(stack.name, 'stack', stack.source);
        const lines = (readme || '').split('\n');
        lines.forEach((line: string) => {
          const match = line.match(regex);
          if (match) {
            const name = match[2].trim();
            if (itemsByName.has(name)) return;
            const isInstalled = existing.has(name.toLowerCase());
            const effectivelyInstalled = cleanInstall ? false : isInstalled;
            itemsByName.set(name, {
              name,
              description: match[3]?.trim() || undefined,
              tier: templateTiers.get(name) ?? 'feature',
              dependencies: templateDeps.get(name) ?? [],
              checked: templateTiers.get(name) === 'infrastructure'
                ? !effectivelyInstalled
                : (!effectivelyInstalled && match[1].toLowerCase() === 'x'),
              alreadyInstalled: effectivelyInstalled,
            });
          }
        });
      }
      const parsedItems = Array.from(itemsByName.values());
      if (parsedItems.length === 0) {
        const names = stacks.map(s => s.name).join(', ');
        addToast('error', 'No services found', `Could not parse services from ${names}`);
        setStackItems([]);
        setSelectedStacks([]);
        setWizardSubStep('select');
        return [];
      }
      setStackItems(parsedItems);
      return parsedItems;
    } finally {
      setStacksLoading(false);
    }
  };

  const handleStackFetchVars = async (itemsOverride?: StackItem[]) => {
    setWizardSubStep('flow');
    setStacksLoading(true);
    try {
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
        { node: stackSelectedNode || undefined, cleanInstall },
      );

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

  const handleStackInstall = async (itemsOverride?: StackItem[], variablesOverride?: StackVariable[]) => {
    await installFlow.runInstall({
      items: itemsOverride ? itemsOverride.map(i => ({ ...i })) : undefined,
      variables: variablesOverride,
      node: stackSelectedNode || undefined,
    });
  };

  const handleExpressInstall = async () => {
    if (availableStacks.length === 0) {
      addToast('error', 'No stacks available');
      return;
    }

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
        }
      } catch { /* ignore */ }
      setRaidMounting(false);
    }

    const items = await handleSelectStack(availableStacks);
    if (items.length === 0) return;
    
    navigateTo('stacks');
    const fetched = await handleStackFetchVars(items);
    await handleStackInstall(fetched.items, fetched.variables);
  };

  const handleStartExpressInstall = async () => {
    await handleExpressInstall();
  };

  // "Install services later" affordance on the stacks/select picker
  // (#688 — was just "Skip", renamed to be explicit). Closes the wizard
  // without installing any service; stacksOnlyMode completes the setup
  // flag (operator chose to defer), the normal flow just advances.
  const handleStackSkip = async () => {
    if (stacksOnlyMode) {
      await completeStackSetup();
      clearPersistedWizardState();
      setIsOpen(false);
      router.refresh();
    } else {
      handleNext();
    }
  };

  if (!isOpen) return null;

  const order: WizardStep[] = ['welcome', 'network', 'email', 'install-confirm', 'machine', 'stacks', 'finish'];
  const inEditMode = currentStep === 'machine' || currentStep === 'stacks';
  const activeSteps = order.filter(step => {
    if (step === 'welcome' || step === 'finish') return true;
    if (step === 'network') return true;
    if (step === 'install-confirm') return selection.stacks && !inEditMode;
    if (step === 'machine' || step === 'stacks') return inEditMode;
    return selection[step as keyof typeof selection];
  });
  const currentIndex = activeSteps.indexOf(currentStep);
  // #694: pin the denominator after the operator commits at welcome step.
  // Live activeSteps.length wobbles when they back up and toggle, which
  // looks like "of M" jumping mid-flow. Welcome step shows live (they're
  // configuring); edit mode also shows live (entering it intentionally
  // adds/drops steps and the operator clicked the action that did it).
  // Everywhere else the count is pinned to the welcome-commit snapshot.
  const displayStepCount = (currentStep === 'welcome' || inEditMode)
    ? activeSteps.length
    : (committedStepCount ?? activeSteps.length);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 md:p-10 animate-in fade-in duration-500">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={() => setIsOpen(false)} />
      
      <div className="relative w-full max-w-6xl h-[85vh] flex bg-white dark:bg-[#0a0a0b] rounded-[2.5rem] shadow-2xl overflow-hidden border border-white/5 soft-depth">
        
        {/* Navigation Sidebar */}
        <aside className="w-72 border-r border-white/5 bg-white/[0.02] backdrop-blur-3xl p-10 flex flex-col justify-between shrink-0">
          <div className="space-y-10">
            <div className="flex items-center gap-4">
              <div className="p-3.5 rounded-2xl bg-blue-500/10 border border-blue-500/20 shadow-inner">
                <Monitor className="w-7 h-7 text-blue-500" />
              </div>
              <div>
                <h2 className="text-lg font-bold tracking-tight text-white">ServiceBay</h2>
                <p className="text-[10px] uppercase font-black text-gray-500 tracking-[0.2em]">Setup Engine</p>
              </div>
            </div>

            <nav className="space-y-2">
              {activeSteps.map((step, idx) => {
                const isActive = step === currentStep;
                const isCompleted = activeSteps.indexOf(currentStep) > idx;
                const stepLabel = step.charAt(0).toUpperCase() + step.slice(1).replace('-', ' ');
                
                return (
                  <div 
                    key={step}
                    className={`flex items-center gap-4 px-5 py-4 rounded-2xl transition-all duration-500 group ${
                      isActive ? 'bg-blue-600/10 text-blue-400 border border-blue-500/20 shadow-lg shadow-blue-500/5' : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-black border-2 transition-all duration-500 ${
                      isActive ? 'bg-blue-500 border-blue-400 text-white shadow-[0_0_15px_rgba(59,130,246,0.5)]' : 
                      isCompleted ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-500' : 'border-gray-800 group-hover:border-gray-700'
                    }`}>
                      {isCompleted ? <CheckCircle size={14} /> : idx + 1}
                    </div>
                    <span className={`text-sm font-bold tracking-tight ${isActive ? 'translate-x-1' : ''} transition-transform duration-500`}>
                      {stepLabel}
                    </span>
                  </div>
                );
              })}
            </nav>
          </div>

          {appVersion && (
            <div className="px-6 py-3 rounded-2xl bg-white/[0.02] border border-white/5">
                <div className="text-[9px] uppercase font-black text-gray-600 tracking-widest mb-1">Architecture</div>
                <div className="text-[11px] font-mono text-gray-400">sb-v{appVersion}-stable</div>
            </div>
          )}
        </aside>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col min-w-0 bg-gradient-to-br from-transparent to-blue-500/[0.02]">
          <header className="px-12 py-10 flex items-center justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <h1 className="text-3xl font-black tracking-tight capitalize text-white">
                  {currentStep.replace('-', ' ')}
                </h1>
                {/*
                  stacksOnlyMode header pill (#690). The wizard launched
                  from the sidebar's "Install another stack" entry skips
                  the welcome→finish setup and changes several button
                  labels + exit behaviours; the operator previously had
                  no signal that they were in a different mode than the
                  original setup walk. The pill names the active mode so
                  "Skip → exits to dashboard" and "Finish (vs Continue)"
                  read as intentional rather than confusing copy drift.
                */}
                {stacksOnlyMode && (
                  <span
                    className="px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/30"
                    title="You're adding a service to an already-set-up node. Skip / Finish exit to the dashboard instead of advancing the wizard."
                  >
                    Add a service
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <div className="h-1 w-12 bg-blue-500 rounded-full" />
                <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">
                  {stacksOnlyMode
                    ? `Step ${currentIndex + 1} of ${displayStepCount} · add-a-service mode`
                    : `Stage ${currentIndex + 1} of ${displayStepCount}`}
                </p>
              </div>
            </div>
            <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="p-3 text-gray-500 hover:text-white hover:bg-white/10 rounded-2xl transition-all duration-300 border border-transparent hover:border-white/10"
              >
                <Minimize2 size={24} />
            </button>
          </header>

          <main className="flex-1 overflow-y-auto px-12 pb-12 scrollbar-thin">
            {status?.installInProgress && stackInstallStep !== 'installing' && (
               <div className="mb-10 p-6 rounded-[2rem] border border-amber-500/20 bg-amber-500/5 backdrop-blur-md animate-in slide-in-from-top-4 duration-700">
                  <div className="flex items-center gap-3 text-amber-500 mb-3">
                    <div className="p-2 bg-amber-500/10 rounded-xl">
                        <AlertTriangle size={20} />
                    </div>
                    <h4 className="font-bold text-base">Concurrent Pipeline Active</h4>
                  </div>
                  <p className="text-sm text-amber-200/70 leading-relaxed mb-6">
                    Another session is currently driving an installation. Racing two pipelines will corrupt the system state. Switch to the active tab or force-clear if it&apos;s a ghost lock.
                  </p>
                  <Button variant="outline" className="!py-2 !px-4 !text-xs !border-amber-500/30 hover:!bg-amber-500/10 text-amber-500" onClick={async () => {
                    if (!confirm('Force-clear the install lock?')) return;
                    await forceClearInstallLock();
                    const fresh = await checkOnboardingStatus();
                    setStatus(fresh);
                  }}>
                    Force-clear lock
                  </Button>
               </div>
            )}

            {currentStep === 'welcome' && (
              <WelcomeStep selection={selection} setSelection={setSelection} />
            )}

            {currentStep === 'network' && (
              <NetworkStep 
                selection={selection}
                publicDomain={publicDomain}
                setPublicDomain={setPublicDomain}
                gwHost={gwHost}
                setGwHost={setGwHost}
                gwUser={gwUser}
                setGwUser={setGwUser}
                gwPass={gwPass}
                setGwPass={setGwPass}
                status={status}
                handleGenerateKey={handleGenerateKey}
                loading={loading}
              />
            )}

            {currentStep === 'email' && (
              <EmailStep emailConfig={emailConfig} setEmailConfig={setEmailConfig} />
            )}

            {(currentStep === 'machine' || currentStep === 'install-confirm') && (
              <MachineStep
                isExpressMode={currentStep === 'install-confirm'}
                installMode={installMode}
                setInstallMode={setInstallMode}
                publicDomain={publicDomain}
                setPublicDomain={setPublicDomain}
                operatorEmail={operatorEmail}
                setOperatorEmail={setOperatorEmail}
                isValidOperatorEmail={isValidOperatorEmail}
                operatorEmailIssue={operatorEmailIssue}
                detectedRaid={raidArrays[0]}
                availableStacks={availableStacks}
                cleanInstall={cleanInstall}
                setCleanInstall={setCleanInstall}
                cleanInstallConfirm={cleanInstallConfirm}
                setCleanInstallConfirm={setCleanInstallConfirm}
                preserve={preserve}
                setPreserve={setPreserve}
                stackSelectedNode={stackSelectedNode}
                navigateTo={navigateTo}
                detectedDrives={detectedDrives}
                stackLoadingDevices={stackLoadingDevices}
              />
            )}

            {currentStep === 'stacks' && (
              <StacksStep 
                stackInstallStep={stackInstallStep}
                stacksLoading={stacksLoading}
                availableStacks={availableStacks}
                pickerChecked={pickerChecked}
                setPickerChecked={setPickerChecked}
                stackItems={stackItems}
                setStackItems={setStackItems}
                stackVariables={stackVariables}
                installFlow={installFlow}
                stackNodes={stackNodes}
                stackSelectedNode={stackSelectedNode}
                setStackSelectedNode={setStackSelectedNode}
                installingNow={installingNow}
                diagnoseProbes={diagnoseProbes}
                diagnoseRunning={diagnoseRunning}
                handleStackSkip={handleStackSkip}
                stacksOnlyMode={stacksOnlyMode}
                handleFinish={handleFinish}
                SERVICE_DEPS={SERVICE_DEPS}
                stackDeviceOptions={stackDeviceOptions}
                stackLoadingDevices={stackLoadingDevices}
              />
            )}

            {currentStep === 'finish' && (
                <FinishStep handleFinish={handleFinish} />
            )}
          </main>

          {/* Navigation Footer */}
          <footer className="px-12 py-8 border-t border-white/5 flex items-center justify-between bg-white/[0.01] backdrop-blur-sm">
             <Button 
                variant="ghost" 
                onClick={handleBack} 
                disabled={stepHistory.length === 0 || loading || (currentStep === 'stacks' && stackInstallStep === 'installing')}
                className="px-8 !text-gray-400 hover:!text-white"
             >
                Back
             </Button>
             
             <div className="flex gap-4">
                {currentStep === 'welcome' && (
                   <Button onClick={handleSaveWelcome} disabled={loading} className="px-10 py-4 text-base shadow-xl shadow-blue-500/20">
                      {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <span className="flex items-center gap-2">Continue <ArrowRight className="w-5 h-5" /></span>}
                   </Button>
                )}
                {currentStep === 'network' && (
                   <Button onClick={handleSaveNetwork} disabled={loading} className="px-10 py-4 text-base shadow-xl shadow-blue-500/20">
                      {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <span className="flex items-center gap-2">Continue <ArrowRight className="w-5 h-5" /></span>}
                   </Button>
                )}
                {currentStep === 'email' && (
                   <Button onClick={handleSaveEmail} disabled={loading} className="px-10 py-4 text-base shadow-xl shadow-blue-500/20">
                      {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <span className="flex items-center gap-2">Continue <ArrowRight className="w-5 h-5" /></span>}
                   </Button>
                )}
                {(currentStep === 'machine' || currentStep === 'install-confirm') && (
                   <Button 
                      onClick={currentStep === 'install-confirm' ? handleStartExpressInstall : handleNext} 
                      disabled={loading || (currentStep === 'install-confirm' && cleanInstall && !cleanInstallConfirm)} 
                      className="px-10 py-4 text-base shadow-xl shadow-blue-500/20"
                   >
                      {currentStep === 'install-confirm' ? (
                         <span className="flex items-center gap-2"><Layers className="w-5 h-5" /> Install Now</span>
                      ) : (
                         <span className="flex items-center gap-2">Continue <ArrowRight className="w-5 h-5" /></span>
                      )}
                   </Button>
                )}
                {currentStep === 'stacks' && (
                   <>
                      {stackInstallStep === 'select' && (
                         <Button onClick={() => handleSelectStack(availableStacks.filter(s => pickerChecked.has(s.name)))} disabled={stacksLoading || pickerChecked.size === 0} className="px-10 py-4 text-base">
                            Continue
                         </Button>
                      )}
                      {stackInstallStep === 'services' && (
                         <Button onClick={() => handleStackFetchVars()} disabled={stacksLoading || !stackItems.some(i => i.checked)} className="px-10 py-4 text-base">
                            Continue
                         </Button>
                      )}
                      {stackInstallStep === 'configure' && (
                         <Button onClick={() => handleStackInstall()} disabled={stacksLoading} className="px-10 py-4 text-base">
                            Install Stack
                         </Button>
                      )}
                   </>
                )}
             </div>
          </footer>
        </div>

        {showSkipConfirm && (
           <div className="absolute inset-0 z-[110] flex items-center justify-center p-8 bg-black/60 backdrop-blur-xl animate-in fade-in duration-500">
              <div className="max-w-md w-full p-10 rounded-[2.5rem] bg-[#0d0d0e] border border-white/10 shadow-2xl space-y-8 animate-in zoom-in-95 duration-500">
                <div className="space-y-3">
                  <h3 className="text-2xl font-black text-white">Skip onboarding?</h3>
                  <p className="text-sm text-gray-400 leading-relaxed">
                    You can always return to the setup wizard later or configure everything manually in the Settings panel.
                  </p>
                </div>
                <div className="flex gap-4">
                  <Button variant="ghost" className="flex-1 !py-4" onClick={() => setShowSkipConfirm(false)}>Cancel</Button>
                  <Button className="flex-1 !py-4 !bg-red-600 !border-red-500 shadow-xl shadow-red-600/20" onClick={handleSkip}>Skip anyway</Button>
                </div>
              </div>
           </div>
        )}
      </div>
    </div>
  );
}




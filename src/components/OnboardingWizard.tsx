'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
    checkOnboardingStatus,
    skipOnboarding,
    saveGatewayConfig,
    saveAutoUpdateConfig,
    saveRegistriesConfig,
    saveEmailConfig,
    completeStackSetup,
    OnboardingStatus
} from '@/app/actions/onboarding';
import { generateLocalKey } from '@/app/actions/ssh';
import { fetchTemplates, fetchReadme, fetchTemplateYaml, fetchTemplateVariables, fetchTemplateConfigFiles } from '@/app/actions';
import { getNodes } from '@/app/actions/system';
import { Template, VariableMeta } from '@/lib/registry';
import Mustache from 'mustache';

import { Loader2, Monitor, Network, Key, CheckCircle, ArrowRight, SkipForward, RefreshCw, Box, Mail, Layers, Package, Globe, HardDrive } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

// Steps definition
type WizardStep = 'welcome' | 'gateway' | 'ssh' | 'updates' | 'registries' | 'email' | 'stacks' | 'finish';

interface ConfigFile {
  filename: string;
  content: string;
  targetPath?: string;
}

interface StackItem {
  name: string;
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

/** Wait for NPM to become reachable, polling up to maxWait ms */
async function waitForNpm(node: string | undefined, maxWait = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const query = node ? `?node=${node}` : '';
      const res = await fetch(`/api/system/nginx/status${query}`);
      if (res.ok) {
        const data = await res.json();
        if (data.installed && data.active) return true;
      }
    } catch { /* keep trying */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
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

export default function OnboardingWizard() {
  const [isOpen, setIsOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState<WizardStep>('welcome');
  const [stepHistory, setStepHistory] = useState<WizardStep[]>([]);
  
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);
  const { addToast } = useToast();
  const router = useRouter();

  // Selection Selection (Welcome Step)
  const [selection, setSelection] = useState({
    gateway: true,
    ssh: true,
    updates: false,
    registries: true,
    email: false,
    stacks: true
  });

  // Gateway Form
  const [gwHost, setGwHost] = useState('fritz.box');
  const [gwUser, setGwUser] = useState('');
  const [gwPass, setGwPass] = useState('');

  // Email Form
  const [emailConfig, setEmailConfig] = useState({
      host: '',
      port: 587,
      secure: false,
      user: '',
      pass: '',
      from: '',
      recipients: ''
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
  const [stackDeviceOptions, setStackDeviceOptions] = useState<Record<string, string[]>>({});
  const [stackLoadingDevices, setStackLoadingDevices] = useState(false);

  // RAID detection
  const [raidArrays, setRaidArrays] = useState<{ device: string; label: string; fstype: string; size: string; mountpoint: string | null; degraded: boolean }[]>([]);
  const [raidMounting, setRaidMounting] = useState(false);
  const [raidMounted, setRaidMounted] = useState(false);

  // Track whether we're in stacks-only mode (post-install first boot)
  const [stacksOnlyMode, setStacksOnlyMode] = useState(false);

  // NPM credentials (shown when default auth fails during proxy setup)
  const [npmCredPrompt, setNpmCredPrompt] = useState(false);
  const [npmEmail, setNpmEmail] = useState('admin@example.com');
  const [npmPassword, setNpmPassword] = useState('');

  useEffect(() => {
    checkOnboardingStatus().then(s => {
      setStatus(s);
      if (s.needsSetup) {
        setIsOpen(true);
        // Pre-fill selection based on detection/defaults
        setSelection(prev => ({
            ...prev,
            gateway: !s.features.gateway,
            ssh: !s.features.ssh,
            updates: !s.features.updates,
            registries: !s.features.registries,
            email: !s.features.email,
            stacks: true
        }));
      } else if (s.stackSetupPending) {
        // Setup was completed by installer, but stacks haven't been chosen yet
        setStacksOnlyMode(true);
        setCurrentStep('stacks');
        setIsOpen(true);
      }
    });
  }, []);

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
      // Calculate next step based on selection
      const order: WizardStep[] = ['welcome', 'gateway', 'ssh', 'updates', 'registries', 'email', 'stacks', 'finish'];

      // Determine which steps are active based on selection
      const activeSteps = order.filter(step => {
         if (step === 'welcome' || step === 'finish') return true;
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
    setIsOpen(false);
    router.refresh();
    addToast('success', 'Setup Complete', 'Welcome to ServiceBay!');
  };
  
  // -- Specific Save Handlers --

  const handleSaveGateway = () => saveAndNext(async () => {
     await saveGatewayConfig(gwHost, gwUser, gwPass);
     addToast('success', 'Gateway Saved');
  });

  const handleFinishSSH = () => {
     // SSH key generation is done inline, this just moves next
     handleNext();
  };

  const handleSaveUpdates = () => saveAndNext(async () => {
      await saveAutoUpdateConfig(true);
      addToast('success', 'Updates Enabled');
  });

  const handleSaveRegistries = () => saveAndNext(async () => {
      await saveRegistriesConfig(true);
      addToast('success', 'Registries Configured');
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

  // Fetch USB devices when node is selected and device-type variables exist
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
      const regex = /-\s*\[([ xX])\]\s*([\w\d_-]+)/;
      lines.forEach(line => {
        const match = line.match(regex);
        if (match) {
          const name = match[2].trim();
          const isInstalled = existing.has(name.toLowerCase());
          parsedItems.push({
            name,
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
        if (meta) Object.assign(allMeta, meta);

        // Fetch extra config files (.mustache) and resolve target paths from YAML volumes
        const cfgFiles = await fetchTemplateConfigFiles(item.name, selectedStack?.source || 'Built-in');
        if (cfgFiles.length > 0) {
          // Extract hostPath→mountPath mapping from YAML to resolve target path
          const volMounts = [...yaml.matchAll(/mountPath:\s*(\S+)/g)].map(m => m[1]);
          const hostPaths = [...yaml.matchAll(/path:\s*(\S+)/g)].map(m => m[1]);
          for (const cf of cfgFiles) {
            // Match config file to volume: e.g. /config mount → hostPath + filename
            const configMountIdx = volMounts.findIndex(m => m === '/config' || m.endsWith('/config'));
            if (configMountIdx !== -1 && hostPaths[configMountIdx]) {
              cf.targetPath = `${hostPaths[configMountIdx]}/${cf.filename}`;
            }
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
    const selected = stackItems.filter(i => i.checked);

    for (const item of selected) {
      // Skip already-installed services
      if (item.alreadyInstalled) {
        setStackLogs(prev => [...prev, `\u2705 ${item.name} already installed, skipping.`]);
        continue;
      }
      if (!item.yaml) continue;
      setStackLogs(prev => [...prev, `Installing ${item.name}...`]);

      const view = stackVariables.reduce((acc, v) => ({ ...acc, [v.name]: v.value }), {});
      // Disable HTML escaping for all Mustache renders (YAML + config files)
      const savedEscape = Mustache.escape;
      Mustache.escape = (text: string) => text;
      const content = Mustache.render(item.yaml, view);

      const kubeContent = `[Kube]\nYaml=${item.name}.yml\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target`;

      // Render extra config files (.mustache) with the same variables
      const extraFiles = (item.configFiles || [])
        .filter(cf => cf.targetPath)
        .map(cf => {
          const rendered = Mustache.render(cf.content, view);
          const resolvedPath = Mustache.render(cf.targetPath!, view);
          return { path: resolvedPath, content: rendered };
        });
      Mustache.escape = savedEscape;

      try {
        const query = stackSelectedNode ? `?node=${stackSelectedNode}&stream=1` : '?stream=1';
        const res = await fetch(`/api/services${query}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: item.name, kubeContent, yamlContent: content, yamlFileName: `${item.name}.yml`, extraFiles }),
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
                  // Update last progress line in-place to avoid log spam
                  if (lastProgressLine) {
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

        setStackLogs(prev => [...prev, `\u2705 ${item.name} installed successfully.`]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStackLogs(prev => [...prev, `\u274c Failed to install ${item.name}: ${msg}`]);
      }
    }

    // Seed LLDAP groups if lldap was installed
    if (selected.some(i => i.name === 'lldap')) {
      setStackLogs(prev => [...prev, 'Seeding LLDAP groups...']);
      const lldapPassword = stackVariables.find(v => v.name === 'LLDAP_ADMIN_PASSWORD')?.value;
      const lldapPort = stackVariables.find(v => v.name === 'LLDAP_PORT')?.value || '17170';
      if (lldapPassword) {
        try {
          const res = await fetch('/api/system/lldap/seed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              host: stackSelectedNode || 'localhost',
              port: parseInt(lldapPort, 10),
              password: lldapPassword,
            }),
          });
          const data = await res.json();
          if (res.ok) {
            if (data.created?.length) setStackLogs(prev => [...prev, `\u2705 Groups created: ${data.created.join(', ')}`]);
            if (data.existing?.length) setStackLogs(prev => [...prev, `\u2139\ufe0f Groups already exist: ${data.existing.join(', ')}`]);
            if (data.failed?.length) setStackLogs(prev => [...prev, `\u26a0\ufe0f Failed: ${data.failed.map((f: { name: string }) => f.name).join(', ')}`]);
          } else {
            setStackLogs(prev => [...prev, `\u26a0\ufe0f Could not seed LLDAP groups: ${data.error || 'unknown error'}`]);
          }
        } catch {
          setStackLogs(prev => [...prev, '\u26a0\ufe0f Could not reach LLDAP to seed groups. Create admins/family groups manually.']);
        }
      }
    }

    // Configure proxy routes (with retry for NPM startup)
    const proxyResult = await configureProxyRoutes();

    // If credentials are needed, stay on 'installing' step — the credential prompt is shown inline
    if (proxyResult !== 'needs_credentials') {
      setStackInstallStep('done');
    }
  };

  /** Build the proxy host list from subdomain variables */
  const buildProxyHosts = () => {
    const domain = stackVariables.find(v => v.name === 'PUBLIC_DOMAIN')?.value;
    if (!domain) return { domain, hosts: [] };
    const subdomainVars = stackVariables.filter(v => v.meta?.type === 'subdomain' && v.value);
    const hosts = subdomainVars.map(sv => {
      let port = sv.meta?.proxyPort || '';
      const portVar = stackVariables.find(v => v.name === port);
      if (portVar) port = portVar.value;
      const service = sv.name.replace(/_SUBDOMAIN$/, '').toLowerCase().replace(/^ha$/, 'home-assistant');
      return { domain: `${sv.value}.${domain}`, forwardPort: parseInt(port, 10), service, proxyConfig: sv.meta?.proxyConfig };
    }).filter(h => h.forwardPort);
    return { domain, hosts };
  };

  /** Send proxy host creation request, optionally with NPM credentials */
  const sendProxyRequest = async (
    hosts: { domain: string; forwardPort: number; service: string; proxyConfig?: unknown }[],
    domain: string,
    credentials?: { email: string; password: string },
  ) => {
    const res = await fetch('/api/system/nginx/proxy-hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hosts,
        publicDomain: domain,
        node: stackSelectedNode || undefined,
        ...(credentials ? { npmCredentials: credentials } : {}),
      }),
    });
    return { res, data: await res.json() };
  };

  /** Configure proxy routes, prompting for NPM credentials if default auth fails */
  const configureProxyRoutes = async (credentials?: { email: string; password: string }) => {
    const { domain, hosts } = buildProxyHosts();
    if (!domain || hosts.length === 0) return;

    if (!credentials) {
      setStackLogs(prev => [...prev, 'Waiting for Nginx Proxy Manager to start...']);
      const npmReady = await waitForNpm(stackSelectedNode || undefined);
      if (!npmReady) {
        setStackLogs(prev => [...prev, '\u26a0\ufe0f Nginx Proxy Manager not ready. Configure proxy routes manually in the NPM admin panel.']);
        return;
      }
      setStackLogs(prev => [...prev, 'Configuring reverse proxy routes...']);
    }

    try {
      const { res, data } = await sendProxyRequest(hosts, domain, credentials);
      if (res.ok && data.created?.length) {
        setStackLogs(prev => [...prev, `\u2705 Proxy routes created: ${data.created.join(', ')}`]);
        if (data.failed?.length) {
          setStackLogs(prev => [...prev, `\u26a0\ufe0f Some routes failed: ${data.failed.map((f: { domain: string }) => f.domain).join(', ')}`]);
        }
        setNpmCredPrompt(false);
      } else if (res.status === 401 && data.needsCredentials) {
        // Default & stored credentials failed — prompt user
        setStackLogs(prev => [...prev, '\u26a0\ufe0f NPM default credentials did not work. Please enter your NPM admin credentials below.']);
        setNpmCredPrompt(true);
        // Don't proceed to 'done' yet — wait for user to submit credentials
        return 'needs_credentials';
      } else {
        setStackLogs(prev => [...prev, `\u26a0\ufe0f Proxy route error: ${data.error || 'unknown'}`]);
      }
    } catch {
      setStackLogs(prev => [...prev, '\u26a0\ufe0f Could not reach Nginx Proxy Manager.']);
    }
  };

  /** Retry proxy route creation with user-provided NPM credentials */
  const handleNpmCredentialSubmit = async () => {
    if (!npmEmail || !npmPassword) return;
    setNpmCredPrompt(false);
    setStackLogs(prev => [...prev, 'Retrying with provided credentials...']);
    const result = await configureProxyRoutes({ email: npmEmail, password: npmPassword });
    if (result === 'needs_credentials') {
      // Still failed — prompt again
      setStackLogs(prev => [...prev, '\u274c Authentication failed. Please check your credentials.']);
      setNpmCredPrompt(true);
    } else {
      setStackInstallStep('done');
    }
  };

  const handleStackSkip = async () => {
    if (stacksOnlyMode) {
      // In stacks-only mode, skipping goes straight to finish
      await completeStackSetup();
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
           </h2>
           {!stacksOnlyMode && (() => {
             const order: WizardStep[] = ['welcome', 'gateway', 'ssh', 'updates', 'registries', 'email', 'stacks', 'finish'];
             const activeSteps = order.filter(step => {
               if (step === 'welcome' || step === 'finish') return true;
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
            {currentStep === 'welcome' && (
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

            {currentStep === 'gateway' && (
                <div className="space-y-4">
                     <h3 className="font-semibold text-lg flex items-center gap-2"><Network className="w-5 h-5 text-purple-500"/> Internet Gateway</h3>
                     <p className="text-sm text-gray-500">
                        Enter your FRITZ!Box details to enable network scanning.
                     </p>
                     
                     <div className="space-y-3 pt-2">
                        <Input label="Hostname / IP" value={gwHost} onChange={setGwHost} placeholder="fritz.box" />
                        <Input label="Username" value={gwUser} onChange={setGwUser} placeholder="admin" />
                        <Input label="Password" type="password" value={gwPass} onChange={setGwPass} />
                     </div>
                </div>
            )}

            {currentStep === 'ssh' && (
                <div className="space-y-4">
                    <h3 className="font-semibold text-lg flex items-center gap-2"><Key className="w-5 h-5 text-amber-500"/> SSH Configuration</h3>
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                        {status?.hasSshKey 
                          ? "We found an existing SSH key. You are good to go!" 
                          : "No SSH key found. Generate one now to enable management."}
                    </p>
                    
                    {!status?.hasSshKey && (
                        <div className="pt-2">
                             <Button onClick={handleGenerateKey} disabled={loading} className="w-full justify-center">
                                {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Key className="w-4 h-4 mr-2" />}
                                Generate SSH Key
                             </Button>
                        </div>
                    )}
                </div>
            )}

            {currentStep === 'updates' && (
                 <div className="space-y-4">
                    <h3 className="font-semibold text-lg flex items-center gap-2"><RefreshCw className="w-5 h-5 text-green-500"/> Auto Updates</h3>
                    <p className="text-gray-600 dark:text-gray-300 text-sm">
                        Enable automatic updates for ServiceBay and your containers.
                        This will check for updates daily at midnight.
                    </p>
                    <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg text-sm text-blue-800 dark:text-blue-200">
                        <p className="font-medium">Podman Quadlets</p>
                        Your containers will be updated using <code>AutoUpdate=registry</code> mode.
                    </div>
                 </div>
            )}

            {currentStep === 'registries' && (
                 <div className="space-y-4">
                    <h3 className="font-semibold text-lg flex items-center gap-2"><Box className="w-5 h-5 text-blue-500"/> Template Registries</h3>
                    <p className="text-gray-600 dark:text-gray-300 text-sm">
                        Enable the default ServiceBay template registry to install popular applications like Nginx, Redis, and more.
                    </p>
                     <div className="bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700 text-sm font-mono text-gray-600 dark:text-gray-400">
                        https://github.com/mdopp/servicebay-templates
                    </div>
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
                            <p className="text-sm text-gray-500 mb-2">Select which services to install from <span className="font-medium">{selectedStack?.name}</span>:</p>
                            {stacksLoading ? (
                                <div className="flex items-center justify-center py-4 text-gray-400">
                                    <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {stackItems.map((item, i) => (
                                        <label key={item.name} className={`flex items-center gap-3 p-3 border rounded transition-colors ${
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
                                                    setStackItems(newItems);
                                                }}
                                                className="w-5 h-5 text-blue-600 rounded focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600"
                                            />
                                            <span className={`font-medium text-sm ${item.alreadyInstalled ? 'text-gray-400' : 'text-gray-900 dark:text-gray-200'}`}>{item.name}</span>
                                            {item.alreadyInstalled && (
                                                <span className="text-xs text-green-600 dark:text-green-400 ml-auto">already installed</span>
                                            )}
                                        </label>
                                    ))}
                                </div>
                            )}

                            {/* Domain prompt — shown here before configure step */}
                            {stackItems.some(i => i.checked && !i.alreadyInstalled) && (
                                <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                                    <label className="flex items-center gap-2 text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">
                                        <Globe className="w-4 h-4" /> Public Domain
                                    </label>
                                    <p className="text-xs text-blue-600 dark:text-blue-400 mb-2">
                                        Your services will be accessible as subdomains of this domain (e.g. photos.yourdomain.com).
                                    </p>
                                    <input
                                        type="text"
                                        value={stackDomain}
                                        onChange={(e) => setStackDomain(e.target.value)}
                                        className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-blue-300 dark:border-blue-700 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                                        placeholder="example.com"
                                    />
                                </div>
                            )}

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
                            {stacksLoading ? (
                                <div className="flex items-center justify-center py-4 text-gray-400">
                                    <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading variables...
                                </div>
                            ) : stackVariables.filter(v => !v.global && v.meta?.type !== 'secret').length === 0 ? (
                                <div className="p-3 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 rounded text-sm">
                                    No configuration needed. Ready to install.
                                </div>
                            ) : (
                                <div className="space-y-3 max-h-[50vh] overflow-y-auto">
                                    {stackVariables.filter(v => !v.global && v.meta?.type !== 'secret').map((v) => {
                                        const idx = stackVariables.findIndex(x => x.name === v.name);
                                        return (
                                            <div key={v.name}>
                                                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">{v.name}</label>
                                                {v.meta?.description && <p className="text-xs text-gray-500 mb-1">{v.meta.description}</p>}
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
                                                        <input type="text" value={v.value} readOnly className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-700 rounded-md text-xs font-mono flex-1" />
                                                        <button type="button" onClick={() => { const nv = [...stackVariables]; nv[idx].value = generateSecret(); setStackVariables(nv); }} className="p-2 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-gray-700"><RefreshCw size={14} /></button>
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
                            )}
                        </>
                    )}

                    {(stackInstallStep === 'installing' || stackInstallStep === 'done') && (
                        <div>
                            <div className="bg-gray-900 text-gray-100 p-4 rounded-md font-mono text-xs h-32 overflow-y-auto border border-gray-800">
                                {stackLogs.map((log, i) => <div key={i} className="mb-1">{log}</div>)}
                                {stackInstallStep === 'installing' && (
                                    <div className="flex items-center gap-2 text-gray-400 mt-2">
                                        <Loader2 size={14} className="animate-spin" /> Processing...
                                    </div>
                                )}
                            </div>
                            {npmCredPrompt && (
                                <div className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
                                    <p className="text-sm font-medium text-amber-800 dark:text-amber-200 mb-2">NPM Admin Login</p>
                                    <p className="text-xs text-amber-700 dark:text-amber-300 mb-3">
                                        The default NPM password was changed. Enter your NPM admin credentials to configure proxy routes.
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
                                            type="password"
                                            value={npmPassword}
                                            onChange={(e) => setNpmPassword(e.target.value)}
                                            className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-amber-300 dark:border-amber-700 rounded-md text-sm"
                                            placeholder="NPM admin password"
                                            autoComplete="current-password"
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
                                return (
                                    <div className="mt-3 space-y-2 max-h-48 overflow-y-auto">
                                        {hasProxyRoutes ? (
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
                                        ) : (
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
                <Button onClick={handleNext}>
                    Next <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
            )}

            {/* Step specific primary actions */}
            {currentStep === 'gateway' && <Button onClick={handleSaveGateway} disabled={loading}>{loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save & Next</Button>}
            {currentStep === 'ssh' && <Button onClick={handleFinishSSH}>Continue <ArrowRight className="w-4 h-4 ml-2"/></Button>}
            {currentStep === 'updates' && <Button onClick={handleSaveUpdates} disabled={loading}>{loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Enable Updates</Button>}
            {currentStep === 'registries' && <Button onClick={handleSaveRegistries} disabled={loading}>{loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Enable Registry</Button>}
            {currentStep === 'email' && <Button onClick={handleSaveEmail} disabled={loading}>{loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save Email</Button>}

            {currentStep === 'stacks' && stackInstallStep === 'select' && (
                <Button onClick={handleStackSkip}>Skip <ArrowRight className="w-4 h-4 ml-2" /></Button>
            )}
            {currentStep === 'stacks' && stackInstallStep === 'services' && (
                <div className="flex gap-2">
                    <button onClick={() => { setStackInstallStep('select'); setSelectedStack(null); }} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Back</button>
                    <Button onClick={handleStackFetchVars} disabled={stackItems.filter(i => i.checked).length === 0 || stacksLoading}>
                        {stacksLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} Continue
                    </Button>
                </div>
            )}
            {currentStep === 'stacks' && stackInstallStep === 'configure' && (
                <div className="flex gap-2">
                    <button onClick={() => setStackInstallStep('services')} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Back</button>
                    <Button onClick={handleStackInstall} disabled={!stackSelectedNode && stackNodes.length > 1}>
                        Install Stack
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


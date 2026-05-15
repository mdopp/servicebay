'use client';

import { useState, useEffect, useCallback } from 'react';
import { Template } from '@/lib/registry';
import { useStackInstall } from '@/lib/stackInstall/useStackInstall';
import { getNodes } from '@/app/actions/system';
import { PodmanConnection } from '@/lib/nodes';
import { Layers, Folder, X } from 'lucide-react';
import TemplateUpgradeBanner from './TemplateUpgradeBanner';
import StackInstallFlow from './StackInstallFlow';
import { useRouter } from 'next/navigation';

/**
 * Registry-side install entry point. Used when an operator clicks a stack
 * tile on /registry post-onboarding. Owns the modal chrome + the stack/
 * template select step; everything from configure onwards is delegated to
 * the shared `useStackInstall` engine and rendered by `<StackInstallFlow>`.
 *
 * History: pre-#341 phase-2-step-2 this component carried its own ~830-line
 * copy of the install pipeline. Both that copy and the wizard's copy kept
 * drifting on auto-fill rules, Mustache section-tag handling, OIDC client
 * registration, and post-deploy.py support. The shared engine fixes those
 * once.
 */
interface InstallerModalProps {
  template: Template;
  readme: string;
  isOpen: boolean;
  onClose: () => void;
}

interface SelectItem {
  name: string;
  checked: boolean;
  /** Marks a service that's already deployed. Carried through to the
   *  install runner's topo-sort as a dependency satisfier so a
   *  single-template re-deploy (banner upgrade button) doesn't get
   *  rejected for "depends on nginx, auth, which are not selected". */
  alreadyInstalled?: boolean;
}

export default function InstallerModal({ template, readme, isOpen, onClose }: InstallerModalProps) {
  const router = useRouter();
  const controller = useStackInstall({ templateSource: template.source });
  const [selectItems, setSelectItems] = useState<SelectItem[]>([]);
  const [nodes, setNodes] = useState<PodmanConnection[]>([]);
  const [selectedNode, setSelectedNode] = useState('');
  const [deviceOptions, setDeviceOptions] = useState<Record<string, string[]>>({});
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [advancing, setAdvancing] = useState(false);

  // Per-template ready-to-install state, tracked by TemplateUpgradeBanner
  // for any item that has a pending breaking-change banner. See #353 / #354.
  const [upgradeReady, setUpgradeReady] = useState<Record<string, boolean | undefined>>({});
  const reportUpgradeReady = useCallback((name: string, ready: boolean | undefined) => {
    setUpgradeReady(prev => (prev[name] === ready ? prev : { ...prev, [name]: ready }));
  }, []);
  const checkedItems = selectItems.filter(i => i.checked);
  const allUpgradesReady = checkedItems.length > 0 && checkedItems.every(i => upgradeReady[i.name] === true);

  useEffect(() => {
    getNodes().then(ns => {
      setNodes(ns);
      // Single-node installs: the picker in StackInstallFlow hides itself
      // when nodes.length <= 1, so without this the Install button would
      // stay disabled forever (selectedNode never gets set).
      if (ns.length === 1) setSelectedNode(ns[0].Name);
    });
  }, []);

  // Reset state when re-opening (modal persists in the DOM between opens).
  useEffect(() => {
    if (!isOpen) return;
    controller.reset();
    setDeviceOptions({});

    let cancelled = false;
    void (async () => {
      // Existing services seed `alreadyInstalled` so the runner's
      // dependency topo-sort recognises pre-deployed services like
      // nginx and auth as satisfiers.
      let existing = new Set<string>();
      try {
        const res = await fetch('/api/services');
        if (res.ok) {
          const services: { name?: string }[] = await res.json();
          existing = new Set(
            services
              .map(s => s.name?.toLowerCase())
              .filter((n): n is string => !!n),
          );
        }
      } catch { /* best-effort */ }
      if (cancelled) return;

      if (template.type === 'stack') {
        const parsed: SelectItem[] = [];
        const regex = /-\s*\[([ xX])\]\s*([\w\d_-]+)/;
        for (const line of readme.split('\n')) {
          const match = line.match(regex);
          if (match) {
            parsed.push({ name: match[2].trim(), checked: match[1].toLowerCase() === 'x' });
          }
        }
        setSelectItems(parsed);
      } else {
        const targetLower = template.name.toLowerCase();
        const items: SelectItem[] = [{ name: template.name, checked: true }];
        for (const name of existing) {
          if (name !== targetLower) {
            items.push({ name, checked: false, alreadyInstalled: true });
          }
        }
        setSelectItems(items);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, template, readme]);

  // Fetch devices when node is selected and there are device-type variables.
  useEffect(() => {
    if (!selectedNode) return;
    const deviceVars = controller.variables.filter(v => v.meta?.type === 'device');
    if (deviceVars.length === 0) return;
    const paths = new Set(deviceVars.map(v => v.meta?.devicePath || '/dev/serial/by-id'));
    setLoadingDevices(true);
    Promise.all(
      Array.from(paths).map(async (devicePath) => {
        try {
          const res = await fetch(`/api/system/devices?node=${selectedNode}&path=${encodeURIComponent(devicePath)}`);
          if (res.ok) {
            const data = await res.json();
            return { path: devicePath, devices: data.devices as string[] };
          }
        } catch { /* ignore */ }
        return { path: devicePath, devices: [] as string[] };
      }),
    ).then(results => {
      const opts: Record<string, string[]> = {};
      for (const r of results) opts[r.path] = r.devices;
      setDeviceOptions(opts);
      setLoadingDevices(false);
    });
  }, [selectedNode, controller.variables]);

  const handleToggle = (idx: number) => {
    setSelectItems(prev => prev.map((item, i) => (i === idx ? { ...item, checked: !item.checked } : item)));
  };

  const advanceToConfigure = async () => {
    setAdvancing(true);
    try {
      await controller.startConfigure(
        selectItems
          .filter(i => i.checked || i.alreadyInstalled)
          .map(i => ({ name: i.name, checked: i.checked, alreadyInstalled: i.alreadyInstalled })),
        {},
      );
    } finally {
      setAdvancing(false);
    }
  };

  // Auto-advance single-template installs past the select step — there's
  // nothing to choose between when only one service exists.
  useEffect(() => {
    if (isOpen && template.type === 'template' && selectItems.length > 0 && controller.phase === 'idle' && !advancing) {
      void advanceToConfigure();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectItems, isOpen, template, controller.phase]);

  if (!isOpen) return null;

  const phase = controller.phase;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">
        <div className="p-6 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center">
          <h3 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            {template.type === 'stack'
              ? <Layers className="text-purple-600 dark:text-purple-400" />
              : <Folder className="text-blue-600 dark:text-blue-400" />}
            Install {template.type === 'stack' ? 'Stack' : 'Template'}: {template.name}
          </h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1">
          {(phase === 'idle' || (phase === 'configure' && selectItems.length === 0)) && template.type === 'stack' && (
            <div>
              {selectItems.length === 0 ? (
                <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-200 rounded border border-yellow-200 dark:border-yellow-800">
                  No service definitions found in this stack&apos;s README.
                  <br/>
                  <small>Expected format: <code>- [x] service-name</code></small>
                </div>
              ) : (
                <>
                  <p className="mb-4 text-gray-600 dark:text-gray-400">Select the services you want to include:</p>
                  <div className="space-y-2 mb-6">
                    {selectItems.map((item, i) => (
                      <label key={item.name} className="flex items-center gap-3 p-3 border border-gray-200 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors">
                        <input
                          type="checkbox"
                          checked={item.checked}
                          onChange={() => handleToggle(i)}
                          className="w-5 h-5 text-blue-600 rounded focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600"
                        />
                        <span className="font-medium text-gray-900 dark:text-gray-200">{item.name}</span>
                      </label>
                    ))}
                  </div>
                  {checkedItems.map(item => (
                    <TemplateUpgradeBanner
                      key={item.name}
                      templateName={item.name}
                      source={template.source}
                      onReadyToInstall={ready => reportUpgradeReady(item.name, ready)}
                    />
                  ))}
                </>
              )}
            </div>
          )}

          {(phase === 'configure' || phase === 'installing' || phase === 'done' || phase === 'error') && (
            <StackInstallFlow
              controller={controller}
              nodes={nodes}
              selectedNode={selectedNode}
              onSelectNode={setSelectedNode}
              allowCleanInstall={template.type === 'stack'}
              deviceContext={{
                deviceOptions,
                loadingDevices,
                canRefresh: !!selectedNode,
                onRefresh: (devPath) => {
                  setLoadingDevices(true);
                  fetch(`/api/system/devices?node=${selectedNode}&path=${encodeURIComponent(devPath)}`)
                    .then(r => r.json())
                    .then(data => {
                      setDeviceOptions(prev => ({ ...prev, [devPath]: data.devices || [] }));
                      setLoadingDevices(false);
                    })
                    .catch(() => setLoadingDevices(false));
                },
              }}
              doneFooter={(() => {
                const domain = controller.variables.find(v => v.name === 'PUBLIC_DOMAIN')?.value;
                // Only public-exposure subdomains need a public A record. LAN-only
                // ones (e.g. Z-Wave JS admin UI) resolve via AdGuard on `.home.arpa`
                // and would mislead the operator into creating unwanted public records.
                const subdomains = controller.variables.filter(
                  v => v.meta?.type === 'subdomain' && v.value && v.meta?.exposure === 'public',
                );
                if (!domain || subdomains.length === 0) return null;
                return (
                  <div className="space-y-3">
                    <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded border border-blue-200 dark:border-blue-800 text-sm space-y-2">
                      <p className="font-medium text-blue-800 dark:text-blue-200">1. Configure DNS</p>
                      <p className="text-blue-700 dark:text-blue-300">
                        Point these domains to your server IP:
                      </p>
                      <div className="font-mono text-xs text-blue-600 dark:text-blue-400 space-y-0.5">
                        {subdomains.map(sv => (
                          <div key={sv.name}>{sv.value}.{domain}</div>
                        ))}
                      </div>
                    </div>
                    <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded border border-amber-200 dark:border-amber-800 text-sm space-y-2">
                      <p className="font-medium text-amber-800 dark:text-amber-200">2. SSL Certificates</p>
                      <p className="text-amber-700 dark:text-amber-300">
                        Open Nginx Proxy Manager and add Let&apos;s Encrypt SSL certificates for each proxy host.
                      </p>
                    </div>
                    <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 text-sm space-y-2">
                      <p className="font-medium text-gray-800 dark:text-gray-200">3. Access Restrictions (optional)</p>
                      <p className="text-gray-600 dark:text-gray-400">
                        Add IP-based access lists in NPM for admin-only services (Nginx Admin, AdGuard).
                      </p>
                    </div>
                  </div>
                );
              })()}
            />
          )}
        </div>

        <div className="p-6 border-t border-gray-200 dark:border-gray-800 flex justify-end gap-3 bg-gray-50 dark:bg-gray-900/50 rounded-b-lg">
          {phase === 'idle' && template.type === 'stack' && (
            <>
              <button onClick={onClose} className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 rounded transition-colors">Cancel</button>
              <button
                onClick={() => { void advanceToConfigure(); }}
                disabled={!allUpgradesReady || advancing}
                title={!allUpgradesReady && checkedItems.length > 0 ? 'Acknowledge the breaking-change banner(s) above to continue.' : undefined}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
              >
                Continue
              </button>
            </>
          )}
          {phase === 'configure' && (
            <>
              <button
                onClick={() => template.type === 'stack' ? controller.reset() : onClose()}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 rounded transition-colors"
              >
                {template.type === 'stack' ? 'Back' : 'Cancel'}
              </button>
              <button
                onClick={() => { void controller.runInstall({ node: selectedNode }); }}
                disabled={!selectedNode || (controller.cleanInstall && controller.cleanInstallConfirm !== 'RESET')}
                className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {controller.cleanInstall ? 'Reset & Install' : 'Install'}
              </button>
            </>
          )}
          {phase === 'installing' && (
            <button disabled className="px-4 py-2 bg-gray-400 text-white rounded cursor-not-allowed">Installing...</button>
          )}
          {phase === 'done' && (
            <button
              onClick={() => { onClose(); router.push('/'); }}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 font-medium transition-colors"
            >
              Go to Dashboard
            </button>
          )}
          {phase === 'error' && (
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700 font-medium transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

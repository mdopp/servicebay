'use client';

import { useState, useEffect } from 'react';
import { Template, VariableMeta } from '@/lib/registry';
import { fetchTemplateYaml, fetchTemplateVariables } from '@/app/actions';
import { getNodes } from '@/app/actions/system';
import { PodmanConnection } from '@/lib/nodes';
import { Layers, Loader2, AlertCircle, X, Folder, Server, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Mustache from 'mustache';

interface InstallerModalProps {
  template: Template;
  readme: string;
  isOpen: boolean;
  onClose: () => void;
}

interface StackItem {
  name: string;
  checked: boolean;
  yaml?: string;
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

export default function InstallerModal({ template, readme, isOpen, onClose }: InstallerModalProps) {
  const router = useRouter();
  const [step, setStep] = useState<'select' | 'configure' | 'installing' | 'done'>('select');
  const [items, setItems] = useState<StackItem[]>([]);
  const [variables, setVariables] = useState<Variable[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<PodmanConnection[]>([]);
  const [selectedNode, setSelectedNode] = useState('');
  const [deviceOptions, setDeviceOptions] = useState<Record<string, string[]>>({});
  const [loadingDevices, setLoadingDevices] = useState(false);

  useEffect(() => {
    getNodes().then(setNodes);
  }, []);

  // Initialize items based on type
  useEffect(() => {
    if (!isOpen) return;

    // Reset state when opening
    setStep('select');
    setVariables([]);
    setLogs([]);
    setError(null);
    setDeviceOptions({});

    if (template.type === 'stack') {
        const lines = readme.split('\n');
        const parsedItems: StackItem[] = [];
        const regex = /-\s*\[([ xX])\]\s*([\w\d_-]+)/;

        lines.forEach(line => {
            const match = line.match(regex);
            if (match) {
                parsedItems.push({
                    name: match[2].trim(),
                    checked: match[1].toLowerCase() === 'x'
                });
            }
        });
        setItems(parsedItems);
    } else {
        // Single template
        setItems([{ name: template.name, checked: true }]);
    }
  }, [isOpen, template, readme]);

  // Auto-advance for single templates
  useEffect(() => {
    if (isOpen && template.type === 'template' && items.length > 0 && step === 'select') {
        fetchYamlsAndExtractVars();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, isOpen, template, step]);

  // Fetch devices when node is selected and there are device-type variables
  useEffect(() => {
    if (!selectedNode) return;
    const deviceVars = variables.filter(v => v.meta?.type === 'device');
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
      })
    ).then(results => {
      const opts: Record<string, string[]> = {};
      for (const r of results) opts[r.path] = r.devices;
      setDeviceOptions(opts);
      setLoadingDevices(false);
    });
  }, [selectedNode, variables]);


  const handleToggle = (index: number) => {
    const newItems = [...items];
    newItems[index].checked = !newItems[index].checked;
    setItems(newItems);
  };

  const fetchYamlsAndExtractVars = async () => {
    setStep('configure');
    setError(null);
    const selectedItems = items.filter(i => i.checked);
    const vars = new Set<string>();
    const newItems = [...items];
    const allMeta: Record<string, VariableMeta> = {};

    // Fetch global template settings (DATA_DIR, etc.)
    let globalSettings: Record<string, string> = {};
    try {
        const settingsRes = await fetch('/api/settings');
        if (settingsRes.ok) {
            const settings = await settingsRes.json();
            globalSettings = settings.templateSettings || {};
        }
    } catch { /* use empty defaults */ }

    for (const item of selectedItems) {
        try {
            const yaml = await fetchTemplateYaml(item.name, template.source);
            if (!yaml) {
                throw new Error(`Could not fetch template for ${item.name}`);
            }

            const idx = newItems.findIndex(i => i.name === item.name);
            if (idx !== -1) newItems[idx].yaml = yaml;

            const matches = yaml.matchAll(/\{\{\s*([\w\d_]+)\s*\}\}/g);
            for (const match of matches) {
                vars.add(match[1]);
            }

            // Fetch variable metadata
            const meta = await fetchTemplateVariables(item.name, template.source);
            if (meta) Object.assign(allMeta, meta);

        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
            return;
        }
    }

    setItems(newItems);
    setVariables(Array.from(vars).map(v => {
        const meta = allMeta[v];
        let value = globalSettings[v] || '';
        // Auto-fill defaults from metadata
        if (!value && meta?.default) value = meta.default;
        // Auto-generate secrets
        if (!value && meta?.type === 'secret') value = generateSecret();
        return {
            name: v,
            value,
            global: !!globalSettings[v],
            meta,
        };
    }));
  };

  const handleInstall = async () => {
    setStep('installing');
    setLogs([]);
    const selectedItems = items.filter(i => i.checked);

    for (const item of selectedItems) {
        if (!item.yaml) continue;

        setLogs(prev => [...prev, `Installing ${item.name}...`]);

        const view = variables.reduce((acc, v) => ({ ...acc, [v.name]: v.value }), {});
        // Disable HTML escaping — we're rendering YAML, not HTML
        const savedEscape = Mustache.escape;
        Mustache.escape = (text: string) => text;
        const content = Mustache.render(item.yaml, view);
        Mustache.escape = savedEscape;

        const kubeContent = `[Kube]
Yaml=${item.name}.yml
AutoUpdate=registry

[Install]
WantedBy=default.target`;

        try {
            const query = selectedNode ? `?node=${selectedNode}` : '';
            const res = await fetch(`/api/services${query}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: item.name,
                    kubeContent,
                    yamlContent: content,
                    yamlFileName: `${item.name}.yml`
                }),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Unknown error');
            }
            setLogs(prev => [...prev, `✅ ${item.name} installed successfully.`]);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setLogs(prev => [...prev, `❌ Failed to install ${item.name}: ${msg}`]);
        }
    }
    setStep('done');
  };

  const renderVariableInput = (v: Variable, idx: number) => {
    const update = (value: string) => {
      const newVars = [...variables];
      newVars[idx].value = value;
      setVariables(newVars);
    };

    const inputClass = "w-full p-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded focus:ring-2 focus:ring-blue-500";

    // Select dropdown
    if (v.meta?.type === 'select' && v.meta.options) {
      return (
        <select value={v.value} onChange={(e) => update(e.target.value)} className={inputClass + " appearance-none"}>
          <option value="" disabled>Select...</option>
          {v.meta.options.map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      );
    }

    // Device selector
    if (v.meta?.type === 'device') {
      const devPath = v.meta.devicePath || '/dev/serial/by-id';
      const devices = deviceOptions[devPath] || [];
      return (
        <div className="flex gap-2">
          <select value={v.value} onChange={(e) => update(e.target.value)} className={inputClass + " appearance-none flex-1"}>
            <option value="" disabled>{loadingDevices ? 'Loading devices...' : !selectedNode ? 'Select a node first' : devices.length === 0 ? 'No devices found' : 'Select device...'}</option>
            {devices.map(dev => (
              <option key={dev} value={dev}>{dev.replace(`${devPath}/`, '')}</option>
            ))}
          </select>
          {selectedNode && (
            <button
              type="button"
              onClick={() => {
                setLoadingDevices(true);
                fetch(`/api/system/devices?node=${selectedNode}&path=${encodeURIComponent(devPath)}`)
                  .then(r => r.json())
                  .then(data => {
                    setDeviceOptions(prev => ({ ...prev, [devPath]: data.devices || [] }));
                    setLoadingDevices(false);
                  })
                  .catch(() => setLoadingDevices(false));
              }}
              className="p-2 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              title="Refresh device list"
            >
              <RefreshCw size={16} className={loadingDevices ? 'animate-spin' : ''} />
            </button>
          )}
        </div>
      );
    }

    // Password field
    if (v.meta?.type === 'password') {
      return (
        <input
          type="password"
          value={v.value}
          onChange={(e) => update(e.target.value)}
          className={inputClass}
          placeholder={`Enter ${v.name.toLowerCase().replace(/_/g, ' ')}`}
          autoComplete="new-password"
        />
      );
    }

    // Secret (auto-generated, shown read-only with regenerate button)
    if (v.meta?.type === 'secret') {
      return (
        <div className="flex gap-2">
          <input
            type="text"
            value={v.value}
            readOnly
            className={inputClass + " font-mono text-xs bg-gray-50 dark:bg-gray-800/50 flex-1"}
          />
          <button
            type="button"
            onClick={() => update(generateSecret())}
            className="p-2 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title="Regenerate secret"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      );
    }

    // Default: text input
    return (
      <input
        type="text"
        value={v.value}
        onChange={(e) => update(e.target.value)}
        className={inputClass}
        placeholder={v.meta?.default ? `Default: ${v.meta.default}` : `Value for ${v.name}`}
      />
    );
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">

            {/* Header */}
            <div className="p-6 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center">
                <h3 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                    {template.type === 'stack' ? <Layers className="text-purple-600 dark:text-purple-400" /> : <Folder className="text-blue-600 dark:text-blue-400" />}
                    Install {template.type === 'stack' ? 'Stack' : 'Template'}: {template.name}
                </h3>
                <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                    <X size={24} />
                </button>
            </div>

            {/* Content */}
            <div className="p-6 overflow-y-auto flex-1">
                {step === 'select' && (
                    <div>
                        {items.length === 0 ? (
                             <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-200 rounded border border-yellow-200 dark:border-yellow-800">
                                No service definitions found in this stack&apos;s README.
                                <br/>
                                <small>Expected format: <code>- [x] service-name</code></small>
                            </div>
                        ) : (
                            <>
                                <p className="mb-4 text-gray-600 dark:text-gray-400">Select the services you want to include:</p>
                                <div className="space-y-2 mb-6">
                                    {items.map((item, i) => (
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
                            </>
                        )}
                    </div>
                )}

                {step === 'configure' && (
                    <div>
                        <div className="mb-6">
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Target Node</label>
                            <div className="relative">
                                <select
                                    value={selectedNode}
                                    onChange={(e) => setSelectedNode(e.target.value)}
                                    className="w-full p-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded focus:ring-2 focus:ring-blue-500 appearance-none"
                                >
                                    <option value="" disabled>Select a node</option>
                                    {nodes.map(n => (
                                        <option key={n.Name} value={n.Name}>{n.Name} ({n.URI})</option>
                                    ))}
                                </select>
                                <Server className="absolute right-3 top-2.5 text-gray-400 pointer-events-none" size={16} />
                            </div>
                        </div>

                        {variables.length > 0 ? (
                            <div className="space-y-4 mb-6">
                                {/* Global settings (read-only, from Settings > Template Settings) */}
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

                                {/* User-configurable variables */}
                                {variables.filter(v => !v.global).length > 0 && (
                                    <div>
                                        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Configure</p>
                                        <div className="grid gap-4">
                                            {variables.filter(v => !v.global).map((v) => {
                                                const idx = variables.findIndex(x => x.name === v.name);
                                                return (
                                                <div key={v.name}>
                                                    <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">{v.name}</label>
                                                    {v.meta?.description && (
                                                        <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">{v.meta.description}</p>
                                                    )}
                                                    {renderVariableInput(v, idx)}
                                                </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="p-4 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 rounded mb-6">
                                No variables found. You can proceed.
                            </div>
                        )}

                        {error && (
                            <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-200 rounded flex items-center gap-2">
                                <AlertCircle size={18} /> {error}
                            </div>
                        )}
                    </div>
                )}

                {(step === 'installing' || step === 'done') && (
                    <div>
                        <div className="bg-gray-900 text-gray-100 p-4 rounded-md font-mono text-sm h-64 overflow-y-auto mb-4 border border-gray-800">
                            {logs.map((log, i) => (
                                <div key={i} className="mb-1">{log}</div>
                            ))}
                            {step === 'installing' && (
                                <div className="flex items-center gap-2 text-gray-400 mt-2">
                                    <Loader2 size={14} className="animate-spin" /> Processing...
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-gray-200 dark:border-gray-800 flex justify-end gap-3 bg-gray-50 dark:bg-gray-900/50 rounded-b-lg">
                {step === 'select' && (
                    <>
                        <button onClick={onClose} className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 rounded transition-colors">Cancel</button>
                        <button
                            onClick={fetchYamlsAndExtractVars}
                            disabled={items.filter(i => i.checked).length === 0}
                            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 font-medium transition-colors"
                        >
                            Continue
                        </button>
                    </>
                )}
                {step === 'configure' && (
                    <>
                        <button
                            onClick={() => template.type === 'stack' ? setStep('select') : onClose()}
                            className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 rounded transition-colors"
                        >
                            {template.type === 'stack' ? 'Back' : 'Cancel'}
                        </button>
                        <button
                            onClick={handleInstall}
                            disabled={!selectedNode}
                            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Install
                        </button>
                    </>
                )}
                {step === 'installing' && (
                    <button disabled className="px-4 py-2 bg-gray-400 text-white rounded cursor-not-allowed">Installing...</button>
                )}
                {step === 'done' && (
                    <button
                        onClick={() => {
                            onClose();
                            router.push('/');
                        }}
                        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 font-medium transition-colors"
                    >
                        Go to Dashboard
                    </button>
                )}
            </div>
        </div>
    </div>
  );
}
